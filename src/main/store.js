'use strict';
// Session manager: opens (decrypts) the database at login and closes it at logout / auto-lock.
// While nobody is logged in the data exists only as an encrypted file on disk.

const fs = require('fs');
const { Database, validateDbFile } = require('./db');
const { Service, AppError } = require('./service');
const { Vault, isEncrypted, isPlainSqlite } = require('./vault');
const { Config } = require('./config');
const { BackupManager } = require('./backup');

const LEGACY_SETTINGS = ['lang', 'org_name', 'backup_keep', 'backup_extra_dir', 'auto_lock_minutes', 'last_backup'];

class Store {
  constructor({ dbFile, backupDir, configFile }) {
    this.dbFile = dbFile;
    this.config = new Config(configFile);
    this.db = null;
    this.service = null;
    this.vault = null;
    this.backups = new BackupManager(dbFile, backupDir, this.config, () => (this.db && this.db.isOpen ? this.db.fileBytes() : null));
  }

  // ------------------------------------------------------------ helpers
  codec() { return { encode: plain => this.vault.encrypt(plain) }; }

  hooks() {
    return {
      onPassword: (u, p) => this.vault.setPassword(u, p),
      onUserRenamed: (a, b) => this.vault.renameUser(a, b),
      onUserDeleted: u => this.vault.removeUser(u),
      hasKey: u => this.vault.hasUser(u),
    };
  }

  requireService() {
    if (!this.service) throw new AppError('not_logged_in');
    return this.service;
  }

  status() {
    const exists = fs.existsSync(this.dbFile);
    let encrypted = false;
    if (exists) {
      const fd = fs.openSync(this.dbFile, 'r');
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      encrypted = isEncrypted(head);
    }
    return { firstRun: !exists, encrypted, loggedIn: !!this.service };
  }

  async openWith(plain) {
    this.db = new Database(this.dbFile, this.codec());
    await this.db.open(plain);
    this.service = new Service(this.db, this.hooks());
  }

  discard() {
    // drop the in-memory database WITHOUT writing it (used when a login attempt fails)
    if (this.db && this.db.db) { this.db.db.close(); this.db.db = null; }
    this.db = null; this.service = null; this.vault = null;
  }

  /** After a successful admin login, show a recovery key once if the admin has not saved one yet. */
  maybeRecoveryKey(user) {
    if (user.role !== 'admin' || this.config.get('recovery_confirmed')) return null;
    const key = this.vault.newRecovery();
    this.db.save();
    this.service.audit('recovery_key_created', 'database');
    return key;
  }

  // ------------------------------------------------------------ login
  async login(username, password) {
    if (this.service) this.logout();
    if (!fs.existsSync(this.dbFile)) return this.firstRun(username, password);
    const buf = fs.readFileSync(this.dbFile);
    if (isPlainSqlite(buf)) return this.migrate(buf, username, password);
    if (!isEncrypted(buf)) throw new AppError('invalid_file');

    const vault = Vault.unlockWithPassword(buf, username, password);
    if (!vault) {
      if (Vault.needsReset(buf, username)) throw new AppError('account_needs_reset');
      throw new AppError('invalid_login');
    }
    const plain = vault.decrypt(buf);
    if (!plain) throw new AppError('invalid_file');
    this.vault = vault;
    await this.openWith(plain);
    let user;
    try { user = this.service.login(username, password); } catch (e) { this.discard(); throw e; }
    return { ...user, recovery_key: this.maybeRecoveryKey(user) };
  }

  async firstRun(username, password) {
    this.vault = Vault.create();
    this.db = new Database(this.dbFile, this.codec());
    this.db.inTx = 1; // do not write anything until the login succeeds
    await this.db.open(null);
    this.service = new Service(this.db, this.hooks());
    this.service.ensureDefaults();
    let user;
    try { user = this.service.login(username, password); } catch (e) { this.discard(); throw e; }
    this.vault.setPassword(user.username, password);
    this.db.inTx = 0;
    this.db.save();
    return { ...user, recovery_key: this.maybeRecoveryKey(user) };
  }

  /** Converts an unencrypted database (version 0.1) to the encrypted format. */
  async migrate(buf, username, password) {
    const db = new Database(this.dbFile, null);
    db.inTx = 1;
    await db.open(buf);
    const svc = new Service(db);
    let user;
    try { user = svc.login(username, password); } catch (e) { db.db.close(); throw e; }

    // move pre-login settings into the plain config file
    const cfg = {};
    for (const k of LEGACY_SETTINGS) {
      const v = db.getSetting(k, null);
      if (v !== null && v !== '') cfg[k] = ['backup_keep', 'auto_lock_minutes'].includes(k) ? Number(v) : v;
    }
    this.config.set(cfg);

    this.vault = Vault.create();
    this.vault.setPassword(user.username, password);
    const others = db.all('SELECT username FROM users').map(r => r.username).filter(u => u.toLowerCase() !== user.username.toLowerCase());
    this.vault.markPendingReset(others);

    db.codec = this.codec();
    db.inTx = 0;
    db.save();
    this.db = db;
    this.service = svc;
    svc.hooks = this.hooks();
    svc.audit('encrypt_database', 'database', null, `pending reset: ${others.join(', ')}`);

    this.encryptOldBackups();
    return { ...user, recovery_key: this.maybeRecoveryKey(user), migrated: true, pending_reset: others };
  }

  /** Old backups were plain files: replace them by encrypted copies (same data key). */
  encryptOldBackups() {
    const dirs = [this.backups.dir, this.config.get('backup_extra_dir')].filter(Boolean);
    for (const dir of dirs) {
      let names = [];
      try { names = fs.readdirSync(dir).filter(n => n.endsWith('.fdb')); } catch (_) { continue; }
      for (const n of names) {
        const p = require('path').join(dir, n);
        try {
          const b = fs.readFileSync(p);
          if (isPlainSqlite(b)) fs.writeFileSync(p, this.vault.encrypt(b));
        } catch (_) { /* leave it */ }
      }
    }
  }

  async recover(recoveryKey, username, newPassword) {
    if (this.service) this.logout();
    if (!fs.existsSync(this.dbFile)) throw new AppError('invalid_recovery_key');
    const buf = fs.readFileSync(this.dbFile);
    if (!isEncrypted(buf)) throw new AppError('invalid_recovery_key');
    const vault = Vault.unlockWithRecovery(buf, recoveryKey);
    if (!vault) throw new AppError('invalid_recovery_key');
    const plain = vault.decrypt(buf);
    if (!plain) throw new AppError('invalid_file');
    this.vault = vault;
    await this.openWith(plain);
    try {
      return this.service.resetPasswordForRecovery(username, newPassword);
    } catch (e) { this.discard(); throw e; }
  }

  newRecoveryKey() {
    this.requireService().require('admin');
    const key = this.vault.newRecovery();
    this.db.save();
    this.config.set({ recovery_confirmed: false });
    this.service.audit('recovery_key_created', 'database');
    return key;
  }

  confirmRecoverySaved() {
    this.requireService().require('admin');
    this.config.set({ recovery_confirmed: true });
    return true;
  }

  logout() {
    if (this.service) { try { this.service.logout(); } catch (_) { /* ignore */ } }
    if (this.db) { try { this.db.close(); } catch (_) { /* ignore */ } }
    this.db = null; this.service = null; this.vault = null;
  }

  // ------------------------------------------------------------ backups
  async validateBackup(bytes) {
    if (isPlainSqlite(bytes)) {
      const err = await validateDbFile(bytes);
      if (err) throw new AppError(err);
      return { encrypted: false, sameKey: false };
    }
    if (!isEncrypted(bytes)) throw new AppError('not_our_backup');
    try { Vault.readHeader(bytes); } catch (_) { throw new AppError('invalid_file'); }
    if (this.vault) {
      const plain = this.vault.decrypt(bytes);
      if (plain) {
        const err = await validateDbFile(plain);
        if (err) throw new AppError(err);
        return { encrypted: true, sameKey: true };
      }
    }
    // encrypted with another key (e.g. from another laptop): it opens with that copy's passwords
    return { encrypted: true, sameKey: false };
  }

  async restore(bytes) {
    this.requireService().require('admin');
    const info = await this.validateBackup(bytes);
    const who = this.service.currentUser();
    this.service.audit('import', 'database', null, `by ${who && who.username}`);
    this.logout();
    const safety = this.backups.replaceWith(bytes);
    return { safety, ...info };
  }
}

module.exports = { Store };

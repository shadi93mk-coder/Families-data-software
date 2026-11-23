'use strict';
// Daily automatic backups + manual export / import of the whole database.
// Backups are byte-for-byte copies of the (encrypted) database file, so they can be taken
// even while nobody is logged in, and they stay encrypted.

const fs = require('fs');
const path = require('path');
const { today } = require('./service');

const PREFIX = 'families-backup-';
const EXT = '.fdb';

class BackupManager {
  /**
   * @param {string} dbFile   database file to copy
   * @param {string} dir      backups folder
   * @param {import('./config').Config} config
   * @param {() => Buffer|null} [currentBytes]  returns fresh bytes when a session is open (unsaved state is never kept, but this avoids racing a write)
   */
  constructor(dbFile, dir, config, currentBytes) {
    this.dbFile = dbFile;
    this.dir = dir;
    this.config = config;
    this.currentBytes = currentBytes || (() => null);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  keepCount() { return Number(this.config.get('backup_keep')) || 30; }
  extraDir() { return this.config.get('backup_extra_dir') || ''; }

  list() {
    return fs.readdirSync(this.dir)
      .filter(n => n.startsWith(PREFIX) && n.endsWith(EXT))
      .map(n => {
        const st = fs.statSync(path.join(this.dir, n));
        return { name: n, path: path.join(this.dir, n), size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime) || b.name.localeCompare(a.name));
  }

  bytes() {
    const b = this.currentBytes();
    if (b) return b;
    return fs.existsSync(this.dbFile) ? fs.readFileSync(this.dbFile) : null;
  }

  /** Creates today's backup if it does not exist yet. Returns the result or null. */
  runDaily() {
    const name = `${PREFIX}${today()}${EXT}`;
    if (fs.existsSync(path.join(this.dir, name))) return null;
    if (!fs.existsSync(this.dbFile)) return null;
    return this.create(name);
  }

  create(name) {
    const bytes = this.bytes();
    if (!bytes) return null;
    if (!name) {
      const d = new Date();
      const stamp = `${today()}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
      name = `${PREFIX}${stamp}${EXT}`;
    }
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, bytes);
    this.config.set({ last_backup: new Date().toISOString() });
    const extra = this.extraDir();
    let extraError = null;
    if (extra) {
      try {
        fs.mkdirSync(extra, { recursive: true });
        fs.writeFileSync(path.join(extra, name), bytes);
      } catch (e) { extraError = e.message; }
    }
    this.prune();
    return { file, extraError };
  }

  prune() {
    const keep = this.keepCount();
    // safety copies made before an import are never pruned automatically with the daily ones
    const all = this.list().filter(b => !b.name.includes('before-import'));
    for (const b of all.slice(keep)) {
      try { fs.unlinkSync(b.path); } catch (_) { /* ignore */ }
    }
  }

  exportTo(target) {
    fs.writeFileSync(target, this.bytes());
    return target;
  }

  /** Copies a validated backup over the database file, after a safety copy. Caller must close the session first. */
  replaceWith(sourceBytes) {
    const safety = this.create(`${PREFIX}before-import-${Date.now()}${EXT}`);
    const tmp = this.dbFile + '.tmp';
    fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
    fs.writeFileSync(tmp, sourceBytes);
    fs.renameSync(tmp, this.dbFile);
    return safety ? safety.file : null;
  }
}

module.exports = { BackupManager };

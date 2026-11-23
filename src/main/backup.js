'use strict';
// Daily automatic backups + manual export / import of the whole database.

const fs = require('fs');
const path = require('path');
const { validateDbFile } = require('./db');
const { today } = require('./service');

const PREFIX = 'families-backup-';
const EXT = '.fdb';

class BackupManager {
  constructor(db, backupDir) {
    this.db = db;
    this.dir = backupDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  keepCount() { return Number(this.db.getSetting('backup_keep', '30')) || 30; }
  extraDir() { return this.db.getSetting('backup_extra_dir', '') || ''; }

  list() {
    return fs.readdirSync(this.dir)
      .filter(n => n.startsWith(PREFIX) && n.endsWith(EXT))
      .map(n => {
        const st = fs.statSync(path.join(this.dir, n));
        return { name: n, path: path.join(this.dir, n), size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /** Creates today's backup if it does not exist yet. Returns the backup path or null. */
  runDaily() {
    const name = `${PREFIX}${today()}${EXT}`;
    const file = path.join(this.dir, name);
    if (fs.existsSync(file)) return null;
    return this.create(name);
  }

  create(name) {
    if (!name) {
      const d = new Date();
      const stamp = `${today()}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
      name = `${PREFIX}${stamp}${EXT}`;
    }
    const file = path.join(this.dir, name);
    const bytes = this.db.exportBytes();
    fs.writeFileSync(file, bytes);
    this.db.set('last_backup', new Date().toISOString());
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
    const all = this.list();
    for (const b of all.slice(keep)) {
      try { fs.unlinkSync(b.path); } catch (_) { /* ignore */ }
    }
  }

  exportTo(target) {
    fs.writeFileSync(target, this.db.exportBytes());
    return target;
  }

  /**
   * Replaces the current database with the given file. A safety backup of the current
   * data is made first. Returns the safety backup path. Caller must reopen the database.
   */
  async importFrom(source, dbFile) {
    const err = await validateDbFile(source);
    if (err) {
      const e = new Error(err); e.code = err; throw e;
    }
    const safety = this.create(`${PREFIX}before-import-${Date.now()}${EXT}`);
    this.db.close();
    fs.copyFileSync(source, dbFile);
    return safety.file;
  }
}

module.exports = { BackupManager };

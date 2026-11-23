'use strict';
// SQLite storage based on sql.js (WebAssembly) — no native modules, works on any Windows PC.
// The whole database lives in one file that is rewritten atomically after every change.

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',          -- admin | editor | viewer
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_no TEXT UNIQUE,
  head_name TEXT NOT NULL,
  head_national_id TEXT,
  head_birth_date TEXT,
  head_gender TEXT,
  phone TEXT,
  area TEXT,
  address TEXT,
  notes TEXT,
  custom TEXT NOT NULL DEFAULT '{}',            -- JSON: criterion key -> value
  status TEXT NOT NULL DEFAULT 'active',        -- active | archived
  archive_reason TEXT,                          -- death | travel | other
  archive_date TEXT,
  archive_notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_families_status ON families(status);
CREATE INDEX IF NOT EXISTS idx_families_nid ON families(head_national_id);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  national_id TEXT,
  birth_date TEXT,
  gender TEXT,                                  -- m | f
  relation TEXT,                                -- spouse | son | daughter | father | mother | other
  has_disability INTEGER NOT NULL DEFAULT 0,
  chronic_illness INTEGER NOT NULL DEFAULT 0,
  occupation TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_family ON members(family_id);
CREATE INDEX IF NOT EXISTS idx_members_nid ON members(national_id);

CREATE TABLE IF NOT EXISTS criteria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label_ar TEXT, label_en TEXT, label_hy TEXT,
  type TEXT NOT NULL,                           -- number | text | yesno | select | date
  options TEXT NOT NULL DEFAULT '[]',           -- JSON for select: [{value,label_ar,label_en,label_hy,points}]
  points REAL NOT NULL DEFAULT 0,               -- yesno: points if yes; number: points per unit
  max_points REAL,                              -- optional cap (number)
  required INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS aid_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_ar TEXT, name_en TEXT, name_hy TEXT,
  unit TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS distributions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  aid_type_id INTEGER NOT NULL REFERENCES aid_types(id),
  amount REAL,
  date TEXT NOT NULL,
  notes TEXT,
  batch TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_dist_family ON distributions(family_id);

CREATE TABLE IF NOT EXISTS saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT
);
`;

// columns added in v0.3 (ID card fields)
const ADDED_COLUMNS = {
  families: [['head_father_name', 'TEXT'], ['head_mother_name', 'TEXT'], ['head_birth_place', 'TEXT']],
  members: [['father_name', 'TEXT'], ['mother_name', 'TEXT'], ['birth_place', 'TEXT']],
};

const REQUIRED_TABLES = ['users', 'families', 'members', 'criteria', 'aid_types', 'distributions'];

let SQL = null;

async function loadSql() {
  if (!SQL) {
    const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    SQL = await initSqlJs({ wasmBinary });
  }
  return SQL;
}

class Database {
  /**
   * @param {string} file  path of the database file on disk
   * @param {{encode: (plain: Buffer) => Buffer}} [codec]  transforms the SQLite bytes before writing (encryption)
   */
  constructor(file, codec) {
    this.file = file;
    this.codec = codec || null;
    this.db = null;
    this.inTx = 0;
  }

  /** Opens from the given (already decrypted) SQLite bytes, or an empty database when null. */
  async open(plainBytes) {
    await loadSql();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (plainBytes === undefined && !this.codec && fs.existsSync(this.file)) plainBytes = fs.readFileSync(this.file);
    this.db = plainBytes ? new SQL.Database(plainBytes) : new SQL.Database();
    this.db.run('PRAGMA foreign_keys = ON;');
    this.db.run(SCHEMA);
    this.ensureColumns();
    this.set('schema_version', String(SCHEMA_VERSION));
    this.save();
    return this;
  }

  close() {
    if (this.db) { this.save(); this.db.close(); this.db = null; }
  }

  /** Adds columns introduced after the first version (older files lack them). */
  ensureColumns() {
    for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
      const have = new Set(this.db.exec(`PRAGMA table_info(${table})`)[0].values.map(v => v[1]));
      for (const [name, def] of cols) if (!have.has(name)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
    }
  }

  /** Bytes exactly as stored on disk (encrypted when a codec is set). */
  fileBytes() {
    const plain = Buffer.from(this.db.export());
    this.db.run('PRAGMA foreign_keys = ON;');
    return this.codec ? this.codec.encode(plain) : plain;
  }

  get isOpen() { return !!this.db; }

  save() {
    if (!this.db || this.inTx) return;
    const plain = Buffer.from(this.db.export());
    const data = this.codec ? this.codec.encode(plain) : plain;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
    // export() resets pragmas on some builds
    this.db.run('PRAGMA foreign_keys = ON;');
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0] || null;
  }

  run(sql, params = []) {
    this.db.run(sql, params);
    const id = this.db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
    const changes = this.db.getRowsModified();
    this.save();
    return { id, changes };
  }

  tx(fn) {
    this.db.run('BEGIN');
    this.inTx++;
    try {
      const r = fn();
      this.inTx--;
      this.db.run('COMMIT');
      this.save();
      return r;
    } catch (e) {
      this.inTx--;
      try { this.db.run('ROLLBACK'); } catch (_) { /* ignore */ }
      throw e;
    }
  }

  getSetting(key, def = null) {
    const r = this.get('SELECT value FROM settings WHERE key = ?', [key]);
    return r ? r.value : def;
  }

  set(key, value) {
    this.db.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]);
    this.save();
  }

}

/** Checks that a file is a valid database of this program. Returns null if OK, or an error code. */
async function validateDbFile(fileOrBytes) {
  await loadSql();
  let db;
  try {
    db = new SQL.Database(Buffer.isBuffer(fileOrBytes) ? fileOrBytes : fs.readFileSync(fileOrBytes));
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables.length ? tables[0].values.map(v => v[0]) : [];
    for (const t of REQUIRED_TABLES) if (!names.includes(t)) return 'not_our_backup';
    return null;
  } catch (e) {
    return 'invalid_file';
  } finally {
    if (db) db.close();
  }
}

module.exports = { Database, validateDbFile, loadSql };

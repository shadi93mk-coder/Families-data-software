'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const id = require('../src/main/idcard');
const { Database, loadSql } = require('../src/main/db');

// fictitious card data, encoded like the real barcode (Windows-1256, '#' separated, binary tail)
const REV = new Map();
for (let b = 0x80; b < 0x100; b++) REV.set(id.decode1256([b]), b);
function encode1256(s) { return [...s].map(c => (c.charCodeAt(0) < 0x80 ? c.charCodeAt(0) : REV.get(c))); }
const sample = () => [...encode1256('سامر#الأحمد#خالد محمد#ليلى حسن#دمشق 5-3-1988#01234567890#'), 0x4c, 0xd2, 0x00, 0x0d, 0x0a, 0x8d, 0xff, 0x23, 0x41];

test('parses barcode bytes', () => {
  const r = id.parseBytes(sample());
  assert.deepStrictEqual(r, {
    first_name: 'سامر', family_name: 'الأحمد', full_name: 'سامر الأحمد', father_name: 'خالد محمد', mother_name: 'ليلى حسن',
    birth_place: 'دمشق', birth_date: '1988-03-05', national_id: '01234567890',
  });
});

test('keyboard-mode scanner text in all three forms', () => {
  const bytes = sample();
  const latin1 = String.fromCharCode(...bytes);
  const cp1252 = bytes.map(b => (b === 0x8d ? '\u008d' : b >= 0x80 && b < 0xa0 ? '?' : String.fromCharCode(b))).join('');
  const unicode = id.decode1256(bytes);
  for (const t of [latin1, cp1252, unicode]) assert.strictEqual(id.parseScannedText(t).national_id, '01234567890');
});

test('rejects data that is not an ID card', () => {
  assert.strictEqual(id.parseScannedText('hello world 123'), null);
  assert.strictEqual(id.parseScannedText('a#b#c#d#e#123'), null);
  assert.strictEqual(id.parseBytes(encode1256('سامر#الأحمد#خالد#ليلى#دمشق 5-3-1988#123')), null, 'national id must have 11 digits');
});

test('older database files get the new ID columns', async () => {
  const SQL = await loadSql();
  const old = new SQL.Database();
  old.run(`CREATE TABLE families (id INTEGER PRIMARY KEY AUTOINCREMENT, file_no TEXT UNIQUE, head_name TEXT NOT NULL, head_national_id TEXT, head_birth_date TEXT,
    head_gender TEXT, phone TEXT, area TEXT, address TEXT, notes TEXT, custom TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active',
    archive_reason TEXT, archive_date TEXT, archive_notes TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE members (id INTEGER PRIMARY KEY AUTOINCREMENT, family_id INTEGER NOT NULL, full_name TEXT NOT NULL, national_id TEXT, birth_date TEXT,
    gender TEXT, relation TEXT, has_disability INTEGER NOT NULL DEFAULT 0, chronic_illness INTEGER NOT NULL DEFAULT 0, occupation TEXT, notes TEXT);
    INSERT INTO families(file_no, head_name) VALUES('1', 'x');`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fdc-')), 'old.db');
  fs.writeFileSync(file, Buffer.from(old.export()));
  const db = await new Database(file).open();
  const cols = t => db.all(`PRAGMA table_info(${t})`).map(c => c.name);
  for (const c of ['head_father_name', 'head_mother_name', 'head_birth_place']) assert.ok(cols('families').includes(c), c);
  for (const c of ['father_name', 'mother_name', 'birth_place']) assert.ok(cols('members').includes(c), c);
  assert.strictEqual(db.get('SELECT head_name FROM families').head_name, 'x');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');
const { Database } = require('../src/main/db');
const { Service } = require('../src/main/service');
const { isEncrypted, isPlainSqlite } = require('../src/main/vault');

function paths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fds-'));
  return { dir, dbFile: path.join(dir, 'data', 'families.db'), backupDir: path.join(dir, 'backups'), configFile: path.join(dir, 'config.json') };
}
const code = c => e => e.code === c;

test('first run creates an encrypted database; data unreadable without password', async () => {
  const p = paths();
  const st = new Store(p);
  assert.strictEqual(st.status().firstRun, true);
  await assert.rejects(st.login('admin', 'nope'), code('invalid_login'));
  assert.strictEqual(fs.existsSync(p.dbFile), false, 'nothing written after failed first login');

  const u = await st.login('admin', 'admin');
  assert.ok(u.must_change_password);
  assert.match(u.recovery_key, /^[A-Z0-9]{5}(-[A-Z0-9]{5}){7}$/);
  st.service.changePassword('admin', 'Secret#1');
  st.service.saveFamily({ head_name: 'عائلة سرية', head_national_id: '0102030405' });
  st.logout();

  const raw = fs.readFileSync(p.dbFile);
  assert.ok(isEncrypted(raw));
  assert.ok(!raw.includes(Buffer.from('0102030405')), 'national id not visible in file');
  assert.ok(!raw.includes(Buffer.from('عائلة سرية')), 'name not visible in file');

  await assert.rejects(st.login('admin', 'admin'), code('invalid_login'), 'old password no longer works');
  await st.login('admin', 'Secret#1');
  assert.strictEqual(st.service.searchFamilies({}).length, 1);
});

test('users get their own key; rename, reset and delete keep keys in sync', async () => {
  const p = paths();
  const st = new Store(p);
  await st.login('admin', 'admin');
  st.service.changePassword('admin', 'Secret#1');
  st.service.saveUser({ username: 'sara', password: 'sara123', role: 'editor', active: true });
  st.logout();
  await st.login('sara', 'sara123');
  assert.strictEqual(st.service.currentUser().role, 'editor');
  st.logout();

  await st.login('admin', 'Secret#1');
  const sara = st.service.listUsers().find(x => x.username === 'sara');
  st.service.saveUser({ ...sara, username: 'sara2', password: 'newpass1', active: true });
  st.logout();
  await assert.rejects(st.login('sara', 'sara123'), code('invalid_login'));
  await st.login('sara2', 'newpass1');
  st.logout();

  await st.login('admin', 'Secret#1');
  st.service.saveUser({ ...sara, username: 'sara2', active: false });
  st.logout();
  await assert.rejects(st.login('sara2', 'newpass1'), code('invalid_login'), 'inactive user cannot log in');

  await st.login('admin', 'Secret#1');
  st.service.deleteUser(sara.id);
  st.logout();
  await assert.rejects(st.login('sara2', 'newpass1'), code('invalid_login'));
});

test('recovery key resets a forgotten password', async () => {
  const p = paths();
  const st = new Store(p);
  const u = await st.login('admin', 'admin');
  st.service.changePassword('admin', 'Secret#1');
  st.confirmRecoverySaved();
  st.logout();
  await assert.rejects(st.recover('AAAAA-BBBBB', 'admin', 'whatever1'), code('invalid_recovery_key'));
  const lower = u.recovery_key.toLowerCase().replace(/-/g, ' ');
  await st.recover(lower, 'admin', 'Brand#new1');
  st.logout();
  await st.login('admin', 'Brand#new1');
  assert.strictEqual((await st.login('admin', 'Brand#new1')).recovery_key, null, 'no new key once confirmed');
  const k2 = st.newRecoveryKey();
  st.logout();
  await assert.rejects(st.recover(u.recovery_key, 'admin', 'x1234567'), code('invalid_recovery_key'), 'old key revoked');
  await st.recover(k2, 'admin', 'Again#123');
});

test('migrates an old unencrypted database (v0.1)', async () => {
  const p = paths();
  // build a v0.1 style plain database with two users and backups
  const db = await new Database(p.dbFile).open();
  const s = new Service(db); s.ensureDefaults(); s.login('admin', 'admin'); s.changePassword('admin', 'Secret#1');
  s.saveUser({ username: 'omar', password: 'omar123', role: 'editor', active: true });
  s.saveFamily({ head_name: 'قديمة', head_national_id: '999888' });
  db.set('lang', 'hy'); db.set('org_name', 'جمعية');
  db.close();
  fs.mkdirSync(p.backupDir, { recursive: true });
  fs.copyFileSync(p.dbFile, path.join(p.backupDir, 'families-backup-2026-01-01.fdb'));
  assert.ok(isPlainSqlite(fs.readFileSync(p.dbFile)));

  const st = new Store(p);
  await assert.rejects(st.login('admin', 'wrong'), code('invalid_login'));
  assert.ok(isPlainSqlite(fs.readFileSync(p.dbFile)), 'still plain after failed login');
  const u = await st.login('admin', 'Secret#1');
  assert.ok(u.migrated);
  assert.deepStrictEqual(u.pending_reset, ['omar']);
  assert.ok(u.recovery_key);
  assert.strictEqual(st.config.get('lang'), 'hy');
  assert.strictEqual(st.config.get('org_name'), 'جمعية');
  assert.ok(st.service.listUsers().find(x => x.username === 'omar').needs_reset);
  st.logout();
  assert.ok(isEncrypted(fs.readFileSync(p.dbFile)));
  assert.ok(isEncrypted(fs.readFileSync(path.join(p.backupDir, 'families-backup-2026-01-01.fdb'))), 'old backups encrypted');

  await assert.rejects(st.login('omar', 'omar123'), code('account_needs_reset'));
  await st.login('admin', 'Secret#1');
  const omar = st.service.listUsers().find(x => x.username === 'omar');
  st.service.saveUser({ ...omar, active: true, password: 'omar456' });
  st.logout();
  await st.login('omar', 'omar456');
  assert.strictEqual(st.service.searchFamilies({}).length, 1);
});

test('encrypted backups: daily copy, restore, reject garbage', async () => {
  const p = paths();
  const st = new Store(p);
  await st.login('admin', 'admin');
  st.service.changePassword('admin', 'Secret#1');
  st.service.saveFamily({ head_name: 'A' });
  const b = st.backups.runDaily();
  assert.ok(b && isEncrypted(fs.readFileSync(b.file)));
  assert.strictEqual(st.backups.runDaily(), null, 'once per day');
  const snapshot = fs.readFileSync(b.file);
  st.service.saveFamily({ head_name: 'B' });
  assert.strictEqual(st.service.searchFamilies({}).length, 2);

  await assert.rejects(st.restore(Buffer.from('garbage')), code('not_our_backup'));
  const r = await st.restore(snapshot);
  assert.ok(r.sameKey && r.safety);
  assert.strictEqual(st.service, null, 'logged out after restore');
  await st.login('admin', 'Secret#1');
  assert.strictEqual(st.service.searchFamilies({}).length, 1);

  // backup from another installation opens with that installation's password
  const p2 = paths();
  const other = new Store(p2);
  await other.login('admin', 'admin'); other.service.changePassword('admin', 'Other#123');
  other.service.saveFamily({ head_name: 'X' }); other.service.saveFamily({ head_name: 'Y' }); other.service.saveFamily({ head_name: 'Z' });
  other.logout();
  const r2 = await st.restore(fs.readFileSync(p2.dbFile));
  assert.strictEqual(r2.sameKey, false);
  await assert.rejects(st.login('admin', 'Secret#1'), code('invalid_login'));
  await st.login('admin', 'Other#123');
  assert.strictEqual(st.service.searchFamilies({}).length, 3);
});

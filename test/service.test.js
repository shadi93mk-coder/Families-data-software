'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require('../src/main/db');
const { Service } = require('../src/main/service');
const { BackupManager } = require('../src/main/backup');
const excel = require('../src/main/excel');

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-'));
  const db = await new Database(path.join(dir, 'data', 'f.db')).open();
  const s = new Service(db);
  s.ensureDefaults();
  s.login('admin', 'admin');
  return { dir, db, s };
}

test('login, password change and roles', async () => {
  const { s } = await setup();
  assert.throws(() => s.login('admin', 'wrong'), e => e.code === 'invalid_login');
  s.login('admin', 'admin');
  assert.strictEqual(s.currentUser().must_change_password, true);
  s.changePassword('admin', 'secret1');
  s.saveUser({ username: 'viewer1', password: 'pass123', role: 'viewer', active: true });
  s.login('viewer1', 'pass123');
  assert.throws(() => s.saveFamily({ head_name: 'x' }), e => e.code === 'forbidden');
  assert.throws(() => s.listUsers(), e => e.code === 'forbidden');
  assert.ok(Array.isArray(s.searchFamilies({})));
});

test('criteria, scoring and filtering', async () => {
  const { s } = await setup();
  s.saveCriterion({ label_ar: 'يوجد مريض', type: 'yesno', points: 10 });
  s.saveCriterion({ label_ar: 'عدد الأيتام', type: 'number', points: 5, max_points: 15 });
  s.saveCriterion({ label_ar: 'السكن', type: 'select', options: [
    { value: 'own', label_ar: 'ملك', points: 0 }, { value: 'rent', label_ar: 'إيجار', points: 8 }] });
  const [sick, orphans, housing] = s.listCriteria();
  const a = s.saveFamily({ head_name: 'أحمد', head_national_id: '111', head_gender: 'm', area: 'حلب',
    custom: { [sick.key]: true, [orphans.key]: 4, [housing.key]: 'rent' },
    members: [{ full_name: 'ولد', birth_date: '2020-01-01', gender: 'm' }, { full_name: 'بنت', birth_date: '2015-05-05', gender: 'f', has_disability: true }] });
  const b = s.saveFamily({ head_name: 'مريم', head_gender: 'f', area: 'دمشق', custom: { [sick.key]: false, [housing.key]: 'own' } });

  let rows = s.searchFamilies({});
  assert.strictEqual(rows[0].id, a, 'sorted by score desc');
  assert.strictEqual(rows[0].score, 10 + 15 + 8);
  assert.strictEqual(rows[0].members_count, 3);
  assert.strictEqual(rows[0].children_count, 2);
  assert.strictEqual(rows[0].disabled_count, 1);

  rows = s.searchFamilies({ conditions: [{ field: `c:${sick.key}`, op: 'yes' }] });
  assert.deepStrictEqual(rows.map(r => r.id), [a]);
  rows = s.searchFamilies({ conditions: [{ field: 'female_head', op: 'yes' }] });
  assert.deepStrictEqual(rows.map(r => r.id), [b]);
  rows = s.searchFamilies({ conditions: [{ field: `c:${housing.key}`, op: 'in', value: ['own'] }] });
  assert.deepStrictEqual(rows.map(r => r.id), [b]);
  rows = s.searchFamilies({ match: 'any', conditions: [{ field: 'members_count', op: 'gte', value: 3 }, { field: 'area', op: 'contains', value: 'دمش' }] });
  assert.strictEqual(rows.length, 2);
  rows = s.searchFamilies({ search: '111' });
  assert.deepStrictEqual(rows.map(r => r.id), [a]);

  // duplicate national id detection
  assert.strictEqual(s.findByNationalId('111').length, 1);
  assert.strictEqual(s.findByNationalId('111', a).length, 0);

  // distributions & "days since aid"
  const aid = s.listAidTypes()[2];
  s.recordDistribution({ familyIds: [a], aidTypeId: aid.id, date: '2000-01-01' });
  rows = s.searchFamilies({ conditions: [{ field: `days_since_aid:${aid.id}`, op: 'gte', value: 30 }] });
  assert.strictEqual(rows.length, 2, 'old aid and never-aided both match');
  s.recordDistribution({ familyIds: [a], aidTypeId: aid.id });
  rows = s.searchFamilies({ conditions: [{ field: `days_since_aid:${aid.id}`, op: 'gte', value: 30 }] });
  assert.deepStrictEqual(rows.map(r => r.id), [b]);
  assert.throws(() => s.deleteAidType(aid.id), e => e.code === 'aid_type_in_use');

  // deleting a criterion removes values
  s.deleteCriterion(sick.id);
  assert.strictEqual(s.getFamily(a).custom[sick.key], undefined);

  const st = s.stats();
  assert.strictEqual(st.families, 2);
  assert.strictEqual(st.femaleHeaded, 1);
});

test('archive, restore and permanent delete', async () => {
  const { s } = await setup();
  const id = s.saveFamily({ head_name: 'x' });
  assert.throws(() => s.deleteFamilyPermanently(id), e => e.code === 'must_archive_first');
  s.archiveFamily(id, 'travel', '2026-01-02', 'سافر');
  assert.strictEqual(s.searchFamilies({}).length, 0);
  const arch = s.searchFamilies({ status: 'archived' });
  assert.strictEqual(arch[0].archive_reason, 'travel');
  s.restoreFamily(id);
  assert.strictEqual(s.searchFamilies({}).length, 1);
  s.archiveFamily(id, 'death');
  s.deleteFamilyPermanently(id);
  assert.strictEqual(s.searchFamilies({ status: 'archived' }).length, 0);
});

test('backup, restore and excel round trip', async () => {
  const { dir, db, s } = await setup();
  s.saveCriterion({ label_ar: 'مريض', label_en: 'Sick', type: 'yesno', points: 1 });
  const id = s.saveFamily({ head_name: 'سامي', file_no: '7', members: [{ full_name: 'ابن' }] });
  const bm = new BackupManager(db, path.join(dir, 'backups'));
  assert.ok(bm.runDaily());
  assert.strictEqual(bm.runDaily(), null, 'only once per day');

  const xfile = path.join(dir, 'out.xlsx');
  excel.exportFamilies(s, [id], xfile, 'ar');
  s.archiveFamily(id, 'other'); s.deleteFamilyPermanently(id);
  const r = excel.importFamilies(s, xfile);
  assert.deepStrictEqual([r.created, r.errors.length], [1, 0]);
  const f = s.searchFamilies({})[0];
  assert.strictEqual(f.head_name, 'سامي');
  assert.strictEqual(f.members_count, 2);
  const r2 = excel.importFamilies(s, xfile);
  assert.strictEqual(r2.updated, 1);

  // restore the daily backup
  const exported = path.join(dir, 'copy.fdb');
  bm.exportTo(exported);
  s.saveFamily({ head_name: 'later' });
  await bm.importFrom(exported, db.file);
  const db2 = await new Database(db.file).open();
  const s2 = new Service(db2); s2.login('admin', 'admin');
  assert.strictEqual(s2.searchFamilies({}).length, 1);
  const bad = path.join(dir, 'bad.fdb'); fs.writeFileSync(bad, 'nope');
  const bm2 = new BackupManager(db2, path.join(dir, 'backups'));
  await assert.rejects(bm2.importFrom(bad, db2.file), e => e.code === 'invalid_file' || e.code === 'not_our_backup');
});

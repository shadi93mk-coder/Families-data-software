'use strict';
// Business logic. Independent of Electron so it can be unit-tested with plain Node.

const bcrypt = require('bcryptjs');

const ROLES = ['admin', 'editor', 'viewer'];
const ARCHIVE_REASONS = ['death', 'travel', 'other'];
const CRITERION_TYPES = ['number', 'text', 'yesno', 'select', 'date'];

class AppError extends Error {
  constructor(code, extra) { super(code); this.code = code; this.extra = extra; }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ageFrom(birth, ref = new Date()) {
  if (!birth) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(birth));
  if (!m) {
    const y = /^(\d{4})$/.exec(String(birth).trim());
    return y ? ref.getFullYear() - Number(y[1]) : null;
  }
  const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let age = ref.getFullYear() - b.getFullYear();
  const mo = ref.getMonth() - b.getMonth();
  if (mo < 0 || (mo === 0 && ref.getDate() < b.getDate())) age--;
  return age;
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}

function parseJSON(s, def) { try { return s ? JSON.parse(s) : def; } catch (_) { return def; } }

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }

class Service {
  constructor(db) {
    this.db = db;
    this.user = null;
  }

  // ---------------------------------------------------------------- setup
  ensureDefaults() {
    const n = this.db.get('SELECT COUNT(*) AS n FROM users').n;
    if (n === 0) {
      this.db.run('INSERT INTO users(username, full_name, password_hash, role, must_change_password) VALUES(?,?,?,?,1)',
        ['admin', 'Administrator', bcrypt.hashSync('admin', 10), 'admin']);
    }
    const a = this.db.get('SELECT COUNT(*) AS n FROM aid_types').n;
    if (a === 0) {
      const defaults = [
        ['مبلغ مالي', 'Cash', 'Դրամական աջակցություն', 'SYP'],
        ['كوبون', 'Voucher', 'Կտրոն', ''],
        ['سلة غذائية', 'Food basket', 'Սննդի փաթեթ', ''],
        ['سلة صحية', 'Hygiene kit', 'Հիգիենայի պարագաների փաթեթ', ''],
      ];
      for (const d of defaults) this.db.run('INSERT INTO aid_types(name_ar,name_en,name_hy,unit) VALUES(?,?,?,?)', d);
    }
  }

  // ---------------------------------------------------------------- auth
  login(username, password) {
    const u = this.db.get('SELECT * FROM users WHERE username = ? AND active = 1', [str(username)]);
    if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
      throw new AppError('invalid_login');
    }
    this.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role, must_change_password: !!u.must_change_password };
    this.audit('login', 'user', u.id);
    return this.user;
  }

  logout() {
    if (this.user) this.audit('logout', 'user', this.user.id);
    this.user = null;
  }

  currentUser() { return this.user; }

  require(role) {
    if (!this.user) throw new AppError('not_logged_in');
    const rank = { viewer: 0, editor: 1, admin: 2 };
    if (rank[this.user.role] < rank[role]) throw new AppError('forbidden');
  }

  changePassword(oldPw, newPw) {
    this.require('viewer');
    const u = this.db.get('SELECT * FROM users WHERE id = ?', [this.user.id]);
    if (!bcrypt.compareSync(String(oldPw || ''), u.password_hash)) throw new AppError('wrong_password');
    if (String(newPw || '').length < 6) throw new AppError('password_too_short');
    this.db.run('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [bcrypt.hashSync(newPw, 10), u.id]);
    this.user.must_change_password = false;
    this.audit('change_password', 'user', u.id);
    return true;
  }

  listUsers() {
    this.require('admin');
    return this.db.all('SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id');
  }

  saveUser(u) {
    this.require('admin');
    const username = str(u.username);
    if (!username) throw new AppError('username_required');
    if (!ROLES.includes(u.role)) throw new AppError('invalid_role');
    const dup = this.db.get('SELECT id FROM users WHERE username = ? AND id != ?', [username, u.id || 0]);
    if (dup) throw new AppError('username_exists');
    if (u.id) {
      if (u.id === this.user.id && (u.role !== 'admin' || !u.active)) throw new AppError('cannot_demote_self');
      this.db.run('UPDATE users SET username=?, full_name=?, role=?, active=? WHERE id=?',
        [username, str(u.full_name), u.role, u.active ? 1 : 0, u.id]);
      if (u.password) {
        if (String(u.password).length < 6) throw new AppError('password_too_short');
        this.db.run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', [bcrypt.hashSync(u.password, 10), u.id]);
      }
      this.audit('update', 'user', u.id, username);
      return u.id;
    }
    if (String(u.password || '').length < 6) throw new AppError('password_too_short');
    const r = this.db.run('INSERT INTO users(username, full_name, password_hash, role, active, must_change_password) VALUES(?,?,?,?,?,1)',
      [username, str(u.full_name), bcrypt.hashSync(u.password, 10), u.role, u.active === false ? 0 : 1]);
    this.audit('create', 'user', r.id, username);
    return r.id;
  }

  deleteUser(id) {
    this.require('admin');
    if (id === this.user.id) throw new AppError('cannot_delete_self');
    this.db.run('DELETE FROM users WHERE id = ?', [id]);
    this.audit('delete', 'user', id);
    return true;
  }

  // ---------------------------------------------------------------- audit
  audit(action, entity, entityId, details) {
    this.db.run('INSERT INTO audit_log(username, action, entity, entity_id, details) VALUES(?,?,?,?,?)',
      [this.user ? this.user.username : null, action, entity || null, entityId || null, details ? String(details).slice(0, 500) : null]);
  }

  listAudit(limit = 500) {
    this.require('admin');
    return this.db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', [limit]);
  }

  // ---------------------------------------------------------------- criteria
  listCriteria(includeInactive = true) {
    this.require('viewer');
    const rows = this.db.all(`SELECT * FROM criteria ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`);
    return rows.map(r => ({ ...r, options: parseJSON(r.options, []), active: !!r.active, required: !!r.required }));
  }

  saveCriterion(c) {
    this.require('admin');
    if (!CRITERION_TYPES.includes(c.type)) throw new AppError('invalid_type');
    if (!str(c.label_ar) && !str(c.label_en) && !str(c.label_hy)) throw new AppError('label_required');
    const options = (c.type === 'select' ? (c.options || []) : [])
      .filter(o => str(o.label_ar) || str(o.label_en) || str(o.label_hy))
      .map((o, i) => ({
        value: str(o.value) || `opt${i + 1}_${Date.now().toString(36)}`,
        label_ar: str(o.label_ar), label_en: str(o.label_en), label_hy: str(o.label_hy),
        points: Number(o.points) || 0,
      }));
    if (c.type === 'select' && options.length === 0) throw new AppError('options_required');
    const vals = [str(c.label_ar), str(c.label_en), str(c.label_hy), c.type, JSON.stringify(options),
      Number(c.points) || 0, c.max_points === '' || c.max_points === null || c.max_points === undefined ? null : Number(c.max_points),
      c.required ? 1 : 0, c.active === false ? 0 : 1, Number(c.sort_order) || 0];
    if (c.id) {
      this.db.run('UPDATE criteria SET label_ar=?, label_en=?, label_hy=?, type=?, options=?, points=?, max_points=?, required=?, active=?, sort_order=? WHERE id=?', [...vals, c.id]);
      this.audit('update', 'criterion', c.id, c.label_ar || c.label_en);
      return c.id;
    }
    const key = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const r = this.db.run('INSERT INTO criteria(label_ar,label_en,label_hy,type,options,points,max_points,required,active,sort_order,key) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [...vals, key]);
    this.audit('create', 'criterion', r.id, c.label_ar || c.label_en);
    return r.id;
  }

  deleteCriterion(id) {
    this.require('admin');
    const c = this.db.get('SELECT * FROM criteria WHERE id = ?', [id]);
    if (!c) return false;
    this.db.tx(() => {
      this.db.run('DELETE FROM criteria WHERE id = ?', [id]);
      // remove stored values from families
      for (const f of this.db.all("SELECT id, custom FROM families WHERE custom LIKE ?", [`%"${c.key}"%`])) {
        const custom = parseJSON(f.custom, {});
        delete custom[c.key];
        this.db.run('UPDATE families SET custom = ? WHERE id = ?', [JSON.stringify(custom), f.id]);
      }
    });
    this.audit('delete', 'criterion', id, c.label_ar || c.label_en);
    return true;
  }

  // ---------------------------------------------------------------- aid types
  listAidTypes() {
    this.require('viewer');
    return this.db.all('SELECT * FROM aid_types ORDER BY id').map(r => ({ ...r, active: !!r.active }));
  }

  saveAidType(a) {
    this.require('admin');
    if (!str(a.name_ar) && !str(a.name_en) && !str(a.name_hy)) throw new AppError('label_required');
    const vals = [str(a.name_ar), str(a.name_en), str(a.name_hy), str(a.unit), a.active === false ? 0 : 1];
    if (a.id) {
      this.db.run('UPDATE aid_types SET name_ar=?, name_en=?, name_hy=?, unit=?, active=? WHERE id=?', [...vals, a.id]);
      this.audit('update', 'aid_type', a.id, a.name_ar || a.name_en);
      return a.id;
    }
    const r = this.db.run('INSERT INTO aid_types(name_ar,name_en,name_hy,unit,active) VALUES(?,?,?,?,?)', vals);
    this.audit('create', 'aid_type', r.id, a.name_ar || a.name_en);
    return r.id;
  }

  deleteAidType(id) {
    this.require('admin');
    const used = this.db.get('SELECT COUNT(*) AS n FROM distributions WHERE aid_type_id = ?', [id]).n;
    if (used > 0) throw new AppError('aid_type_in_use');
    this.db.run('DELETE FROM aid_types WHERE id = ?', [id]);
    this.audit('delete', 'aid_type', id);
    return true;
  }

  // ---------------------------------------------------------------- families
  nextFileNo() {
    const r = this.db.get("SELECT MAX(CAST(file_no AS INTEGER)) AS m FROM families WHERE file_no GLOB '[0-9]*'");
    return String((r && r.m ? r.m : 0) + 1);
  }

  getFamily(id) {
    this.require('viewer');
    const f = this.db.get('SELECT * FROM families WHERE id = ?', [id]);
    if (!f) throw new AppError('not_found');
    f.custom = parseJSON(f.custom, {});
    f.members = this.db.all('SELECT * FROM members WHERE family_id = ? ORDER BY id', [id])
      .map(m => ({ ...m, has_disability: !!m.has_disability, chronic_illness: !!m.chronic_illness }));
    f.distributions = this.db.all(`SELECT d.*, a.name_ar, a.name_en, a.name_hy, a.unit FROM distributions d
      JOIN aid_types a ON a.id = d.aid_type_id WHERE d.family_id = ? ORDER BY d.date DESC, d.id DESC`, [id]);
    return f;
  }

  /** Returns families whose head or members have the given national id (duplicate check). */
  findByNationalId(nid, excludeFamilyId = 0) {
    this.require('viewer');
    nid = str(nid);
    if (!nid) return [];
    return this.db.all(`SELECT DISTINCT f.id, f.file_no, f.head_name, f.status FROM families f
      LEFT JOIN members m ON m.family_id = f.id
      WHERE (f.head_national_id = ? OR m.national_id = ?) AND f.id != ?`, [nid, nid, excludeFamilyId || 0]);
  }

  saveFamily(f) {
    this.require('editor');
    if (!str(f.head_name)) throw new AppError('head_name_required');
    const criteria = this.listCriteria(false);
    const custom = {};
    for (const c of criteria) {
      let v = f.custom ? f.custom[c.key] : undefined;
      if (v === '' || v === undefined || v === null) {
        if (c.required) throw new AppError('criterion_required', c.label_ar || c.label_en || c.label_hy);
        continue;
      }
      if (c.type === 'number') { v = Number(v); if (Number.isNaN(v)) continue; }
      if (c.type === 'yesno') v = v === true || v === 'yes' || v === 1 || v === '1' || v === 'true';
      custom[c.key] = v;
    }
    // keep values of inactive criteria
    if (f.id) {
      const old = this.db.get('SELECT custom FROM families WHERE id = ?', [f.id]);
      if (!old) throw new AppError('not_found');
      const oldCustom = parseJSON(old.custom, {});
      const activeKeys = new Set(criteria.map(c => c.key));
      for (const k of Object.keys(oldCustom)) if (!activeKeys.has(k)) custom[k] = oldCustom[k];
    }
    let fileNo = str(f.file_no);
    if (fileNo) {
      const dup = this.db.get('SELECT id FROM families WHERE file_no = ? AND id != ?', [fileNo, f.id || 0]);
      if (dup) throw new AppError('file_no_exists');
    }
    const members = (f.members || []).filter(m => str(m.full_name));
    return this.db.tx(() => {
      const base = [str(f.head_name), str(f.head_national_id), str(f.head_birth_date), str(f.head_gender),
        str(f.phone), str(f.area), str(f.address), str(f.notes), JSON.stringify(custom)];
      let id = f.id;
      if (id) {
        this.db.run(`UPDATE families SET file_no=?, head_name=?, head_national_id=?, head_birth_date=?, head_gender=?, phone=?, area=?, address=?, notes=?, custom=?,
          updated_at=datetime('now','localtime') WHERE id=?`, [fileNo || this.nextFileNo(), ...base, id]);
        this.db.run('DELETE FROM members WHERE family_id = ?', [id]);
      } else {
        id = this.db.run(`INSERT INTO families(file_no, head_name, head_national_id, head_birth_date, head_gender, phone, area, address, notes, custom, created_by)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [fileNo || this.nextFileNo(), ...base, this.user.username]).id;
      }
      for (const m of members) {
        this.db.run(`INSERT INTO members(family_id, full_name, national_id, birth_date, gender, relation, has_disability, chronic_illness, occupation, notes)
          VALUES(?,?,?,?,?,?,?,?,?,?)`, [id, str(m.full_name), str(m.national_id), str(m.birth_date), str(m.gender), str(m.relation),
          m.has_disability ? 1 : 0, m.chronic_illness ? 1 : 0, str(m.occupation), str(m.notes)]);
      }
      this.audit(f.id ? 'update' : 'create', 'family', id, f.head_name);
      return id;
    });
  }

  archiveFamily(id, reason, date, notes) {
    this.require('editor');
    if (!ARCHIVE_REASONS.includes(reason)) throw new AppError('invalid_reason');
    this.db.run(`UPDATE families SET status='archived', archive_reason=?, archive_date=?, archive_notes=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [reason, str(date) || today(), str(notes), id]);
    this.audit('archive', 'family', id, reason);
    return true;
  }

  restoreFamily(id) {
    this.require('editor');
    this.db.run(`UPDATE families SET status='active', archive_reason=NULL, archive_date=NULL, archive_notes=NULL, updated_at=datetime('now','localtime') WHERE id=?`, [id]);
    this.audit('restore', 'family', id);
    return true;
  }

  deleteFamilyPermanently(id) {
    this.require('admin');
    const f = this.db.get('SELECT status, head_name FROM families WHERE id = ?', [id]);
    if (!f) return false;
    if (f.status !== 'archived') throw new AppError('must_archive_first');
    this.db.run('DELETE FROM families WHERE id = ?', [id]);
    this.audit('delete', 'family', id, f.head_name);
    return true;
  }

  // ---------------------------------------------------------------- distributions
  recordDistribution({ familyIds, aidTypeId, amount, date, notes }) {
    this.require('editor');
    if (!familyIds || !familyIds.length) throw new AppError('no_families_selected');
    if (!this.db.get('SELECT id FROM aid_types WHERE id = ?', [aidTypeId])) throw new AppError('invalid_aid_type');
    const batch = 'B' + Date.now().toString(36).toUpperCase();
    const d = str(date) || today();
    this.db.tx(() => {
      for (const fid of familyIds) {
        this.db.run('INSERT INTO distributions(family_id, aid_type_id, amount, date, notes, batch, created_by) VALUES(?,?,?,?,?,?,?)',
          [fid, aidTypeId, amount === '' || amount === undefined || amount === null ? null : Number(amount), d, str(notes), batch, this.user.username]);
      }
    });
    this.audit('distribute', 'aid_type', aidTypeId, `${familyIds.length} families, batch ${batch}`);
    return { batch, count: familyIds.length };
  }

  deleteDistribution(id) {
    this.require('editor');
    this.db.run('DELETE FROM distributions WHERE id = ?', [id]);
    this.audit('delete', 'distribution', id);
    return true;
  }

  listDistributions({ from, to, aidTypeId } = {}) {
    this.require('viewer');
    const where = [];
    const p = [];
    if (from) { where.push('d.date >= ?'); p.push(from); }
    if (to) { where.push('d.date <= ?'); p.push(to); }
    if (aidTypeId) { where.push('d.aid_type_id = ?'); p.push(aidTypeId); }
    return this.db.all(`SELECT d.*, f.file_no, f.head_name, f.head_national_id, f.area, a.name_ar, a.name_en, a.name_hy, a.unit
      FROM distributions d JOIN families f ON f.id = d.family_id JOIN aid_types a ON a.id = d.aid_type_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.date DESC, d.id DESC LIMIT 5000`, p);
  }

  // ---------------------------------------------------------------- filtering
  /** Fields available in the filter builder. Labels are i18n keys (builtin) or label_* (criteria). */
  filterFields() {
    this.require('viewer');
    const fields = [
      { id: 'file_no', type: 'text', i18n: 'f.file_no' },
      { id: 'head_name', type: 'text', i18n: 'f.head_name' },
      { id: 'head_national_id', type: 'text', i18n: 'f.head_national_id' },
      { id: 'phone', type: 'text', i18n: 'f.phone' },
      { id: 'area', type: 'text', i18n: 'f.area' },
      { id: 'address', type: 'text', i18n: 'f.address' },
      { id: 'members_count', type: 'number', i18n: 'f.members_count' },
      { id: 'children_count', type: 'number', i18n: 'f.children_count' },
      { id: 'infants_count', type: 'number', i18n: 'f.infants_count' },
      { id: 'elderly_count', type: 'number', i18n: 'f.elderly_count' },
      { id: 'females_count', type: 'number', i18n: 'f.females_count' },
      { id: 'disabled_count', type: 'number', i18n: 'f.disabled_count' },
      { id: 'chronic_count', type: 'number', i18n: 'f.chronic_count' },
      { id: 'female_head', type: 'yesno', i18n: 'f.female_head' },
      { id: 'head_age', type: 'number', i18n: 'f.head_age' },
      { id: 'score', type: 'number', i18n: 'f.score' },
      { id: 'aid_count', type: 'number', i18n: 'f.aid_count' },
      { id: 'days_since_aid:any', type: 'number', i18n: 'f.days_since_aid_any', neverMeansInfinite: true },
      { id: 'created_at', type: 'date', i18n: 'f.created_at' },
    ];
    for (const a of this.listAidTypes()) {
      fields.push({ id: `days_since_aid:${a.id}`, type: 'number', i18n: 'f.days_since_aid_type', aid: a, neverMeansInfinite: true });
    }
    for (const c of this.listCriteria(false)) {
      fields.push({ id: `c:${c.key}`, type: c.type, criterion: c });
    }
    return fields;
  }

  computeScore(custom, criteria) {
    let score = 0;
    for (const c of criteria) {
      const v = custom[c.key];
      if (v === undefined || v === null || v === '') continue;
      if (c.type === 'yesno' && v === true) score += c.points;
      else if (c.type === 'number') {
        let p = Number(v) * c.points;
        if (c.max_points !== null && c.max_points !== undefined) p = Math.min(p, c.max_points);
        score += p;
      } else if (c.type === 'select') {
        const o = c.options.find(x => x.value === v);
        if (o) score += o.points;
      }
    }
    return Math.round(score * 100) / 100;
  }

  /** Builds a flat record per family with computed fields used for filtering and display. */
  buildRows(status = 'active') {
    const criteria = this.listCriteria(false);
    const families = this.db.all('SELECT * FROM families WHERE status = ? ORDER BY id', [status]);
    const members = this.db.all('SELECT m.* FROM members m JOIN families f ON f.id = m.family_id WHERE f.status = ?', [status]);
    const dist = this.db.all(`SELECT d.family_id, d.aid_type_id, MAX(d.date) AS last, COUNT(*) AS n FROM distributions d
      JOIN families f ON f.id = d.family_id WHERE f.status = ? GROUP BY d.family_id, d.aid_type_id`, [status]);
    const byFam = new Map();
    for (const m of members) {
      if (!byFam.has(m.family_id)) byFam.set(m.family_id, []);
      byFam.get(m.family_id).push(m);
    }
    const distByFam = new Map();
    for (const d of dist) {
      if (!distByFam.has(d.family_id)) distByFam.set(d.family_id, []);
      distByFam.get(d.family_id).push(d);
    }
    const now = new Date();
    const t = today();
    return families.map(f => {
      const ms = byFam.get(f.id) || [];
      const people = [{ birth_date: f.head_birth_date, gender: f.head_gender, has_disability: 0, chronic_illness: 0 }, ...ms];
      const ages = people.map(p => ageFrom(p.birth_date, now));
      const custom = parseJSON(f.custom, {});
      const ds = distByFam.get(f.id) || [];
      const sinceAid = {};
      let lastAny = null;
      let aidCount = 0;
      for (const d of ds) {
        sinceAid[d.aid_type_id] = daysBetween(d.last, t);
        if (!lastAny || d.last > lastAny) lastAny = d.last;
        aidCount += d.n;
      }
      const row = {
        id: f.id,
        file_no: f.file_no,
        head_name: f.head_name,
        head_national_id: f.head_national_id,
        head_birth_date: f.head_birth_date,
        head_gender: f.head_gender,
        phone: f.phone,
        area: f.area,
        address: f.address,
        notes: f.notes,
        status: f.status,
        archive_reason: f.archive_reason,
        archive_date: f.archive_date,
        archive_notes: f.archive_notes,
        created_at: (f.created_at || '').slice(0, 10),
        members_count: people.length,
        children_count: ages.filter(a => a !== null && a < 18).length,
        infants_count: ages.filter(a => a !== null && a < 2).length,
        elderly_count: ages.filter(a => a !== null && a >= 60).length,
        females_count: people.filter(p => p.gender === 'f').length,
        disabled_count: ms.filter(m => m.has_disability).length,
        chronic_count: ms.filter(m => m.chronic_illness).length,
        female_head: f.head_gender === 'f',
        head_age: ageFrom(f.head_birth_date, now),
        aid_count: aidCount,
        last_aid: lastAny,
        'days_since_aid:any': lastAny ? daysBetween(lastAny, t) : null,
        custom,
        score: this.computeScore(custom, criteria),
      };
      for (const k of Object.keys(sinceAid)) row[`days_since_aid:${k}`] = sinceAid[k];
      for (const k of Object.keys(custom)) row[`c:${k}`] = custom[k];
      return row;
    });
  }

  /**
   * filter = { match: 'all'|'any', conditions: [{field, op, value, value2}], search, sort: {field, dir}, status }
   */
  searchFamilies(filter = {}) {
    this.require('viewer');
    const fields = new Map(this.filterFields().map(f => [f.id, f]));
    let rows = this.buildRows(filter.status === 'archived' ? 'archived' : 'active');
    const q = str(filter.search).toLowerCase();
    if (q) {
      rows = rows.filter(r => [r.file_no, r.head_name, r.head_national_id, r.phone, r.area, r.address]
        .some(v => v && String(v).toLowerCase().includes(q)));
    }
    const conds = (filter.conditions || []).filter(c => c && c.field && c.op && fields.has(c.field));
    if (conds.length) {
      const any = filter.match === 'any';
      rows = rows.filter(r => {
        const results = conds.map(c => evalCondition(r[c.field], c, fields.get(c.field)));
        return any ? results.some(Boolean) : results.every(Boolean);
      });
    }
    const sort = filter.sort || { field: 'score', dir: 'desc' };
    const dir = sort.dir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const va = a[sort.field];
      const vb = b[sort.field];
      if (va === vb) return a.id - b.id;
      if (va === null || va === undefined || va === '') return 1;
      if (vb === null || vb === undefined || vb === '') return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), 'ar') * dir;
    });
    return rows;
  }

  // ---------------------------------------------------------------- saved filters
  listSavedFilters() {
    this.require('viewer');
    return this.db.all('SELECT * FROM saved_filters ORDER BY name').map(r => ({ ...r, definition: parseJSON(r.definition, {}) }));
  }

  saveFilter(name, definition) {
    this.require('editor');
    if (!str(name)) throw new AppError('name_required');
    const ex = this.db.get('SELECT id FROM saved_filters WHERE name = ?', [str(name)]);
    if (ex) {
      this.db.run('UPDATE saved_filters SET definition = ? WHERE id = ?', [JSON.stringify(definition), ex.id]);
      return ex.id;
    }
    return this.db.run('INSERT INTO saved_filters(name, definition, created_by) VALUES(?,?,?)', [str(name), JSON.stringify(definition), this.user.username]).id;
  }

  deleteSavedFilter(id) {
    this.require('editor');
    this.db.run('DELETE FROM saved_filters WHERE id = ?', [id]);
    return true;
  }

  // ---------------------------------------------------------------- statistics
  stats() {
    this.require('viewer');
    const rows = this.buildRows('active');
    const archived = this.db.all("SELECT archive_reason AS reason, COUNT(*) AS n FROM families WHERE status='archived' GROUP BY archive_reason");
    const sum = k => rows.reduce((s, r) => s + (r[k] || 0), 0);
    const byArea = {};
    for (const r of rows) { const a = r.area || '—'; byArea[a] = (byArea[a] || 0) + 1; }
    const criteria = this.listCriteria(false);
    const criteriaStats = criteria.map(c => {
      const s = { id: c.id, key: c.key, type: c.type, criterion: c };
      const vals = rows.map(r => r.custom[c.key]).filter(v => v !== undefined && v !== null && v !== '');
      s.filled = vals.length;
      if (c.type === 'yesno') s.yes = vals.filter(v => v === true).length;
      if (c.type === 'number') s.sum = vals.reduce((a, b) => a + Number(b), 0);
      if (c.type === 'select') {
        s.byOption = {};
        for (const o of c.options) s.byOption[o.value] = vals.filter(v => v === o.value).length;
      }
      return s;
    });
    const month = today().slice(0, 7);
    const distMonth = this.db.all(`SELECT a.id, a.name_ar, a.name_en, a.name_hy, a.unit, COUNT(d.id) AS n, SUM(d.amount) AS total
      FROM aid_types a LEFT JOIN distributions d ON d.aid_type_id = a.id AND substr(d.date,1,7) = ? GROUP BY a.id ORDER BY a.id`, [month]);
    return {
      families: rows.length,
      persons: sum('members_count'),
      children: sum('children_count'),
      elderly: sum('elderly_count'),
      disabled: sum('disabled_count'),
      chronic: sum('chronic_count'),
      femaleHeaded: rows.filter(r => r.female_head).length,
      neverAided: rows.filter(r => !r.last_aid).length,
      archived,
      byArea: Object.entries(byArea).sort((a, b) => b[1] - a[1]),
      criteriaStats,
      distMonth,
      month,
    };
  }
}

function evalCondition(v, c, field) {
  const op = c.op;
  const empty = v === undefined || v === null || v === '';
  if (op === 'empty') return empty;
  if (op === 'notempty') return !empty;
  const type = field.type;
  if (type === 'yesno') {
    if (op === 'yes') return v === true;
    if (op === 'no') return v !== true;
    return false;
  }
  if (type === 'number') {
    let n = empty ? null : Number(v);
    if (n === null) {
      // "never received aid" behaves like an infinitely long time ago
      if (field.neverMeansInfinite) n = Infinity; else return false;
    }
    const a = Number(c.value);
    const b = Number(c.value2);
    switch (op) {
      case 'eq': return n === a;
      case 'ne': return n !== a;
      case 'gt': return n > a;
      case 'gte': return n >= a;
      case 'lt': return n < a;
      case 'lte': return n <= a;
      case 'between': return n >= Math.min(a, b) && n <= Math.max(a, b);
      default: return false;
    }
  }
  if (type === 'select') {
    const list = Array.isArray(c.value) ? c.value : [c.value];
    if (op === 'in') return !empty && list.includes(v);
    if (op === 'notin') return empty || !list.includes(v);
    return false;
  }
  if (type === 'date') {
    if (empty) return false;
    const s = String(v).slice(0, 10);
    if (op === 'before') return s < c.value;
    if (op === 'after') return s > c.value;
    if (op === 'on') return s === c.value;
    if (op === 'between') return s >= c.value && s <= c.value2;
    return false;
  }
  // text
  const s = empty ? '' : String(v).toLowerCase();
  const q = str(c.value).toLowerCase();
  switch (op) {
    case 'contains': return s.includes(q);
    case 'notcontains': return !s.includes(q);
    case 'equals': return s === q;
    case 'startswith': return s.startsWith(q);
    default: return false;
  }
}

module.exports = { Service, AppError, evalCondition, ageFrom, today, ROLES, ARCHIVE_REASONS, CRITERION_TYPES };

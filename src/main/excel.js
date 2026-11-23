'use strict';
// Excel import / export of families and members.

const XLSX = require('xlsx');
const { AppError } = require('./service');

// Built-in columns. Header labels are given in all three languages so an import file
// can use any of them (or the internal key).
const FAMILY_COLS = [
  { key: 'file_no', ar: 'رقم الملف', en: 'File No', hy: 'Գործի համար' },
  { key: 'head_name', ar: 'اسم رب الأسرة', en: 'Head of family', hy: 'Ընտանիքի ղեկավար' },
  { key: 'head_national_id', ar: 'الرقم الوطني', en: 'National ID', hy: 'Ազգային համար' },
  { key: 'head_birth_date', ar: 'تاريخ الميلاد', en: 'Birth date', hy: 'Ծննդյան ամսաթիվ' },
  { key: 'head_gender', ar: 'الجنس', en: 'Gender', hy: 'Սեռ' },
  { key: 'phone', ar: 'الهاتف', en: 'Phone', hy: 'Հեռախոս' },
  { key: 'area', ar: 'المنطقة', en: 'Area', hy: 'Տարածք' },
  { key: 'address', ar: 'العنوان', en: 'Address', hy: 'Հասցե' },
  { key: 'notes', ar: 'ملاحظات', en: 'Notes', hy: 'Նշումներ' },
];

const MEMBER_COLS = [
  { key: 'file_no', ar: 'رقم الملف', en: 'File No', hy: 'Գործի համար' },
  { key: 'full_name', ar: 'الاسم الكامل', en: 'Full name', hy: 'Անուն ազգանուն' },
  { key: 'national_id', ar: 'الرقم الوطني', en: 'National ID', hy: 'Ազգային համար' },
  { key: 'birth_date', ar: 'تاريخ الميلاد', en: 'Birth date', hy: 'Ծննդյան ամսաթիվ' },
  { key: 'gender', ar: 'الجنس', en: 'Gender', hy: 'Սեռ' },
  { key: 'relation', ar: 'صلة القرابة', en: 'Relation', hy: 'Ազգակցություն' },
  { key: 'has_disability', ar: 'إعاقة', en: 'Disability', hy: 'Հաշմանդամություն' },
  { key: 'chronic_illness', ar: 'مرض مزمن', en: 'Chronic illness', hy: 'Քրոնիկ հիվանդություն' },
  { key: 'occupation', ar: 'العمل/الدراسة', en: 'Occupation', hy: 'Զբաղմունք' },
  { key: 'notes', ar: 'ملاحظات', en: 'Notes', hy: 'Նշումներ' },
];

const SHEET_FAMILIES = { ar: 'العائلات', en: 'Families', hy: 'Ընտանիքներ' };
const SHEET_MEMBERS = { ar: 'الأفراد', en: 'Members', hy: 'Անդամներ' };

const YES = ['1', 'yes', 'y', 'true', 'نعم', 'Այո', 'այո', 'x', '✓'];
const GENDER = { m: ['m', 'male', 'ذكر', 'Արական', 'արական'], f: ['f', 'female', 'أنثى', 'انثى', 'Իգական', 'իգական'] };

function norm(s) { return String(s === undefined || s === null ? '' : s).trim().toLowerCase(); }

function criterionLabel(c, lang) { return c[`label_${lang}`] || c.label_ar || c.label_en || c.label_hy || c.key; }
function optionLabel(o, lang) { return o[`label_${lang}`] || o.label_ar || o.label_en || o.label_hy || o.value; }

function genderLabel(g, lang) {
  if (g === 'm') return { ar: 'ذكر', en: 'Male', hy: 'Արական' }[lang];
  if (g === 'f') return { ar: 'أنثى', en: 'Female', hy: 'Իգական' }[lang];
  return '';
}
function yesLabel(v, lang) { return v ? { ar: 'نعم', en: 'Yes', hy: 'Այո' }[lang] : { ar: 'لا', en: 'No', hy: 'Ոչ' }[lang]; }

function parseGender(v) {
  const n = norm(v);
  if (GENDER.m.map(norm).includes(n)) return 'm';
  if (GENDER.f.map(norm).includes(n)) return 'f';
  return '';
}

function parseDate(v) {
  if (v === undefined || v === null || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
}

function familyRows(service, ids, lang) {
  const criteria = service.listCriteria(false);
  const famHeader = [...FAMILY_COLS.map(c => c[lang]), ...criteria.map(c => criterionLabel(c, lang)),
    { ar: 'عدد الأفراد', en: 'Members', hy: 'Անդամների թիվ' }[lang], { ar: 'النقاط', en: 'Score', hy: 'Միավորներ' }[lang]];
  const fam = [famHeader];
  const mem = [MEMBER_COLS.map(c => c[lang])];
  const rowsById = new Map(service.buildRows('active').concat(service.buildRows('archived')).map(r => [r.id, r]));
  for (const id of ids) {
    const f = service.getFamily(id);
    const r = rowsById.get(id) || {};
    fam.push([
      f.file_no, f.head_name, f.head_national_id, f.head_birth_date, genderLabel(f.head_gender, lang), f.phone, f.area, f.address, f.notes,
      ...criteria.map(c => {
        const v = f.custom[c.key];
        if (v === undefined || v === null) return '';
        if (c.type === 'yesno') return yesLabel(v, lang);
        if (c.type === 'select') { const o = c.options.find(x => x.value === v); return o ? optionLabel(o, lang) : v; }
        return v;
      }),
      r.members_count, r.score,
    ]);
    for (const m of f.members) {
      mem.push([f.file_no, m.full_name, m.national_id, m.birth_date, genderLabel(m.gender, lang), m.relation,
        yesLabel(m.has_disability, lang), yesLabel(m.chronic_illness, lang), m.occupation, m.notes]);
    }
  }
  return { fam, mem };
}

function exportFamilies(service, ids, file, lang = 'ar') {
  const { fam, mem } = familyRows(service, ids, lang);
  const wb = XLSX.utils.book_new();
  if (lang === 'ar') wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fam), SHEET_FAMILIES[lang]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mem), SHEET_MEMBERS[lang]);
  XLSX.writeFile(wb, file);
  return { families: fam.length - 1, members: mem.length - 1 };
}

function exportTemplate(service, file, lang = 'ar') {
  const criteria = service.listCriteria(false);
  const wb = XLSX.utils.book_new();
  if (lang === 'ar') wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[...FAMILY_COLS.map(c => c[lang]), ...criteria.map(c => criterionLabel(c, lang))]]), SHEET_FAMILIES[lang]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([MEMBER_COLS.map(c => c[lang])]), SHEET_MEMBERS[lang]);
  XLSX.writeFile(wb, file);
}

function exportTable(rows, header, file, sheetName, rtl) {
  const wb = XLSX.utils.book_new();
  if (rtl) wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), sheetName.slice(0, 31));
  XLSX.writeFile(wb, file);
}

function findSheet(wb, names) {
  const all = Object.values(names).map(norm);
  const n = wb.SheetNames.find(s => all.includes(norm(s)));
  return n ? wb.Sheets[n] : null;
}

function matchColumns(header, cols, criteria) {
  // returns array: index -> {kind:'base'|'crit', key, criterion}
  return header.map(h => {
    const n = norm(h);
    if (!n) return null;
    const b = cols.find(c => [c.key, c.ar, c.en, c.hy].map(norm).includes(n));
    if (b) return { kind: 'base', key: b.key };
    const c = (criteria || []).find(x => [x.key, x.label_ar, x.label_en, x.label_hy].map(norm).includes(n));
    if (c) return { kind: 'crit', key: c.key, criterion: c };
    return null;
  });
}

function parseCriterionValue(c, v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (c.type === 'yesno') return YES.map(norm).includes(norm(v));
  if (c.type === 'number') { const n = Number(v); return Number.isNaN(n) ? undefined : n; }
  if (c.type === 'date') return parseDate(v);
  if (c.type === 'select') {
    const o = c.options.find(x => [x.value, x.label_ar, x.label_en, x.label_hy].map(norm).includes(norm(v)));
    return o ? o.value : undefined;
  }
  return String(v);
}

/**
 * Imports families (and optional members sheet). Families with an existing file number are updated,
 * others are created. Returns a summary.
 */
function importFamilies(service, file) {
  service.require('editor');
  const wb = XLSX.readFile(file, { cellDates: true });
  const famSheet = findSheet(wb, SHEET_FAMILIES) || wb.Sheets[wb.SheetNames[0]];
  const memSheet = findSheet(wb, SHEET_MEMBERS) || (wb.SheetNames[1] ? wb.Sheets[wb.SheetNames[1]] : null);
  if (!famSheet) throw new AppError('empty_file');
  const criteria = service.listCriteria(false);
  const famRows = XLSX.utils.sheet_to_json(famSheet, { header: 1, defval: '', raw: true });
  if (famRows.length < 2) throw new AppError('empty_file');
  const map = matchColumns(famRows[0], FAMILY_COLS, criteria);
  if (!map.some(m => m && m.key === 'head_name')) throw new AppError('missing_head_name_column');

  const membersByFile = new Map();
  if (memSheet) {
    const mRows = XLSX.utils.sheet_to_json(memSheet, { header: 1, defval: '', raw: true });
    if (mRows.length > 1) {
      const mMap = matchColumns(mRows[0], MEMBER_COLS, []);
      for (const row of mRows.slice(1)) {
        const m = {};
        mMap.forEach((col, i) => { if (col) m[col.key] = row[i]; });
        if (!String(m.full_name || '').trim() || !String(m.file_no || '').trim()) continue;
        m.gender = parseGender(m.gender);
        m.birth_date = parseDate(m.birth_date);
        m.has_disability = YES.map(norm).includes(norm(m.has_disability));
        m.chronic_illness = YES.map(norm).includes(norm(m.chronic_illness));
        const k = String(m.file_no).trim();
        if (!membersByFile.has(k)) membersByFile.set(k, []);
        membersByFile.get(k).push(m);
      }
    }
  }

  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  famRows.slice(1).forEach((row, idx) => {
    const f = { custom: {} };
    map.forEach((col, i) => {
      if (!col) return;
      if (col.kind === 'base') f[col.key] = row[i];
      else {
        const v = parseCriterionValue(col.criterion, row[i]);
        if (v !== undefined) f.custom[col.key] = v;
      }
    });
    if (!String(f.head_name || '').trim()) { result.skipped++; return; }
    f.file_no = String(f.file_no || '').trim();
    f.head_gender = parseGender(f.head_gender);
    f.head_birth_date = parseDate(f.head_birth_date);
    for (const k of ['head_national_id', 'phone']) if (f[k] !== undefined) f[k] = String(f[k]);
    try {
      if (f.file_no) {
        const ex = service.db.get('SELECT id FROM families WHERE file_no = ?', [f.file_no]);
        if (ex) {
          const old = service.getFamily(ex.id);
          const merged = { ...old, ...f, id: ex.id, custom: { ...old.custom, ...f.custom } };
          merged.members = membersByFile.has(f.file_no) ? membersByFile.get(f.file_no) : old.members;
          service.saveFamily(merged);
          result.updated++;
          return;
        }
      }
      f.members = f.file_no ? (membersByFile.get(f.file_no) || []) : [];
      service.saveFamily(f);
      result.created++;
    } catch (e) {
      result.errors.push({ row: idx + 2, code: e.code || e.message, extra: e.extra });
    }
  });
  return result;
}

module.exports = { exportFamilies, exportTemplate, importFamilies, exportTable, parseDate, parseGender };

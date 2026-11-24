'use strict';
/* global I18N */
(function () {
  const { t, pick } = I18N;

  // ================================================================ helpers
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'selected') el.selected = !!v;
        else if (k === 'disabled') el.disabled = !!v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    appendChildren(el, children);
    return el;
  }
  function appendChildren(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function toast(msg, kind) {
    const el = h('div', { class: `toast ${kind || ''}` }, msg);
    document.getElementById('toast-root').appendChild(el);
    setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3000);
  }

  function errText(r) {
    const key = `err.${r.code}`;
    const s = t(key, { extra: r.extra });
    return s === key ? t('err.unexpected_error', { extra: r.code }) : s;
  }

  async function api(method, ...args) {
    const r = await window.api.svc(method, ...args);
    if (!r.ok) { if (r.code === 'not_logged_in') { lock(); } throw r; }
    return r.data;
  }
  async function call(channel, ...args) {
    const r = await window.api.call(channel, ...args);
    if (!r.ok) throw r;
    return r.data;
  }
  /** Runs fn, shows an error toast on failure. Returns result or undefined. */
  async function safe(fn) {
    try { return await fn(); } catch (e) {
      if (e && e.code) toast(errText(e), 'error'); else { console.error(e); toast(t('err.unexpected_error', { extra: e && e.message }), 'error'); }
      return undefined;
    }
  }

  function modal(title, body, buttons, opts = {}) {
    return new Promise(resolve => {
      const root = document.getElementById('modal-root');
      const close = v => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape' && !opts.noEscape) close(null); };
      document.addEventListener('keydown', onKey);
      const footer = h('footer', null, (buttons || [{ label: t('close'), value: null }]).map(b =>
        h('button', {
          class: `btn ${b.kind || ''}`, type: 'button',
          onclick: async () => {
            if (b.onClick) { const r = await b.onClick(); if (r === false) return; close(r === undefined ? b.value : r); } else close(b.value);
          },
        }, b.label)));
      const bg = h('div', { class: 'modal-bg' },
        h('div', { class: `modal ${opts.wide ? 'wide' : ''}` }, h('header', null, title), h('div', { class: 'body' }, body), footer));
      root.appendChild(bg);
      const first = bg.querySelector('input:not([type=checkbox]), select, textarea');
      if (first) first.focus();
    });
  }

  function confirmDialog(msg, danger) {
    return modal(t('confirm'), h('p', null, msg), [
      { label: t('cancel'), value: false },
      { label: t('confirm'), value: true, kind: danger ? 'danger' : 'primary' },
    ]).then(v => !!v);
  }

  function promptDialog(title, label, value) {
    const input = h('input', { type: 'text', value: value || '' });
    return modal(title, h('label', { class: 'field' }, label, input), [
      { label: t('cancel'), value: null },
      { label: t('save'), kind: 'primary', onClick: () => input.value.trim() || false },
    ]);
  }

  function field(label, input, required) {
    return h('label', { class: 'field' }, h('span', { class: required ? 'req' : '' }, label), input);
  }

  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function ageOf(birth) {
    if (!birth) return '';
    const m = /^(\d{4})(?:-(\d{1,2})-(\d{1,2}))?/.exec(birth);
    if (!m) return '';
    const now = new Date();
    const b = new Date(Number(m[1]), Number(m[2] || 1) - 1, Number(m[3] || 1));
    let a = now.getFullYear() - b.getFullYear();
    if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a--;
    return a >= 0 ? a : '';
  }

  const fmtNum = n => (n === null || n === undefined || n === '') ? '' : Number(n).toLocaleString('en-US');

  // ================================================================ state
  const state = {
    user: null,
    settings: {},
    view: 'dashboard',
    params: {},
    filter: { search: '', match: 'all', conditions: [], sort: { field: 'score', dir: 'desc' } },
    selected: new Set(),
    dirty: false,
  };
  const app = document.getElementById('app');

  const NAV = [
    { id: 'dashboard', ico: '⌂', role: 'viewer' },
    { id: 'families', ico: '👪', role: 'viewer' },
    { id: 'distributions', ico: '🎁', role: 'viewer' },
    { id: 'archive', ico: '🗄', role: 'viewer' },
    { id: 'criteria', ico: '☑', role: 'admin' },
    { id: 'aid_types', ico: '🏷', role: 'admin' },
    { id: 'users', ico: '👤', role: 'admin' },
    { id: 'backup', ico: '💾', role: 'admin' },
    { id: 'settings', ico: '⚙', role: 'admin' },
    { id: 'audit', ico: '📜', role: 'admin' },
  ];
  const RANK = { viewer: 0, editor: 1, admin: 2 };
  const can = role => state.user && RANK[state.user.role] >= RANK[role];

  // ================================================================ boot
  async function boot() {
    const s = await call('settings:get');
    state.settings = s;
    I18N.setLang(s.lang || 'ar');
    const cur = await api('currentUser').catch(() => null);
    if (cur) { state.user = cur; renderShell(); } else renderLogin();
  }

  async function setLang(l) {
    await call('settings:setLang', l);
    state.settings.lang = l;
    I18N.setLang(l);
    if (state.user) renderShell(); else renderLogin();
  }

  // ================================================================ login
  function renderLogin(message) {
    clear(app);
    document.title = t('app_title');
    const user = h('input', { type: 'text', autocomplete: 'username' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password' });
    const err = h('div', { class: 'alert danger hidden' });
    const form = h('form', {
      onsubmit: async e => {
        e.preventDefault();
        err.classList.add('hidden');
        try {
          state.user = await api('login', user.value, pass.value);
          if (state.user.must_change_password) {
            const ok = await changePasswordDialog(true);
            if (!ok) { await api('logout'); state.user = null; return renderLogin(); }
          }
          if (state.user.recovery_key) await showRecoveryKey(state.user.recovery_key);
          if (state.user.migrated) {
            await modal(t('enc.title'), h('div', null,
              h('div', { class: 'alert info' }, t('enc.migrated')),
              state.user.pending_reset && state.user.pending_reset.length ? h('div', { class: 'alert warn' }, t('enc.pending', { names: state.user.pending_reset.join('، ') })) : null));
          }
          state.view = 'dashboard';
          renderShell();
        } catch (r) {
          err.textContent = errText(r);
          err.classList.remove('hidden');
          pass.select();
        }
      },
    },
    message ? h('div', { class: 'alert info' }, message) : null,
    err,
    field(t('username'), user),
    field(t('password'), pass),
    h('button', { class: 'btn primary', type: 'submit', style: { justifyContent: 'center', padding: '10px' } }, t('sign_in')),
    h('button', { class: 'btn link', type: 'button', onclick: () => recoverDialog() }, t('rec.forgot')));

    app.appendChild(h('div', { class: 'login-wrap' },
      h('div', { class: 'login-card' },
        h('h1', null, t('app_title')),
        h('div', { class: 'sub' }, state.settings.org_name || t('app_subtitle')),
        form,
        h('div', { class: 'langs' }, Object.entries(I18N.LANG_NAMES).map(([k, n]) =>
          h('button', { type: 'button', class: I18N.lang === k ? 'active' : '', onclick: () => setLang(k) }, n))))));
    user.focus();
  }

  async function showRecoveryKey(key) {
    const check = h('input', { type: 'checkbox' });
    const keyBox = h('div', { class: 'recovery-key', id: 'recovery-key-text' }, key);
    const body = h('div', null,
      h('div', { class: 'alert warn' }, t('rec.explain')),
      keyBox,
      h('div', { class: 'toolbar', style: { justifyContent: 'center', marginBottom: '14px' } },
        h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(key); toast(t('rec.copied'), 'ok'); } catch (_) { /* ignore */ } } }, '📋 ', t('rec.copy')),
        h('button', { class: 'btn', onclick: () => safe(() => call('auth:saveRecoveryFile', key)) }, '💾 ', t('rec.save_file')),
        h('button', {
          class: 'btn', onclick: () => {
            const area = h('div', { class: 'print-key' }, h('h2', null, `${t('app_title')} — ${t('rec.title')}`), h('div', { class: 'recovery-key' }, key), h('p', null, t('rec.explain')), h('p', null, todayStr()));
            document.body.appendChild(area); document.body.classList.add('printing-key');
            setTimeout(() => { window.print(); document.body.classList.remove('printing-key'); area.remove(); }, 50);
          },
        }, '🖨 ', t('print'))),
      h('label', { class: 'check' }, check, t('rec.saved_check')));
    await modal(t('rec.title'), body, [{
      label: t('confirm'), kind: 'primary', onClick: async () => {
        if (!check.checked) { check.parentElement.style.color = 'var(--danger)'; return false; }
        await safe(() => call('auth:confirmRecovery'));
        return true;
      },
    }], { noEscape: true });
  }

  async function recoverDialog() {
    const key = h('input', { type: 'text', placeholder: 'XXXXX-XXXXX-…', style: { fontFamily: 'monospace', direction: 'ltr' } });
    const user = h('input', { type: 'text', value: 'admin' });
    const newP = h('input', { type: 'password' });
    const conf = h('input', { type: 'password' });
    const r = await modal(t('rec.forgot'), h('div', { class: 'grid' },
      field(t('rec.enter_key'), key, true), field(t('rec.reset_for'), user, true),
      field(t('user.new_password'), newP, true), field(t('user.confirm_password'), conf, true)), [
      { label: t('cancel'), value: null },
      {
        label: t('save'), kind: 'primary', onClick: async () => {
          if (newP.value !== conf.value) { toast(t('err.passwords_mismatch'), 'error'); return false; }
          const u = await safe(() => call('auth:recover', key.value, user.value, newP.value));
          return u || false;
        },
      },
    ]);
    if (r) {
      toast(t('rec.done'), 'ok');
      state.user = r;
      if (r.role === 'admin') {
        const k = await safe(() => call('auth:newRecoveryKey'));
        if (k) await showRecoveryKey(k);
      }
      state.view = 'dashboard';
      renderShell();
    }
  }

  async function changePasswordDialog(forced) {
    const oldP = h('input', { type: 'password' });
    const newP = h('input', { type: 'password' });
    const conf = h('input', { type: 'password' });
    const body = h('div', { class: 'grid' },
      forced ? h('div', { class: 'alert warn' }, t('user.must_change')) : null,
      field(t('user.old_password'), oldP), field(t('user.new_password'), newP), field(t('user.confirm_password'), conf));
    return modal(t('user.change_password'), body, [
      { label: t('cancel'), value: false },
      {
        label: t('save'), kind: 'primary', onClick: async () => {
          if (newP.value !== conf.value) { toast(t('err.passwords_mismatch'), 'error'); return false; }
          const r = await safe(() => api('changePassword', oldP.value, newP.value));
          if (!r) return false;
          toast(t('saved'), 'ok');
          return true;
        },
      },
    ]);
  }

  async function lock(message) {
    await window.api.svc('logout');
    state.user = null;
    state.selected.clear();
    document.getElementById('modal-root').innerHTML = '';
    renderLogin(message);
  }

  // auto-lock after inactivity
  let lastActivity = Date.now();
  ['mousemove', 'keydown', 'mousedown', 'wheel'].forEach(ev => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
  setInterval(() => {
    const mins = Number(state.settings.auto_lock_minutes || 0);
    if (state.user && mins > 0 && Date.now() - lastActivity > mins * 60000) lock();
  }, 30000);

  // ================================================================ shell
  async function navigate(view, params) {
    if (state.dirty && !(await confirmDialog(t('family.unsaved')))) return;
    state.dirty = false;
    state.view = view;
    state.params = params || {};
    renderShell();
  }

  function renderShell() {
    clear(app);
    document.title = `${t('app_title')}${state.settings.org_name ? ' — ' + state.settings.org_name : ''}`;
    const main = h('main', { class: 'main' });
    const langSel = h('select', { onchange: e => setLang(e.target.value) },
      Object.entries(I18N.LANG_NAMES).map(([k, n]) => h('option', { value: k, selected: I18N.lang === k }, n)));
    const activeNav = state.view === 'family' ? 'families' : state.view;
    const sidebar = h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, t('app_title'), state.settings.org_name ? h('small', null, state.settings.org_name) : null),
      h('nav', null, NAV.filter(n => can(n.role)).map(n =>
        h('button', { class: activeNav === n.id ? 'active' : '', onclick: () => navigate(n.id) },
          h('span', { class: 'ico' }, n.ico), t(`nav.${n.id}`)))),
      h('div', { class: 'user-box' },
        h('div', null, '👤 ', state.user.full_name || state.user.username, ' ', h('span', { class: 'badge' }, t(`role.${state.user.role}`))),
        h('div', { class: 'row' },
          langSel,
          h('button', { onclick: () => changePasswordDialog(false) }, t('user.change_password')),
          h('button', { onclick: () => lock() }, t('logout')))));
    app.appendChild(h('div', { class: 'layout' }, sidebar, main));
    const views = { dashboard: viewDashboard, families: viewFamilies, family: viewFamilyForm, archive: viewArchive, distributions: viewDistributions,
      criteria: viewCriteria, aid_types: viewAidTypes, users: viewUsers, backup: viewBackup, settings: viewSettings, audit: viewAudit };
    (views[state.view] || viewDashboard)(main).catch(e => { console.error(e); if (e && e.code) toast(errText(e), 'error'); });
  }

  function pageHead(title, ...actions) {
    return h('div', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'toolbar' }, actions));
  }

  // ================================================================ dashboard
  async function viewDashboard(main) {
    const s = await api('stats');
    const card = (num, lbl, onClick) => h('div', { class: `card ${onClick ? 'clickable' : ''}`, onclick: onClick }, h('div', { class: 'num' }, fmtNum(num)), h('div', { class: 'lbl' }, lbl));
    const quick = (conds) => () => { state.filter = { search: '', match: 'all', conditions: conds, sort: { field: 'score', dir: 'desc' } }; navigate('families'); };
    const archivedTotal = s.archived.reduce((a, b) => a + b.n, 0);
    main.appendChild(pageHead(t('dash.welcome', { name: state.user.full_name || state.user.username }),
      can('editor') ? h('button', { class: 'btn primary', onclick: () => navigate('family', { id: null }) }, '+ ', t('family.new')) : null));
    main.appendChild(h('div', { class: 'cards' },
      card(s.families, t('dash.families'), quick([])),
      card(s.persons, t('dash.persons')),
      card(s.children, t('dash.children'), quick([{ field: 'children_count', op: 'gte', value: 1 }])),
      card(s.elderly, t('dash.elderly'), quick([{ field: 'elderly_count', op: 'gte', value: 1 }])),
      card(s.disabled, t('dash.disabled'), quick([{ field: 'disabled_count', op: 'gte', value: 1 }])),
      card(s.chronic, t('dash.chronic'), quick([{ field: 'chronic_count', op: 'gte', value: 1 }])),
      card(s.femaleHeaded, t('dash.female_headed'), quick([{ field: 'female_head', op: 'yes' }])),
      card(s.neverAided, t('dash.never_aided'), quick([{ field: 'aid_count', op: 'eq', value: 0 }])),
      card(archivedTotal, t('dash.archived'), () => navigate('archive'))));

    const maxArea = Math.max(1, ...s.byArea.map(a => a[1]));
    const areaPanel = h('div', { class: 'panel' }, h('h3', null, t('dash.by_area')),
      s.byArea.length ? s.byArea.slice(0, 15).map(([a, n]) => h('div', { class: 'bar-row' },
        h('div', null, a), h('div', { class: 'bar' }, h('div', { style: { width: `${(n / maxArea) * 100}%` } })), h('div', { class: 'num' }, fmtNum(n))))
        : h('div', { class: 'muted' }, t('none')));

    const distPanel = h('div', { class: 'panel' }, h('h3', null, t('dash.dist_month', { m: s.month })),
      h('table', null, h('tbody', null, s.distMonth.map(d => h('tr', null,
        h('td', null, pick(d, 'name')), h('td', { class: 'num' }, fmtNum(d.n)), h('td', { class: 'num' }, d.total ? `${fmtNum(d.total)} ${d.unit || ''}` : ''))))));

    const critPanel = h('div', { class: 'panel' }, h('h3', null, t('dash.criteria_stats')),
      s.criteriaStats.length ? h('table', null, h('tbody', null, s.criteriaStats.map(c => {
        let detail = '';
        if (c.type === 'yesno') detail = `${t('yes')}: ${fmtNum(c.yes)} / ${fmtNum(c.filled)}`;
        else if (c.type === 'number') detail = `${t('dash.sum')}: ${fmtNum(c.sum)} — ${t('dash.filled')}: ${fmtNum(c.filled)}`;
        else if (c.type === 'select') detail = c.criterion.options.map(o => `${pick(o, 'label')}: ${fmtNum(c.byOption[o.value] || 0)}`).join(' · ');
        else detail = `${t('dash.filled')}: ${fmtNum(c.filled)}`;
        return h('tr', null, h('td', null, pick(c.criterion, 'label')), h('td', null, detail));
      }))) : h('div', { class: 'muted' }, t('family.no_criteria')));

    main.appendChild(h('div', { class: 'grid cols-2' }, areaPanel, h('div', null, distPanel, critPanel)));
  }

  // ================================================================ filter builder
  const OPS = {
    number: ['gte', 'lte', 'eq', 'ne', 'gt', 'lt', 'between', 'empty', 'notempty'],
    text: ['contains', 'equals', 'startswith', 'notcontains', 'empty', 'notempty'],
    yesno: ['yes', 'no'],
    select: ['in', 'notin', 'empty', 'notempty'],
    date: ['after', 'before', 'on', 'between', 'empty', 'notempty'],
  };

  function fieldLabel(f) {
    if (!f) return '';
    if (f.criterion) return pick(f.criterion, 'label');
    if (f.aid) return t(f.i18n, { name: pick(f.aid, 'name') });
    return t(f.i18n);
  }

  function buildFilterBox(fields, onApply) {
    const fmap = new Map(fields.map(f => [f.id, f]));
    const box = h('div', { class: 'panel filter-box no-print' });
    const condWrap = h('div');
    const matchSel = h('select', { onchange: e => { state.filter.match = e.target.value; onApply(); } },
      h('option', { value: 'all', selected: state.filter.match !== 'any' }, t('filter.match_all')),
      h('option', { value: 'any', selected: state.filter.match === 'any' }, t('filter.match_any')));

    function fieldSelect(c) {
      const groups = [
        { label: t('filter.builtin'), items: fields.filter(f => !f.criterion && !f.id.startsWith('days_since_aid') && f.id !== 'aid_count') },
        { label: t('filter.aid'), items: fields.filter(f => f.id.startsWith('days_since_aid') || f.id === 'aid_count') },
        { label: t('filter.custom'), items: fields.filter(f => f.criterion) },
      ];
      return h('select', {
        class: 'field-sel',
        onchange: e => { c.field = e.target.value; const f = fmap.get(c.field); c.op = OPS[f.type][0]; c.value = f.type === 'select' ? [] : ''; c.value2 = ''; renderConds(); onApply(); },
      }, groups.filter(g => g.items.length).map(g => h('optgroup', { label: g.label },
        g.items.map(f => h('option', { value: f.id, selected: f.id === c.field }, fieldLabel(f))))));
    }

    function valueInputs(c, f) {
      const upd = (k) => e => { c[k] = e.target.value; debouncedApply(); };
      if (['empty', 'notempty', 'yes', 'no'].includes(c.op)) return null;
      if (f.type === 'select') {
        const vals = Array.isArray(c.value) ? c.value : [];
        return h('div', { class: 'multi' }, f.criterion.options.map(o => h('label', { class: 'check' },
          h('input', {
            type: 'checkbox', checked: vals.includes(o.value),
            onchange: e => {
              const set = new Set(Array.isArray(c.value) ? c.value : []);
              if (e.target.checked) set.add(o.value); else set.delete(o.value);
              c.value = [...set]; onApply();
            },
          }), pick(o, 'label'))));
      }
      const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text';
      const a = h('input', { type, value: c.value === undefined ? '' : c.value, oninput: upd('value'), style: { width: type === 'number' ? '100px' : '180px' } });
      if (c.op === 'between') {
        const b = h('input', { type, value: c.value2 === undefined ? '' : c.value2, oninput: upd('value2'), style: { width: type === 'number' ? '100px' : '180px' } });
        return [a, h('span', { class: 'muted' }, t('filter.and')), b];
      }
      return a;
    }

    let timer = null;
    const debouncedApply = () => { clearTimeout(timer); timer = setTimeout(onApply, 350); };

    function renderConds() {
      clear(condWrap);
      state.filter.conditions = state.filter.conditions.filter(c => fmap.has(c.field));
      if (!state.filter.conditions.length) condWrap.appendChild(h('div', { class: 'muted small', style: { marginBottom: '8px' } }, t('filter.no_conditions')));
      state.filter.conditions.forEach((c, i) => {
        const f = fmap.get(c.field);
        const opSel = h('select', { onchange: e => { c.op = e.target.value; renderConds(); onApply(); } },
          OPS[f.type].map(o => h('option', { value: o, selected: o === c.op }, t(`op.${o}`))));
        condWrap.appendChild(h('div', { class: 'cond' },
          h('span', { class: 'and' }, i === 0 ? '' : (state.filter.match === 'any' ? '/' : '+')),
          fieldSelect(c), opSel, valueInputs(c, f),
          h('button', { class: 'btn small danger', title: t('delete'), onclick: () => { state.filter.conditions.splice(i, 1); renderConds(); onApply(); } }, '✕')));
      });
    }

    const savedSel = h('select');
    async function loadSaved() {
      const list = await api('listSavedFilters');
      clear(savedSel);
      savedSel.appendChild(h('option', { value: '' }, t('filter.choose_saved')));
      for (const s of list) savedSel.appendChild(h('option', { value: s.id }, s.name));
      savedSel.onchange = () => {
        const s = list.find(x => String(x.id) === savedSel.value);
        if (!s) return;
        state.filter = { search: state.filter.search, match: s.definition.match || 'all', conditions: JSON.parse(JSON.stringify(s.definition.conditions || [])), sort: s.definition.sort || state.filter.sort };
        matchSel.value = state.filter.match;
        renderConds(); onApply();
      };
      delSaved.disabled = !list.length;
      delSaved.onclick = async () => {
        const s = list.find(x => String(x.id) === savedSel.value);
        if (!s || !(await confirmDialog(`${t('delete')}: ${s.name}?`, true))) return;
        await safe(() => api('deleteSavedFilter', s.id)); loadSaved();
      };
    }
    const delSaved = h('button', { class: 'btn small danger', title: t('delete') }, '✕');

    box.appendChild(h('div', { class: 'page-head', style: { marginBottom: '10px' } },
      h('h3', { style: { margin: 0 } }, t('filter.title')),
      h('div', { class: 'toolbar' }, matchSel, savedSel, delSaved)));
    box.appendChild(condWrap);
    box.appendChild(h('div', { class: 'toolbar' },
      h('button', {
        class: 'btn', onclick: () => {
          const f = fields[0];
          state.filter.conditions.push({ field: f.id, op: OPS[f.type][0], value: '' });
          renderConds();
        },
      }, '+ ', t('filter.add')),
      h('button', { class: 'btn', onclick: () => { state.filter.conditions = []; renderConds(); onApply(); } }, t('filter.clear')),
      can('editor') ? h('button', {
        class: 'btn', onclick: async () => {
          const name = await promptDialog(t('filter.save'), t('filter.name'));
          if (!name) return;
          if (await safe(() => api('saveFilter', name, { match: state.filter.match, conditions: state.filter.conditions, sort: state.filter.sort }))) { toast(t('saved'), 'ok'); loadSaved(); }
        },
      }, '💾 ', t('filter.save')) : null));
    renderConds();
    loadSaved();
    return box;
  }

  // ================================================================ families list
  async function viewFamilies(main) {
    const [fields, aidTypes] = await Promise.all([api('filterFields'), api('listAidTypes')]);
    let rows = [];
    main.appendChild(pageHead(t('nav.families'),
      can('editor') ? h('button', { class: 'btn primary', onclick: () => navigate('family', { id: null }) }, '+ ', t('family.new')) : null));

    const search = h('input', {
      type: 'search', placeholder: t('search_ph'), value: state.filter.search, style: { width: '100%', padding: '9px 12px', marginBottom: '12px' },
      oninput: () => { state.filter.search = search.value; clearTimeout(search._t); search._t = setTimeout(apply, 250); },
    });
    main.appendChild(h('div', { class: 'no-print' }, search));
    main.appendChild(buildFilterBox(fields, apply));

    const countEl = h('strong');
    const selEl = h('span', { class: 'muted' });
    const topN = h('input', { type: 'number', min: 1, style: { width: '80px' }, title: t('filter.limit_help') });
    const bar = h('div', { class: 'results-bar' },
      h('div', { class: 'toolbar' }, countEl, selEl,
        h('span', { class: 'muted', title: t('filter.limit_help') }, t('filter.limit')), topN,
        h('button', { class: 'btn small', title: t('filter.limit_help'), onclick: () => { const n = Number(topN.value) || 0; state.selected = new Set(rows.slice(0, n).map(r => r.id)); renderTable(); } }, t('filter.select_top'))),
      h('div', { class: 'toolbar' },
        can('editor') ? h('button', { class: 'btn ok', onclick: () => distributeDialog(rows, aidTypes, apply) }, '🎁 ', t('dist.record')) : null,
        h('button', { class: 'btn', onclick: () => printList(rows) }, '🖨 ', t('dist.print_list')),
        h('button', {
          class: 'btn', onclick: async () => {
            const ids = state.selected.size ? rows.filter(r => state.selected.has(r.id)).map(r => r.id) : rows.map(r => r.id);
            const r = await safe(() => call('excel:exportFamilies', ids, 'families'));
            if (r) toast(t('backup.exported', { file: r.file }), 'ok');
          },
        }, '⬇ ', t('export_excel'))));
    main.appendChild(bar);
    const tableWrap = h('div', { class: 'table-wrap' });
    main.appendChild(tableWrap);
    const printArea = h('div', { class: 'print-only' });
    main.appendChild(printArea);

    const cols = [
      { id: 'file_no', label: t('f.file_no') },
      { id: 'head_name', label: t('f.head_name') },
      { id: 'head_national_id', label: t('f.head_national_id') },
      { id: 'area', label: t('f.area') },
      { id: 'phone', label: t('f.phone') },
      { id: 'members_count', label: t('f.members_count'), num: true },
      { id: 'children_count', label: t('dash.children'), num: true },
      { id: 'score', label: t('f.score'), num: true },
      { id: 'last_aid', label: t('f.last_aid') },
    ];

    function renderTable() {
      clear(tableWrap);
      countEl.textContent = t('filter.results', { n: fmtNum(rows.length) });
      const visibleIds = new Set(rows.map(r => r.id));
      for (const id of [...state.selected]) if (!visibleIds.has(id)) state.selected.delete(id);
      selEl.textContent = state.selected.size ? t('filter.selected', { n: fmtNum(state.selected.size) }) : '';
      if (!rows.length) { tableWrap.appendChild(h('div', { class: 'empty' }, t('none'))); return; }
      const allSel = rows.length > 0 && rows.every(r => state.selected.has(r.id));
      const sortMark = id => state.filter.sort.field === id ? (state.filter.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
      const thead = h('thead', null, h('tr', null,
        h('th', null, h('input', { type: 'checkbox', checked: allSel, title: t('filter.select_all'), onchange: e => { state.selected = e.target.checked ? new Set(rows.map(r => r.id)) : new Set(); renderTable(); } })),
        cols.map(c => h('th', {
          class: `sortable ${c.num ? 'num' : ''}`,
          onclick: () => {
            const s = state.filter.sort;
            state.filter.sort = s.field === c.id ? { field: c.id, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field: c.id, dir: c.num ? 'desc' : 'asc' };
            apply();
          },
        }, c.label + sortMark(c.id))),
        h('th', null, '')));
      const tbody = h('tbody');
      const LIMIT = 1000;
      for (const r of rows.slice(0, LIMIT)) {
        const tr = h('tr', { class: state.selected.has(r.id) ? 'selected' : '' },
          h('td', null, h('input', { type: 'checkbox', checked: state.selected.has(r.id), onchange: e => { if (e.target.checked) state.selected.add(r.id); else state.selected.delete(r.id); renderTable(); } })),
          cols.map(c => h('td', { class: c.num ? 'num' : '' }, c.id === 'last_aid' ? (r.last_aid || h('span', { class: 'badge warn' }, t('never'))) : (c.num ? fmtNum(r[c.id]) : (r[c.id] || '')))),
          h('td', null, h('button', { class: 'btn small', onclick: () => navigate('family', { id: r.id }) }, can('editor') ? t('edit') : t('view'))));
        tr.addEventListener('dblclick', () => navigate('family', { id: r.id }));
        tbody.appendChild(tr);
      }
      tableWrap.appendChild(h('table', null, thead, tbody));
      if (rows.length > LIMIT) tableWrap.appendChild(h('div', { class: 'empty' }, `… ${fmtNum(rows.length - LIMIT)}`));
    }

    async function apply() {
      const r = await safe(() => api('searchFamilies', { ...state.filter, status: 'active' }));
      if (!r) return;
      rows = r;
      renderTable();
    }

    function printList(allRows) {
      const list = state.selected.size ? allRows.filter(r => state.selected.has(r.id)) : allRows;
      clear(printArea);
      printArea.appendChild(h('h2', null, `${state.settings.org_name || t('app_title')} — ${t('dist.print_list')} — ${todayStr()}`));
      printArea.appendChild(h('table', null,
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, t('f.file_no')), h('th', null, t('f.head_name')), h('th', null, t('f.head_national_id')),
          h('th', null, t('f.members_count')), h('th', null, t('f.phone')), h('th', null, t('dist.signature')))),
        h('tbody', null, list.map((r, i) => h('tr', null, h('td', null, i + 1), h('td', null, r.file_no), h('td', null, r.head_name), h('td', null, r.head_national_id || ''),
          h('td', null, r.members_count), h('td', null, r.phone || ''), h('td', { style: { width: '160px' } }, ''))))));
      tableWrap.classList.add('no-print');
      setTimeout(() => { window.print(); }, 50);
    }

    await apply();
  }

  async function distributeDialog(rows, aidTypes, after) {
    const ids = rows.filter(r => state.selected.has(r.id)).map(r => r.id);
    if (!ids.length) { toast(t('err.no_families_selected'), 'error'); return; }
    const active = aidTypes.filter(a => a.active);
    const typeSel = h('select', null, active.map(a => h('option', { value: a.id }, pick(a, 'name') + (a.unit ? ` (${a.unit})` : ''))));
    const amount = h('input', { type: 'number', step: 'any' });
    const date = h('input', { type: 'date', value: todayStr() });
    const notes = h('input', { type: 'text' });
    const body = h('div', { class: 'grid' }, field(t('dist.aid_type'), typeSel, true), field(t('dist.amount'), amount), field(t('dist.date'), date, true), field(t('dist.notes'), notes));
    const r = await modal(t('dist.record_for', { n: fmtNum(ids.length) }), body, [
      { label: t('cancel'), value: null },
      { label: t('save'), kind: 'ok', onClick: () => safe(() => api('recordDistribution', { familyIds: ids, aidTypeId: Number(typeSel.value), amount: amount.value, date: date.value, notes: notes.value })).then(x => x || false) },
    ]);
    if (r) { toast(t('dist.recorded', { n: fmtNum(r.count) }), 'ok'); state.selected.clear(); after(); }
  }

  // ================================================================ family form
  const RELATIONS = ['spouse', 'son', 'daughter', 'father', 'mother', 'brother', 'sister', 'grandchild', 'other'];

  function criterionInput(c, value, onChange) {
    if (c.type === 'yesno') {
      return h('select', { onchange: e => onChange(e.target.value === '' ? '' : e.target.value === 'yes') },
        h('option', { value: '' }, '—'),
        h('option', { value: 'yes', selected: value === true }, t('yes')),
        h('option', { value: 'no', selected: value === false }, t('no')));
    }
    if (c.type === 'select') {
      return h('select', { onchange: e => onChange(e.target.value) },
        h('option', { value: '' }, '—'), c.options.map(o => h('option', { value: o.value, selected: o.value === value }, pick(o, 'label'))));
    }
    const type = c.type === 'number' ? 'number' : c.type === 'date' ? 'date' : 'text';
    return h('input', { type, step: type === 'number' ? 'any' : null, value: value === undefined || value === null ? '' : value, oninput: e => onChange(e.target.value) });
  }

  async function viewFamilyForm(main) {
    const id = state.params.id;
    const readOnly = !can('editor');
    const criteria = await api('listCriteria', false);
    const fam = id ? await api('getFamily', id) : { head_name: '', custom: {}, members: [], distributions: [] };
    const nextNo = id ? null : await api('nextFileNo');
    const f = state.params.draft || JSON.parse(JSON.stringify(fam));
    delete state.params.draft;
    const markDirty = () => { state.dirty = true; };

    const inp = (key, type = 'text') => h('input', { type, value: f[key] || '', disabled: readOnly, oninput: e => { f[key] = e.target.value; markDirty(); } });
    const dupBox = h('div');
    const nidInput = inp('head_national_id');
    nidInput.addEventListener('change', () => checkDup(nidInput.value));
    async function checkDup(nid) {
      clear(dupBox);
      if (!nid) return;
      const found = await safe(() => api('findByNationalId', nid, id || 0));
      if (found && found.length) {
        dupBox.appendChild(h('div', { class: 'alert warn' }, t('family.dup_warning'), ' ',
          found.map(x => h('a', { href: '#', onclick: e => { e.preventDefault(); navigate('family', { id: x.id }); } }, `#${x.file_no} ${x.head_name}${x.status === 'archived' ? ' (' + t('nav.archive') + ')' : ''}`)).reduce((acc, el, i) => (i ? [...acc, ' · ', el] : [el]), [])));
      }
    }
    const genderSel = (val, onChange) => h('select', { disabled: readOnly, onchange: e => { onChange(e.target.value); markDirty(); } },
      h('option', { value: '' }, '—'), ['m', 'f'].map(g => h('option', { value: g, selected: val === g }, t(`gender.${g}`))));

    const title = id ? `${t(readOnly ? 'family.view' : 'family.edit')} — #${fam.file_no}` : t('family.new');
    const saveBtn = readOnly ? null : h('button', { class: 'btn primary', onclick: save }, '💾 ', t('save'));
    main.appendChild(pageHead(title,
      readOnly ? null : h('button', {
        class: 'btn', onclick: async () => {
          const r = await scanIdDialog();
          if (!r) return;
          const d = r.fields;
          // a partial read (scanner dropped the Arabic letters) must not erase what was typed already
          const keep = (v, old) => (v ? v : old);
          if (r.target === 'head') {
            Object.assign(f, {
              head_name: keep(d.full_name, f.head_name), head_national_id: d.national_id, head_birth_date: keep(d.birth_date, f.head_birth_date),
              head_father_name: keep(d.father_name, f.head_father_name), head_mother_name: keep(d.mother_name, f.head_mother_name),
              head_birth_place: keep(d.birth_place, f.head_birth_place),
            });
          } else {
            f.members.push({ full_name: d.full_name, national_id: d.national_id, birth_date: d.birth_date, father_name: d.father_name,
              mother_name: d.mother_name, birth_place: d.birth_place, has_disability: false, chronic_illness: false });
          }
          state.dirty = true;
          state.params = { ...state.params, draft: f };
          toast(d.partial ? t('id.partial_filled') : t('id.filled'), d.partial ? '' : 'ok');
          renderShell();
        },
      }, '🪪 ', t('family.scan_id')),
      id && !readOnly ? h('button', { class: 'btn danger', onclick: () => archiveDialog(id) }, '🗄 ', t('family.archive')) : null,
      h('button', { class: 'btn', onclick: () => navigate('families') }, t('cancel')),
      saveBtn));

    if (fam.status === 'archived') {
      main.appendChild(h('div', { class: 'alert warn' }, `${t('nav.archive')}: ${t(`reason.${fam.archive_reason}`)} — ${fam.archive_date || ''} ${fam.archive_notes || ''}`));
    }

    // --- head of family
    const fileNo = h('input', { type: 'text', value: f.file_no || '', placeholder: nextNo ? `${nextNo} (${t('family.auto_file_no')})` : '', disabled: readOnly, oninput: e => { f.file_no = e.target.value; markDirty(); } });
    main.appendChild(h('div', { class: 'panel' }, h('h2', null, t('family.basic')), dupBox,
      h('div', { class: 'grid cols-4' },
        field(t('f.file_no'), fileNo),
        field(t('f.head_name'), inp('head_name'), true),
        field(t('f.head_national_id'), nidInput),
        field(t('f.head_birth_date'), inp('head_birth_date', 'date')),
        field(t('f.head_birth_place'), inp('head_birth_place')),
        field(t('f.head_father_name'), inp('head_father_name')),
        field(t('f.head_mother_name'), inp('head_mother_name')),
        field(t('f.head_gender'), genderSel(f.head_gender, v => { f.head_gender = v; })),
        field(t('f.phone'), inp('phone')),
        field(t('f.area'), inp('area')),
        field(t('f.address'), inp('address'))),
      h('div', { style: { marginTop: '12px' } }, field(t('f.notes'), h('textarea', { disabled: readOnly, oninput: e => { f.notes = e.target.value; markDirty(); } }, f.notes || '')))));

    // --- criteria
    const critPanel = h('div', { class: 'panel' }, h('h2', null, t('family.criteria')));
    if (!criteria.length) critPanel.appendChild(h('div', { class: 'muted' }, t('family.no_criteria')));
    else {
      critPanel.appendChild(h('div', { class: 'grid cols-3' }, criteria.map(c => {
        const el = criterionInput(c, f.custom[c.key], v => { f.custom[c.key] = v; markDirty(); });
        el.disabled = readOnly;
        return field(pick(c, 'label'), el, c.required);
      })));
    }
    main.appendChild(critPanel);

    // --- members
    const memWrap = h('div', { class: 'table-wrap' });
    function renderMembers() {
      clear(memWrap);
      const thead = h('thead', null, h('tr', null,
        ['m.full_name', 'm.national_id', 'm.birth_date', 'm.age', 'm.gender', 'm.relation', 'm.has_disability', 'm.chronic_illness', 'm.occupation', 'm.father_name', 'm.mother_name', 'm.birth_place'].map(k => h('th', null, t(k))), h('th', null, '')));
      const tbody = h('tbody', null, f.members.map((m, i) => {
        const txt = (k, type = 'text') => h('input', { type, value: m[k] || '', disabled: readOnly, oninput: e => { m[k] = e.target.value; markDirty(); if (k === 'birth_date') ageCell.textContent = ageOf(m[k]); } });
        const chk = k => h('input', { type: 'checkbox', checked: m[k], disabled: readOnly, onchange: e => { m[k] = e.target.checked; markDirty(); } });
        const ageCell = h('td', { class: 'num' }, ageOf(m.birth_date));
        const nid = txt('national_id');
        nid.addEventListener('change', () => checkDup(nid.value));
        return h('tr', null,
          h('td', null, txt('full_name')), h('td', null, nid), h('td', null, txt('birth_date', 'date')), ageCell,
          h('td', null, genderSel(m.gender, v => { m.gender = v; })),
          h('td', null, h('select', { disabled: readOnly, onchange: e => { m.relation = e.target.value; markDirty(); } }, h('option', { value: '' }, '—'),
            RELATIONS.map(r => h('option', { value: r, selected: m.relation === r }, t(`rel.${r}`))))),
          h('td', null, chk('has_disability')), h('td', null, chk('chronic_illness')), h('td', null, txt('occupation')),
          h('td', null, txt('father_name')), h('td', null, txt('mother_name')), h('td', null, txt('birth_place')),
          h('td', null, readOnly ? null : h('button', { class: 'btn small danger', onclick: () => { f.members.splice(i, 1); markDirty(); renderMembers(); } }, '✕')));
      }));
      memWrap.appendChild(h('table', null, thead, tbody));
      if (!f.members.length) memWrap.appendChild(h('div', { class: 'empty' }, t('none')));
    }
    renderMembers();
    main.appendChild(h('div', { class: 'panel' },
      h('div', { class: 'page-head', style: { marginBottom: '10px' } }, h('h2', { style: { margin: 0 } }, `${t('m.title')} (${f.members.length + 1})`),
        readOnly ? null : h('button', { class: 'btn', onclick: () => { f.members.push({ full_name: '', has_disability: false, chronic_illness: false }); markDirty(); renderMembers(); const ins = memWrap.querySelectorAll('tbody tr:last-child input'); if (ins[0]) ins[0].focus(); } }, '+ ', t('m.add'))),
      memWrap));

    // --- aid history
    if (id) {
      main.appendChild(h('div', { class: 'panel' }, h('h2', null, t('family.history')),
        fam.distributions.length ? h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, t('dist.date')), h('th', null, t('dist.aid_type')), h('th', { class: 'num' }, t('dist.amount')), h('th', null, t('dist.notes')), h('th', null, t('dist.by')), h('th', null, ''))),
          h('tbody', null, fam.distributions.map(d => h('tr', null, h('td', null, d.date), h('td', null, pick(d, 'name')), h('td', { class: 'num' }, d.amount !== null ? `${fmtNum(d.amount)} ${d.unit || ''}` : ''),
            h('td', null, d.notes || ''), h('td', null, d.created_by || ''),
            h('td', null, readOnly ? null : h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog(t('are_you_sure'), true) && await safe(() => api('deleteDistribution', d.id))) renderShell(); } }, '✕')))))))
          : h('div', { class: 'muted' }, t('none'))));
    }

    async function save() {
      saveBtn.disabled = true;
      const newId = await safe(() => api('saveFamily', f));
      saveBtn.disabled = false;
      if (newId) {
        state.dirty = false;
        toast(t('saved'), 'ok');
        state.params = { id: newId };
        renderShell();
      }
    }

    // Ctrl+S saves
    main.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && saveBtn) { e.preventDefault(); save(); } });
  }

  // ---------------------------------------------------------------- ID card reading
  // Scanner in COM mode: kept connected while the program runs.
  const serial = { port: null, handler: null };

  async function serialConnect() {
    if (!('serial' in navigator)) throw { code: 'serial_unsupported' };
    if (serial.port) return;
    const granted = await navigator.serial.getPorts();
    const port = granted[0] || await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    serial.port = port;
    serialReadLoop(port);
  }

  async function serialReadLoop(port) {
    let buf = []; let timer = null;
    try {
      while (port.readable) {
        const reader = port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const b of value) buf.push(b);
            clearTimeout(timer);
            // a scan arrives in several chunks: wait for a short pause, then parse everything
            timer = setTimeout(() => { const bytes = buf; buf = []; if (serial.handler) serial.handler(bytes); }, 250);
          }
        } finally { reader.releaseLock(); }
      }
    } catch (_) { /* unplugged */ }
    serial.port = null;
    try { await port.close(); } catch (_) { /* ignore */ }
  }

  function scanIdDialog() {
    return new Promise(resolve => {
      let result = null;
      const resultBox = h('div');
      const status = h('div', { class: 'muted small', style: { minHeight: '18px' } });
      const capture = h('textarea', { class: 'scan-capture', placeholder: t('id.waiting'), rows: 2, spellcheck: 'false' });
      let timer = null;

      async function handle(promise) {
        status.textContent = t('id.reading');
        try {
          const fields = await promise;
          if (!fields) { status.textContent = ''; return; }
          result = fields;
          status.textContent = '';
          showResult(fields);
        } catch (e) {
          status.textContent = '';
          toast(errText(e), 'error');
        }
      }

      async function showResult(d) {
        clear(resultBox);
        const dups = await safe(() => api('findByNationalId', d.national_id, state.params.id || 0)) || [];
        const row = (k, v) => h('tr', null, h('th', { style: { width: '35%' } }, t(k)), h('td', null, v || '—'));
        resultBox.appendChild(h('div', { class: 'panel', style: { marginTop: '12px', marginBottom: 0 } },
          h('h3', null, d.partial ? '⚠️ ' : '✅ ', t('id.result')),
          d.partial ? h('div', { class: 'alert warn' }, t('id.partial')) : null,
          dups.length ? h('div', { class: 'alert warn' }, t('family.dup_warning'), ' ', dups.map(x => `#${x.file_no} ${x.head_name}`).join(' · ')) : null,
          h('table', null, h('tbody', null,
            row('id.first_name', d.first_name), row('id.family_name', d.family_name), row('f.head_father_name', d.father_name),
            row('f.head_mother_name', d.mother_name), row('f.head_birth_place', d.birth_place), row('f.head_birth_date', d.birth_date),
            row('f.head_national_id', d.national_id)))));
        footer.classList.remove('hidden');
      }

      capture.addEventListener('input', () => {
        clearTimeout(timer);
        // scanners "type" very fast; parse after a short pause
        timer = setTimeout(() => {
          const text = capture.value;
          capture.value = '';
          if (text.replace(/\s/g, '').length < 15) return;
          handle(call('id:parseText', text));
        }, 300);
      });

      const comStatus = h('span', { class: 'muted small' }, serial.port ? '🟢 ' + t('id.com_connected') : '');
      serial.handler = bytes => handle(call('id:parseBytes', bytes));

      const body = h('div', null,
        h('div', { class: 'panel', style: { marginBottom: '10px' } },
          h('h3', null, '🔫 ', t('id.scanner')),
          h('p', { class: 'muted small', style: { marginTop: 0 } }, t('id.scanner_hint')),
          capture,
          h('div', { class: 'toolbar', style: { marginTop: '8px' } },
            h('span', { class: 'small' }, t('id.com'), ':'),
            h('button', {
              class: 'btn small', onclick: async () => {
                try { await serialConnect(); comStatus.textContent = '🟢 ' + t('id.com_connected'); } catch (e) { if (e && e.name !== 'NotFoundError') toast(t('err.serial_unsupported'), 'error'); }
                capture.focus();
              },
            }, t('id.com_connect')), comStatus),
          h('div', { class: 'muted small' }, t('id.com_help'))),
        h('div', { class: 'panel', style: { marginBottom: 0 } },
          h('h3', null, '📷 ', t('id.photo')),
          h('p', { class: 'muted small', style: { marginTop: 0 } }, t('id.photo_hint')),
          h('button', { class: 'btn', onclick: () => handle(call('id:fromImage')) }, '🖼 ', t('id.photo_btn'))),
        status,
        resultBox);

      const done = v => { bg.remove(); serial.handler = null; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = e => { if (e.key === 'Escape') done(null); };
      const footer = h('footer', { class: 'hidden' },
        h('button', { class: 'btn', onclick: () => { result = null; clear(resultBox); footer.classList.add('hidden'); capture.focus(); } }, t('id.again')),
        h('button', { class: 'btn', onclick: () => done({ target: 'member', fields: result }) }, '+ ', t('id.add_member')),
        h('button', { class: 'btn primary', onclick: () => done({ target: 'head', fields: result }) }, t('id.fill_head')));
      const bg = h('div', { class: 'modal-bg' }, h('div', { class: 'modal wide' },
        h('header', null, h('div', { class: 'toolbar', style: { justifyContent: 'space-between' } }, t('id.title'), h('button', { class: 'btn small', onclick: () => done(null) }, '✕'))),
        h('div', { class: 'body' }, body), footer));
      document.getElementById('modal-root').appendChild(bg);
      document.addEventListener('keydown', onKey);
      // keep the capture box focused so a keyboard-mode scanner always types into it
      bg.addEventListener('click', e => { if (!e.target.closest('button, input, select, a')) capture.focus(); });
      capture.focus();
    });
  }

  async function archiveDialog(id) {
    const reason = h('select', null, ['death', 'travel', 'other'].map(r => h('option', { value: r }, t(`reason.${r}`))));
    const date = h('input', { type: 'date', value: todayStr() });
    const notes = h('textarea');
    const ok = await modal(t('family.archive'), h('div', { class: 'grid' }, field(t('archive.reason'), reason, true), field(t('archive.date'), date), field(t('archive.notes'), notes)), [
      { label: t('cancel'), value: false },
      { label: t('family.archive'), kind: 'danger', onClick: () => safe(() => api('archiveFamily', id, reason.value, date.value, notes.value)).then(x => x || false) },
    ]);
    if (ok) { state.dirty = false; toast(t('archive.done'), 'ok'); navigate('families'); }
  }

  // ================================================================ archive
  async function viewArchive(main) {
    main.appendChild(pageHead(t('archive.title')));
    const reasonSel = h('select', { onchange: () => load() }, h('option', { value: '' }, t('all')), ['death', 'travel', 'other'].map(r => h('option', { value: r }, t(`reason.${r}`))));
    const search = h('input', { type: 'search', placeholder: t('search_ph'), style: { flex: 1, minWidth: '260px' }, oninput: () => { clearTimeout(search._t); search._t = setTimeout(load, 250); } });
    main.appendChild(h('div', { class: 'toolbar', style: { marginBottom: '12px' } }, search, reasonSel));
    const wrap = h('div', { class: 'table-wrap' });
    main.appendChild(wrap);
    let rows = [];
    async function load() {
      rows = await api('searchFamilies', { status: 'archived', search: search.value, sort: { field: 'archive_date', dir: 'desc' } });
      if (reasonSel.value) rows = rows.filter(r => r.archive_reason === reasonSel.value);
      clear(wrap);
      if (!rows.length) { wrap.appendChild(h('div', { class: 'empty' }, t('none'))); return; }
      wrap.appendChild(h('table', null,
        h('thead', null, h('tr', null, ['f.file_no', 'f.head_name', 'f.head_national_id', 'f.members_count', 'archive.reason', 'archive.date', 'archive.notes'].map(k => h('th', null, t(k))), h('th', null, ''))),
        h('tbody', null, rows.map(r => h('tr', null,
          h('td', null, r.file_no), h('td', null, r.head_name), h('td', null, r.head_national_id || ''), h('td', { class: 'num' }, r.members_count),
          h('td', null, h('span', { class: `badge ${r.archive_reason === 'death' ? 'danger' : r.archive_reason === 'travel' ? 'primary' : ''}` }, t(`reason.${r.archive_reason}`))),
          h('td', null, r.archive_date || ''), h('td', null, r.archive_notes || ''),
          h('td', null, h('div', { class: 'toolbar' },
            h('button', { class: 'btn small', onclick: () => navigate('family', { id: r.id }) }, t('view')),
            can('editor') ? h('button', { class: 'btn small', onclick: async () => { if (await safe(() => api('restoreFamily', r.id))) { toast(t('archive.restored'), 'ok'); load(); } } }, t('archive.restore')) : null,
            can('admin') ? h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog(t('archive.delete_warn'), true) && await safe(() => api('deleteFamilyPermanently', r.id))) { toast(t('deleted'), 'ok'); load(); } } }, t('archive.delete_forever')) : null)))))));
    }
    main.appendChild(h('div', { class: 'toolbar', style: { marginTop: '12px' } },
      h('button', { class: 'btn', onclick: async () => { const r = await safe(() => call('excel:exportFamilies', rows.map(x => x.id), 'archive')); if (r) toast(t('backup.exported', { file: r.file }), 'ok'); } }, '⬇ ', t('export_excel'))));
    await load();
  }

  // ================================================================ distributions
  async function viewDistributions(main) {
    const aidTypes = await api('listAidTypes');
    main.appendChild(pageHead(t('nav.distributions')));
    const d = new Date();
    const from = h('input', { type: 'date', value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`, onchange: () => load() });
    const to = h('input', { type: 'date', value: todayStr(), onchange: () => load() });
    const typeSel = h('select', { onchange: () => load() }, h('option', { value: '' }, t('all')), aidTypes.map(a => h('option', { value: a.id }, pick(a, 'name'))));
    let rows = [];
    const exportBtn = h('button', {
      class: 'btn', onclick: async () => {
        const header = [t('dist.date'), t('f.file_no'), t('f.head_name'), t('f.head_national_id'), t('f.area'), t('dist.aid_type'), t('dist.amount'), t('dist.notes'), t('dist.batch'), t('dist.by')];
        const data = rows.map(r => [r.date, r.file_no, r.head_name, r.head_national_id, r.area, pick(r, 'name'), r.amount, r.notes, r.batch, r.created_by]);
        const res = await safe(() => call('excel:exportTable', header, data, 'distributions'));
        if (res) toast(t('backup.exported', { file: res.file }), 'ok');
      },
    }, '⬇ ', t('export_excel'));
    main.appendChild(h('div', { class: 'panel toolbar' }, field(t('dist.from'), from), field(t('dist.to'), to), field(t('dist.aid_type'), typeSel), exportBtn,
      h('button', { class: 'btn', onclick: () => window.print() }, '🖨 ', t('print'))));
    const summary = h('div', { class: 'cards' });
    const wrap = h('div', { class: 'table-wrap' });
    main.appendChild(summary);
    main.appendChild(wrap);
    async function load() {
      rows = await api('listDistributions', { from: from.value, to: to.value, aidTypeId: typeSel.value ? Number(typeSel.value) : null });
      clear(summary);
      const byType = {};
      for (const r of rows) { const k = pick(r, 'name'); byType[k] = byType[k] || { n: 0, total: 0, unit: r.unit }; byType[k].n++; byType[k].total += r.amount || 0; }
      for (const [k, v] of Object.entries(byType)) summary.appendChild(h('div', { class: 'card' }, h('div', { class: 'num' }, fmtNum(v.n)), h('div', { class: 'lbl' }, k, v.total ? ` — ${fmtNum(v.total)} ${v.unit || ''}` : '')));
      clear(wrap);
      if (!rows.length) { wrap.appendChild(h('div', { class: 'empty' }, t('none'))); return; }
      wrap.appendChild(h('table', null,
        h('thead', null, h('tr', null, ['dist.date', 'f.file_no', 'f.head_name', 'f.area', 'dist.aid_type', 'dist.amount', 'dist.notes', 'dist.by'].map(k => h('th', null, t(k))), h('th', { class: 'no-print' }, ''))),
        h('tbody', null, rows.map(r => h('tr', null, h('td', null, r.date), h('td', null, r.file_no), h('td', null, h('a', { href: '#', onclick: e => { e.preventDefault(); navigate('family', { id: r.family_id }); } }, r.head_name)),
          h('td', null, r.area || ''), h('td', null, pick(r, 'name')), h('td', { class: 'num' }, r.amount !== null ? `${fmtNum(r.amount)} ${r.unit || ''}` : ''), h('td', null, r.notes || ''), h('td', null, r.created_by || ''),
          h('td', { class: 'no-print' }, can('editor') ? h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog(t('are_you_sure'), true) && await safe(() => api('deleteDistribution', r.id))) load(); } }, '✕') : null))))));
    }
    await load();
  }

  // ================================================================ criteria
  async function viewCriteria(main) {
    const list = await api('listCriteria', true);
    main.appendChild(pageHead(t('crit.title'), h('button', { class: 'btn primary', onclick: () => editCriterion({ type: 'yesno', points: 0, active: true, options: [], sort_order: list.length + 1 }) }, '+ ', t('crit.new'))));
    main.appendChild(h('div', { class: 'alert info' }, t('crit.help')));
    const wrap = h('div', { class: 'table-wrap' });
    if (!list.length) wrap.appendChild(h('div', { class: 'empty' }, t('none')));
    else {
      wrap.appendChild(h('table', null,
        h('thead', null, h('tr', null, h('th', null, t('crit.order')), h('th', null, t('crit.label')), h('th', null, t('crit.type')), h('th', null, t('crit.points')), h('th', null, t('crit.required')), h('th', null, t('active')), h('th', null, ''))),
        h('tbody', null, list.map(c => h('tr', null,
          h('td', { class: 'num' }, c.sort_order), h('td', null, pick(c, 'label')), h('td', null, t(`type.${c.type}`)),
          h('td', null, c.type === 'select' ? c.options.map(o => `${pick(o, 'label')}: ${o.points}`).join(' · ') : (c.type === 'yesno' || c.type === 'number') ? `${c.points}${c.max_points !== null && c.max_points !== undefined ? ` (≤ ${c.max_points})` : ''}` : ''),
          h('td', null, c.required ? '✓' : ''), h('td', null, h('span', { class: `badge ${c.active ? 'ok' : ''}` }, c.active ? t('active') : t('inactive'))),
          h('td', null, h('div', { class: 'toolbar' },
            h('button', { class: 'btn small', onclick: () => editCriterion(c) }, t('edit')),
            h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog(t('crit.delete_warn'), true) && await safe(() => api('deleteCriterion', c.id))) { toast(t('deleted'), 'ok'); renderShell(); } } }, t('delete')))))))));
    }
    main.appendChild(wrap);
  }

  async function editCriterion(orig) {
    const c = JSON.parse(JSON.stringify(orig));
    const body = h('div', { class: 'grid' });
    const optsWrap = h('div');
    const pointsWrap = h('div', { class: 'grid cols-2' });
    const typeSel = h('select', { onchange: e => { c.type = e.target.value; if (c.type === 'select' && !c.options.length) c.options.push({ label_ar: '', label_en: '', label_hy: '', points: 0 }); renderType(); } },
      ['yesno', 'number', 'select', 'text', 'date'].map(x => h('option', { value: x, selected: c.type === x }, t(`type.${x}`))));
    if (c.id) typeSel.disabled = true; // changing type would invalidate stored values
    const txt = (k) => h('input', { type: 'text', value: c[k] || '', oninput: e => { c[k] = e.target.value; } });
    const num = (k) => h('input', { type: 'number', step: 'any', value: c[k] === null || c[k] === undefined ? '' : c[k], oninput: e => { c[k] = e.target.value; } });
    function renderType() {
      clear(pointsWrap); clear(optsWrap);
      if (c.type === 'yesno') pointsWrap.appendChild(field(t('crit.points_yesno'), num('points')));
      if (c.type === 'number') { pointsWrap.appendChild(field(t('crit.points_number'), num('points'))); pointsWrap.appendChild(field(t('crit.max_points'), num('max_points'))); }
      if (c.type === 'select') {
        optsWrap.appendChild(h('h3', null, t('crit.options')));
        optsWrap.appendChild(h('div', { class: 'opt-row muted small' }, h('div', null, t('crit.label_ar')), h('div', null, t('crit.label_en')), h('div', null, t('crit.label_hy')), h('div', null, t('crit.points')), h('div')));
        c.options.forEach((o, i) => {
          const oi = k => h('input', { type: k === 'points' ? 'number' : 'text', step: 'any', value: o[k] === undefined ? '' : o[k], oninput: e => { o[k] = e.target.value; } });
          optsWrap.appendChild(h('div', { class: 'opt-row' }, oi('label_ar'), oi('label_en'), oi('label_hy'), oi('points'),
            h('button', { class: 'btn small danger', onclick: () => { c.options.splice(i, 1); renderType(); } }, '✕')));
        });
        optsWrap.appendChild(h('button', { class: 'btn small', onclick: () => { c.options.push({ label_ar: '', label_en: '', label_hy: '', points: 0 }); renderType(); } }, '+ ', t('crit.add_option')));
      }
    }
    renderType();
    body.appendChild(h('div', { class: 'grid cols-3' }, field(t('crit.label_ar'), txt('label_ar')), field(t('crit.label_en'), txt('label_en')), field(t('crit.label_hy'), txt('label_hy'))));
    body.appendChild(h('div', { class: 'grid cols-2' }, field(t('crit.type'), typeSel), field(t('crit.order'), num('sort_order'))));
    body.appendChild(pointsWrap);
    body.appendChild(optsWrap);
    body.appendChild(h('div', { class: 'toolbar' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.required, onchange: e => { c.required = e.target.checked; } }), t('crit.required')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.active !== false, onchange: e => { c.active = e.target.checked; } }), t('active'))));
    const r = await modal(c.id ? t('crit.edit') : t('crit.new'), body, [
      { label: t('cancel'), value: null },
      { label: t('save'), kind: 'primary', onClick: () => safe(() => api('saveCriterion', c)).then(x => x || false) },
    ], { wide: true });
    if (r) { toast(t('saved'), 'ok'); renderShell(); }
  }

  // ================================================================ aid types
  async function viewAidTypes(main) {
    const list = await api('listAidTypes');
    main.appendChild(pageHead(t('aid.title'), h('button', { class: 'btn primary', onclick: () => editAid({ active: true }) }, '+ ', t('aid.new'))));
    main.appendChild(h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, t('aid.name_ar')), h('th', null, t('aid.name_en')), h('th', null, t('aid.name_hy')), h('th', null, t('aid.unit')), h('th', null, t('active')), h('th', null, ''))),
      h('tbody', null, list.map(a => h('tr', null, h('td', null, a.name_ar), h('td', null, a.name_en), h('td', null, a.name_hy), h('td', null, a.unit || ''),
        h('td', null, h('span', { class: `badge ${a.active ? 'ok' : ''}` }, a.active ? t('active') : t('inactive'))),
        h('td', null, h('div', { class: 'toolbar' },
          h('button', { class: 'btn small', onclick: () => editAid(a) }, t('edit')),
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog(t('are_you_sure'), true) && await safe(() => api('deleteAidType', a.id))) renderShell(); } }, t('delete'))))))))));
  }

  async function editAid(orig) {
    const a = { ...orig };
    const txt = k => h('input', { type: 'text', value: a[k] || '', oninput: e => { a[k] = e.target.value; } });
    const body = h('div', { class: 'grid' }, field(t('aid.name_ar'), txt('name_ar')), field(t('aid.name_en'), txt('name_en')), field(t('aid.name_hy'), txt('name_hy')), field(t('aid.unit'), txt('unit')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.active !== false, onchange: e => { a.active = e.target.checked; } }), t('active')));
    const r = await modal(a.id ? t('edit') : t('aid.new'), body, [
      { label: t('cancel'), value: null },
      { label: t('save'), kind: 'primary', onClick: () => safe(() => api('saveAidType', a)).then(x => x || false) },
    ]);
    if (r) { toast(t('saved'), 'ok'); renderShell(); }
  }

  // ================================================================ users
  async function viewUsers(main) {
    const list = await api('listUsers');
    main.appendChild(pageHead(t('user.title'), h('button', { class: 'btn primary', onclick: () => editUser({ role: 'editor', active: true }) }, '+ ', t('user.new'))));
    main.appendChild(h('div', { class: 'alert info' }, t('user.roles_help')));
    main.appendChild(h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, t('username')), h('th', null, t('user.full_name')), h('th', null, t('user.role')), h('th', null, t('active')), h('th', null, ''))),
      h('tbody', null, list.map(u => h('tr', null, h('td', null, u.username), h('td', null, u.full_name || ''), h('td', null, t(`role.${u.role}`)),
        h('td', null, h('span', { class: `badge ${u.active ? 'ok' : ''}` }, u.active ? t('active') : t('inactive')),
          u.needs_reset ? [' ', h('span', { class: 'badge warn' }, t('user.needs_reset'))] : null),
        h('td', null, h('div', { class: 'toolbar' },
          h('button', { class: 'btn small', onclick: () => editUser({ ...u, active: !!u.active }) }, t('edit')),
          u.id !== state.user.id ? h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog(t('are_you_sure'), true) && await safe(() => api('deleteUser', u.id))) renderShell(); } }, t('delete')) : null))))))));
  }

  async function editUser(orig) {
    const u = { ...orig, password: '' };
    const txt = (k, type = 'text') => h('input', { type, value: u[k] || '', oninput: e => { u[k] = e.target.value; } });
    const role = h('select', { onchange: e => { u.role = e.target.value; } }, ['admin', 'editor', 'viewer'].map(r => h('option', { value: r, selected: u.role === r }, t(`role.${r}`))));
    const body = h('div', { class: 'grid' }, field(t('username'), txt('username'), true), field(t('user.full_name'), txt('full_name')), field(t('user.role'), role),
      field(t('password') + (u.id ? ` (${t('user.password_keep')})` : ''), txt('password', 'password'), !u.id),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: u.active, onchange: e => { u.active = e.target.checked; } }), t('active')));
    const r = await modal(u.id ? t('user.edit') : t('user.new'), body, [
      { label: t('cancel'), value: null },
      { label: t('save'), kind: 'primary', onClick: () => safe(() => api('saveUser', u)).then(x => x || false) },
    ]);
    if (r) { toast(t('saved'), 'ok'); renderShell(); }
  }

  // ================================================================ backup / import / export
  async function viewBackup(main) {
    const [list, settings] = await Promise.all([call('backup:list'), call('settings:get')]);
    main.appendChild(pageHead(t('backup.title')));
    main.appendChild(h('div', { class: 'panel' },
      h('div', { class: 'alert info' }, t('backup.auto_help'), ' ', t('backup.last'), ': ', settings.last_backup ? new Date(settings.last_backup).toLocaleString() : t('never')),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', onclick: async () => { const r = await safe(() => call('backup:now')); if (r) { toast(t('backup.created'), 'ok'); if (r.extraError) toast(r.extraError, 'error'); renderShell(); } } }, '💾 ', t('backup.now')),
        h('button', { class: 'btn', onclick: async () => { const f = await safe(() => call('backup:export')); if (f) toast(t('backup.exported', { file: f }), 'ok'); } }, '⬆ ', t('backup.export')),
        h('button', { class: 'btn danger', onclick: () => restore(() => call('backup:import')) }, '⬇ ', t('backup.import')),
        h('button', { class: 'btn', onclick: () => safe(() => call('backup:openFolder')) }, '📂 ', t('backup.open_folder')))));

    main.appendChild(h('div', { class: 'panel' }, h('h3', null, t('backup.excel_title')),
      h('p', { class: 'muted' }, t('backup.excel_help')),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', onclick: async () => { const r = await safe(() => call('excel:template')); if (r) toast(t('backup.exported', { file: r.file }), 'ok'); } }, '📄 ', t('backup.template')),
        h('button', {
          class: 'btn primary', onclick: async () => {
            const r = await safe(() => call('excel:import'));
            if (!r) return;
            const errs = r.errors.map(e => h('li', null, `${t('backup.row')} ${e.row}: ${t('err.' + e.code, { extra: e.extra })}`));
            modal(t('import_excel'), h('div', null, h('p', null, t('backup.import_result', { c: r.created, u: r.updated, s: r.skipped, e: r.errors.length })), errs.length ? h('ul', { class: 'small' }, errs) : null));
          },
        }, '⬇ ', t('import_excel')))));

    main.appendChild(h('div', { class: 'panel' }, h('h3', null, t('backup.list')),
      list.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, t('backup.name')), h('th', null, t('dist.date')), h('th', { class: 'num' }, t('backup.size')), h('th', null, ''))),
        h('tbody', null, list.map(b => h('tr', null, h('td', null, b.name), h('td', null, new Date(b.mtime).toLocaleString()), h('td', { class: 'num' }, `${(b.size / 1024).toFixed(0)} KB`),
          h('td', null, h('button', { class: 'btn small danger', onclick: () => restore(() => call('backup:restore', b.name)) }, t('backup.restore')))))))) : h('div', { class: 'muted' }, t('none'))));

    async function restore(fn) {
      if (!(await confirmDialog(t('backup.import_warn'), true))) return;
      const r = await safe(fn);
      if (r) { state.user = null; state.dirty = false; renderLogin(r.encrypted && !r.sameKey ? t('backup.restored_other') : t('backup.restored')); }
    }
  }

  // ================================================================ settings
  async function viewSettings(main) {
    const [s, info] = await Promise.all([call('settings:get'), call('app:info')]);
    const org = h('input', { type: 'text', value: s.org_name });
    const keep = h('input', { type: 'number', min: 1, max: 365, value: s.backup_keep });
    const lockM = h('input', { type: 'number', min: 0, value: s.auto_lock_minutes });
    const extra = h('input', { type: 'text', value: s.backup_extra_dir, style: { flex: 1 } });
    main.appendChild(pageHead(t('settings.title')));
    main.appendChild(h('div', { class: 'panel grid', style: { maxWidth: '760px' } },
      field(t('settings.org_name'), org),
      field(t('settings.auto_lock'), lockM),
      field(t('backup.keep'), keep),
      field(t('backup.extra_dir'), h('div', { class: 'toolbar' }, extra, h('button', { class: 'btn', onclick: async () => { const d = await safe(() => call('dialog:chooseDir')); if (d) extra.value = d; } }, t('backup.choose')))),
      h('div', null, h('button', {
        class: 'btn primary', onclick: async () => {
          const ok = await safe(() => call('settings:save', { org_name: org.value, backup_keep: keep.value, auto_lock_minutes: lockM.value, backup_extra_dir: extra.value }));
          if (ok) { state.settings = await call('settings:get'); toast(t('saved'), 'ok'); renderShell(); }
        },
      }, t('save')))));
    main.appendChild(h('div', { class: 'panel', style: { maxWidth: '760px' } }, h('h3', null, '🔒 ', t('enc.title')),
      h('div', { class: 'alert info' }, t('enc.status_on')),
      h('div', { class: 'alert warn' }, t('enc.excel_warn')),
      h('button', {
        class: 'btn', onclick: async () => {
          if (!(await confirmDialog(t('rec.new_key_warn'), true))) return;
          const k = await safe(() => call('auth:newRecoveryKey'));
          if (k) showRecoveryKey(k);
        },
      }, '🔑 ', t('rec.new_key'))));
    main.appendChild(h('div', { class: 'panel small muted' },
      h('div', null, `${t('settings.version')}: ${info.version}`),
      h('div', null, `${t('settings.data_dir')}: `, h('span', { dir: 'ltr' }, info.dataDir))));
  }

  // ================================================================ audit
  async function viewAudit(main) {
    const list = await api('listAudit', 1000);
    main.appendChild(pageHead(t('nav.audit')));
    main.appendChild(h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['audit.at', 'audit.user', 'audit.action', 'audit.entity', 'audit.details'].map(k => h('th', null, t(k))))),
      h('tbody', null, list.map(a => h('tr', null, h('td', null, a.at), h('td', null, a.username || ''), h('td', null, a.action), h('td', null, `${a.entity || ''}${a.entity_id ? ' #' + a.entity_id : ''}`), h('td', { class: 'small' }, a.details || '')))))));
  }

  window.addEventListener('beforeunload', () => { /* data is saved on every change */ });
  boot();
})();

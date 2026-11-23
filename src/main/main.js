'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const excel = require('./excel');

// Keep data next to the program in "portable" mode, otherwise in the user's AppData folder.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataRoot = process.env.FD_DATA_DIR || (portableDir ? path.join(portableDir, 'FamiliesData') : app.getPath('userData'));
const DB_FILE = path.join(dataRoot, 'data', 'families.db');
const BACKUP_DIR = path.join(dataRoot, 'backups');
const CONFIG_FILE = path.join(dataRoot, 'config.json');

let win = null;
let store = null;
let backupTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'Families Data',
    backgroundColor: '#f4f6f9',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  if (process.env.FD_DEVTOOLS) win.webContents.openDevTools();
}

// Methods of Service that the UI may call directly (only while logged in).
const SERVICE_METHODS = [
  'currentUser', 'changePassword',
  'listUsers', 'saveUser', 'deleteUser', 'listAudit',
  'listCriteria', 'saveCriterion', 'deleteCriterion',
  'listAidTypes', 'saveAidType', 'deleteAidType',
  'getFamily', 'saveFamily', 'findByNationalId', 'nextFileNo', 'archiveFamily', 'restoreFamily', 'deleteFamilyPermanently',
  'recordDistribution', 'deleteDistribution', 'listDistributions',
  'filterFields', 'searchFamilies', 'listSavedFilters', 'saveFilter', 'deleteSavedFilter', 'stats',
];

function wrap(fn) {
  return async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      if (!e.code) console.error(e);
      return { ok: false, code: e.code || 'unexpected_error', extra: e.extra || e.message };
    }
  };
}

const svc = () => store.requireService();

function registerIpc() {
  for (const m of SERVICE_METHODS) {
    ipcMain.handle(`svc:${m}`, wrap((...args) => {
      if (m === 'currentUser') return store.service ? store.service.currentUser() : null;
      return svc()[m](...args);
    }));
  }

  // ---------------- session
  ipcMain.handle('svc:login', wrap(async (u, p) => {
    const user = await store.login(u, p);
    try { store.backups.runDaily(); } catch (e) { console.error(e); }
    return user;
  }));
  ipcMain.handle('svc:logout', wrap(() => { store.logout(); return true; }));
  ipcMain.handle('auth:status', wrap(() => store.status()));
  ipcMain.handle('auth:recover', wrap((key, u, p) => store.recover(key, u, p)));
  ipcMain.handle('auth:newRecoveryKey', wrap(() => store.newRecoveryKey()));
  ipcMain.handle('auth:confirmRecovery', wrap(() => store.confirmRecoverySaved()));
  ipcMain.handle('auth:saveRecoveryFile', wrap(async key => {
    svc().require('admin');
    const r = await dialog.showSaveDialog(win, { defaultPath: 'families-data-recovery-key.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, `Families Data - Recovery key\r\n${new Date().toISOString().slice(0, 10)}\r\n\r\n${key}\r\n`);
    return r.filePath;
  }));

  ipcMain.handle('app:info', wrap(() => ({
    version: app.getVersion(), dataDir: dataRoot, dbFile: DB_FILE, backupDir: BACKUP_DIR, ...store.status(),
  })));

  // ---------------- settings (plain config file, readable before login)
  ipcMain.handle('settings:get', wrap(() => {
    const c = store.config.all();
    return {
      lang: c.lang, org_name: c.org_name, backup_keep: Number(c.backup_keep), backup_extra_dir: c.backup_extra_dir,
      last_backup: c.last_backup, auto_lock_minutes: Number(c.auto_lock_minutes), recovery_confirmed: !!c.recovery_confirmed,
    };
  }));
  ipcMain.handle('settings:setLang', wrap(l => { if (['ar', 'en', 'hy'].includes(l)) store.config.set({ lang: l }); return true; }));
  ipcMain.handle('settings:save', wrap(s => {
    svc().require('admin');
    const v = {};
    if (s.org_name !== undefined) v.org_name = String(s.org_name);
    if (s.backup_keep !== undefined) v.backup_keep = Math.max(1, Math.min(365, Number(s.backup_keep) || 30));
    if (s.backup_extra_dir !== undefined) v.backup_extra_dir = String(s.backup_extra_dir);
    if (s.auto_lock_minutes !== undefined) v.auto_lock_minutes = Math.max(0, Number(s.auto_lock_minutes) || 0);
    store.config.set(v);
    svc().audit('update', 'settings');
    return true;
  }));

  ipcMain.handle('dialog:chooseDir', wrap(async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  }));

  // ---------------- backups
  ipcMain.handle('backup:list', wrap(() => { svc().require('admin'); return store.backups.list(); }));
  ipcMain.handle('backup:now', wrap(() => {
    svc().require('admin');
    const r = store.backups.create();
    svc().audit('backup', 'database', null, r && r.file);
    return r;
  }));
  ipcMain.handle('backup:openFolder', wrap(() => { svc().require('admin'); shell.openPath(BACKUP_DIR); return true; }));
  ipcMain.handle('backup:export', wrap(async () => {
    svc().require('admin');
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `families-data-${new Date().toISOString().slice(0, 10)}.fdb`,
      filters: [{ name: 'Families Data backup', extensions: ['fdb'] }],
    });
    if (r.canceled || !r.filePath) return null;
    store.backups.exportTo(r.filePath);
    svc().audit('export', 'database', null, r.filePath);
    return r.filePath;
  }));
  ipcMain.handle('backup:import', wrap(async () => {
    svc().require('admin');
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Families Data backup', extensions: ['fdb', 'db', 'sqlite'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return store.restore(fs.readFileSync(r.filePaths[0]));
  }));
  ipcMain.handle('backup:restore', wrap(async name => {
    svc().require('admin');
    const b = store.backups.list().find(x => x.name === name);
    if (!b) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
    return store.restore(fs.readFileSync(b.path));
  }));

  // ---------------- excel
  const lang = () => store.config.get('lang') || 'ar';
  const xlsxFilter = [{ name: 'Excel', extensions: ['xlsx'] }];
  ipcMain.handle('excel:exportFamilies', wrap(async (ids, defaultName) => {
    svc().require('viewer');
    const r = await dialog.showSaveDialog(win, { defaultPath: (defaultName || 'families') + '.xlsx', filters: xlsxFilter });
    if (r.canceled || !r.filePath) return null;
    const res = excel.exportFamilies(svc(), ids, r.filePath, lang());
    svc().audit('export', 'families', null, `${res.families} -> ${r.filePath}`);
    return { file: r.filePath, ...res };
  }));
  ipcMain.handle('excel:exportTable', wrap(async (header, rows, defaultName) => {
    svc().require('viewer');
    const r = await dialog.showSaveDialog(win, { defaultPath: (defaultName || 'report') + '.xlsx', filters: xlsxFilter });
    if (r.canceled || !r.filePath) return null;
    excel.exportTable(rows, header, r.filePath, defaultName || 'report', lang() === 'ar');
    svc().audit('export', 'report', null, r.filePath);
    return { file: r.filePath };
  }));
  ipcMain.handle('excel:template', wrap(async () => {
    svc().require('viewer');
    const r = await dialog.showSaveDialog(win, { defaultPath: 'families-template.xlsx', filters: xlsxFilter });
    if (r.canceled || !r.filePath) return null;
    excel.exportTemplate(svc(), r.filePath, lang());
    return { file: r.filePath };
  }));
  ipcMain.handle('excel:import', wrap(async () => {
    svc().require('editor');
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Excel', extensions: ['xlsx', 'xls', 'csv'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    store.backups.create(); // safety copy before bulk changes
    const res = excel.importFamilies(svc(), r.filePaths[0]);
    svc().audit('import', 'families', null, JSON.stringify({ created: res.created, updated: res.updated }));
    return res;
  }));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(() => {
    store = new Store({ dbFile: DB_FILE, backupDir: BACKUP_DIR, configFile: CONFIG_FILE });
    // the encrypted file can be copied without logging in
    try { store.backups.runDaily(); } catch (e) { console.error('backup failed', e); }
    registerIpc();
    createWindow();
    // laptop may stay on for days: check every hour whether today's backup exists
    backupTimer = setInterval(() => { try { store.backups.runDaily(); } catch (e) { console.error(e); } }, 60 * 60 * 1000);
  });

  app.on('window-all-closed', () => {
    if (backupTimer) clearInterval(backupTimer);
    try { if (store) store.logout(); } catch (_) { /* ignore */ }
    app.quit();
  });
}

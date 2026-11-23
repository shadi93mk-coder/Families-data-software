'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Database } = require('./db');
const { Service } = require('./service');
const { BackupManager } = require('./backup');
const excel = require('./excel');

// Keep data next to the program in "portable" mode, otherwise in the user's AppData folder.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataRoot = process.env.FD_DATA_DIR || (portableDir ? path.join(portableDir, 'FamiliesData') : app.getPath('userData'));
const DB_FILE = path.join(dataRoot, 'data', 'families.db');
const BACKUP_DIR = path.join(dataRoot, 'backups');

let win = null;
let db = null;
let service = null;
let backups = null;
let backupTimer = null;

async function openData() {
  db = await new Database(DB_FILE).open();
  service = new Service(db);
  service.ensureDefaults();
  backups = new BackupManager(db, BACKUP_DIR);
  try { backups.runDaily(); } catch (e) { console.error('backup failed', e); }
}

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

// Methods of Service that the UI may call directly.
const SERVICE_METHODS = [
  'login', 'logout', 'currentUser', 'changePassword',
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

function lang() { return (db && db.getSetting('lang', 'ar')) || 'ar'; }

function registerIpc() {
  for (const m of SERVICE_METHODS) {
    ipcMain.handle(`svc:${m}`, wrap((...args) => service[m](...args)));
  }

  ipcMain.handle('app:info', wrap(() => ({
    version: app.getVersion(), dataDir: dataRoot, dbFile: DB_FILE, backupDir: BACKUP_DIR,
  })));

  ipcMain.handle('settings:get', wrap(() => ({
    lang: db.getSetting('lang', 'ar'),
    org_name: db.getSetting('org_name', ''),
    backup_keep: Number(db.getSetting('backup_keep', '30')),
    backup_extra_dir: db.getSetting('backup_extra_dir', ''),
    last_backup: db.getSetting('last_backup', ''),
    auto_lock_minutes: Number(db.getSetting('auto_lock_minutes', '15')),
  })));

  // language may be changed before login (login screen)
  ipcMain.handle('settings:setLang', wrap(l => { if (['ar', 'en', 'hy'].includes(l)) db.set('lang', l); return true; }));

  ipcMain.handle('settings:save', wrap(s => {
    service.require('admin');
    if (s.org_name !== undefined) db.set('org_name', String(s.org_name));
    if (s.backup_keep !== undefined) db.set('backup_keep', String(Math.max(1, Math.min(365, Number(s.backup_keep) || 30))));
    if (s.backup_extra_dir !== undefined) db.set('backup_extra_dir', String(s.backup_extra_dir));
    if (s.auto_lock_minutes !== undefined) db.set('auto_lock_minutes', String(Math.max(0, Number(s.auto_lock_minutes) || 0)));
    service.audit('update', 'settings');
    return true;
  }));

  ipcMain.handle('dialog:chooseDir', wrap(async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  }));

  // ---------------- backups
  ipcMain.handle('backup:list', wrap(() => { service.require('admin'); return backups.list(); }));
  ipcMain.handle('backup:now', wrap(() => {
    service.require('admin');
    const r = backups.create();
    service.audit('backup', 'database', null, r.file);
    return r;
  }));
  ipcMain.handle('backup:openFolder', wrap(() => { service.require('admin'); shell.openPath(BACKUP_DIR); return true; }));
  ipcMain.handle('backup:export', wrap(async () => {
    service.require('admin');
    const r = await dialog.showSaveDialog(win, {
      defaultPath: `families-data-${new Date().toISOString().slice(0, 10)}.fdb`,
      filters: [{ name: 'Families Data backup', extensions: ['fdb'] }],
    });
    if (r.canceled || !r.filePath) return null;
    backups.exportTo(r.filePath);
    service.audit('export', 'database', null, r.filePath);
    return r.filePath;
  }));
  const doRestore = async (source) => {
    service.require('admin');
    const who = service.currentUser();
    const safety = await backups.importFrom(source, DB_FILE);
    await openData();
    service.user = null;
    service.audit('import', 'database', null, `${source} by ${who && who.username}`);
    return { safety };
  };
  ipcMain.handle('backup:import', wrap(async () => {
    service.require('admin');
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Families Data backup', extensions: ['fdb', 'db', 'sqlite'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return doRestore(r.filePaths[0]);
  }));
  ipcMain.handle('backup:restore', wrap(async name => {
    service.require('admin');
    const b = backups.list().find(x => x.name === name);
    if (!b) { const e = new Error('not_found'); e.code = 'not_found'; throw e; }
    return doRestore(b.path);
  }));

  // ---------------- excel
  const xlsxFilter = [{ name: 'Excel', extensions: ['xlsx'] }];
  ipcMain.handle('excel:exportFamilies', wrap(async (ids, defaultName) => {
    service.require('viewer');
    const r = await dialog.showSaveDialog(win, { defaultPath: (defaultName || 'families') + '.xlsx', filters: xlsxFilter });
    if (r.canceled || !r.filePath) return null;
    const res = excel.exportFamilies(service, ids, r.filePath, lang());
    service.audit('export', 'families', null, `${res.families} -> ${r.filePath}`);
    return { file: r.filePath, ...res };
  }));
  ipcMain.handle('excel:exportTable', wrap(async (header, rows, defaultName) => {
    service.require('viewer');
    const r = await dialog.showSaveDialog(win, { defaultPath: (defaultName || 'report') + '.xlsx', filters: xlsxFilter });
    if (r.canceled || !r.filePath) return null;
    excel.exportTable(rows, header, r.filePath, defaultName || 'report', lang() === 'ar');
    service.audit('export', 'report', null, r.filePath);
    return { file: r.filePath };
  }));
  ipcMain.handle('excel:template', wrap(async () => {
    service.require('viewer');
    const r = await dialog.showSaveDialog(win, { defaultPath: 'families-template.xlsx', filters: xlsxFilter });
    if (r.canceled || !r.filePath) return null;
    excel.exportTemplate(service, r.filePath, lang());
    return { file: r.filePath };
  }));
  ipcMain.handle('excel:import', wrap(async () => {
    service.require('editor');
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Excel', extensions: ['xlsx', 'xls', 'csv'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    backups.create(); // safety copy before bulk changes
    const res = excel.importFamilies(service, r.filePaths[0]);
    service.audit('import', 'families', null, JSON.stringify({ created: res.created, updated: res.updated }));
    return res;
  }));

  // ---------------- printing
  ipcMain.handle('app:print', wrap(() => new Promise(resolve => {
    win.webContents.print({ printBackground: true }, ok => resolve(ok));
  })));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

  app.whenReady().then(async () => {
    try {
      await openData();
    } catch (e) {
      dialog.showErrorBox('Families Data', 'Could not open the database:\n' + e.message);
      app.quit();
      return;
    }
    registerIpc();
    createWindow();
    // laptop may stay on for days: check every hour whether today's backup exists
    backupTimer = setInterval(() => { try { backups.runDaily(); } catch (e) { console.error(e); } }, 60 * 60 * 1000);
  });

  app.on('window-all-closed', () => {
    if (backupTimer) clearInterval(backupTimer);
    try { if (db) db.close(); } catch (_) { /* ignore */ }
    app.quit();
  });
}

module.exports = { DB_FILE, BACKUP_DIR };

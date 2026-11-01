'use strict';

const path = require('node:path');
const {
  app, BrowserWindow, ipcMain, shell, net, Tray, Menu, nativeImage, Notification, dialog, nativeTheme,
} = require('electron');
const pkg = require('../../package.json');
const { Settings } = require('./settings');
const { Manager } = require('./manager');
const { STRINGS } = require('./strings');

// ---------- configuration ----------

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const SIMULATE =
  process.argv.includes('--simulate') || process.env.ORBIT_SIMULATE === '1' || !(IS_MAC || IS_WIN);
const START_HIDDEN = process.argv.includes('--hidden');
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ASSETS = path.join(__dirname, '..', 'assets');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const THEME_COLORS = {
  dark: { bg: '#101117', symbols: '#e7e9f3' },
  light: { bg: '#f4f5f9', symbols: '#1d1e26' },
};

if (SIMULATE) {
  // La démo a ses propres données : elle ne touche jamais à la vraie installation.
  app.setPath('userData', path.join(app.getPath('appData'), 'Creative Orbit Demo'));
}
app.setName('Creative Orbit');
if (IS_WIN) app.setAppUserModelId('org.creativeorbit.launcher');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let settings;
let manager;
let win = null;
let tray = null;
let quitting = false;
let effectiveTheme = 'dark';
let checkTimer = null;
let notifiedUpdates = new Set();
let launcherUpdate = { status: 'idle', version: null, percent: 0, error: null };
let autoUpdater = null;

const userPath = (...p) => path.join(app.getPath('userData'), ...p);

function lang() {
  const pref = settings.get().language;
  if (pref !== 'auto') return pref;
  const sys = (app.getPreferredSystemLanguages()[0] || app.getLocale() || 'en').toLowerCase();
  return sys.startsWith('fr') ? 'fr' : 'en';
}
const t = () => STRINGS[lang()];

function catalogUrl() {
  return process.env.ORBIT_CATALOG_URL || settings.get().catalogUrl || pkg.orbit.catalogUrl;
}

// ---------- état envoyé à l'interface ----------

function payload() {
  return {
    state: manager.snapshot(),
    settings: settings.get(),
    launcher: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      update: launcherUpdate,
    },
    system: { os: process.platform, language: lang() },
  };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('orbit:state', payload());
  updateTray();
}

// ---------- plateforme ----------

function createBackend() {
  if (SIMULATE) {
    const { createSimulatedBackend } = require('./platform/simulated');
    return createSimulatedBackend({
      statePath: userPath('simulated-installs.json'),
      as: process.env.ORBIT_SIMULATE_AS || (IS_MAC ? 'macos' : 'windows'),
      delayMs: Number(process.env.ORBIT_SIMULATE_DELAY || 1500),
      seed: process.env.ORBIT_SIMULATE_SEED ? JSON.parse(process.env.ORBIT_SIMULATE_SEED) : null,
      onLaunch: (a) => {
        dialog.showMessageBox(win, {
          type: 'info',
          title: t().demoLaunchTitle,
          message: a.name,
          detail: t().demoLaunchBody(a.name),
          buttons: [t().ok],
        });
      },
    });
  }
  if (IS_WIN) return require('./platform/windows').createWindowsBackend();
  return require('./platform/macos').createMacBackend();
}

// ---------- fenêtre ----------

function createWindow() {
  const colors = THEME_COLORS[effectiveTheme];
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
    show: false,
    title: 'Creative Orbit',
    backgroundColor: colors.bg,
    icon: IS_WIN ? path.join(ASSETS, 'tray.ico') : undefined,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 16 },
    titleBarOverlay: IS_MAC ? undefined : { color: colors.bg, symbolColor: colors.symbols, height: 48 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Sécurité : aucune navigation, les liens s'ouvrent dans le navigateur.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => {
    if (!START_HIDDEN) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && settings.get().runInBackground) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

function showWindow(view) {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (view) win.webContents.send('orbit:navigate', view);
}

function applyTheme(theme) {
  effectiveTheme = theme === 'light' ? 'light' : 'dark';
  if (!win) return;
  const colors = THEME_COLORS[effectiveTheme];
  win.setBackgroundColor(colors.bg);
  if (!IS_MAC && typeof win.setTitleBarOverlay === 'function') {
    win.setTitleBarOverlay({ color: colors.bg, symbolColor: colors.symbols, height: 48 });
  }
}

// ---------- barre des tâches / barre des menus ----------

function createTray() {
  let image;
  if (IS_MAC) {
    image = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    image.setTemplateImage(true);
  } else {
    image = nativeImage.createFromPath(path.join(ASSETS, IS_WIN ? 'tray.ico' : 'creative-orbit-icone-32.png'));
  }
  tray = new Tray(image);
  tray.on('click', () => showWindow());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const s = t();
  const n = manager ? manager.updatesCount() : 0;
  tray.setToolTip(n ? s.tooltipUpdates(n) : s.tooltip);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: s.open, click: () => showWindow() },
      { label: s.checkUpdates, click: () => checkNow(true) },
      { type: 'separator' },
      { label: s.quit, click: () => app.quit() },
    ]),
  );
}

// ---------- notifications et vérification périodique ----------

function notify(title, body, view) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => showWindow(view));
  n.show();
}

async function checkNow(manual = false) {
  await manager.refresh();
  const updates = manager.snapshot().apps.filter((a) => a.updateAvailable);
  const fresh = updates.filter((a) => !notifiedUpdates.has(`${a.id}@${a.latestVersion}`));
  const windowVisible = win && win.isVisible() && win.isFocused();
  if (fresh.length && !windowVisible) {
    notify(t().updatesTitle, t().updatesBody(updates.map((a) => a.name)), 'updates');
  }
  for (const a of updates) notifiedUpdates.add(`${a.id}@${a.latestVersion}`);
  if (manual) showWindow(updates.length ? 'updates' : undefined);
  if (autoUpdater) autoUpdater.checkForUpdates().catch(() => {});
}

function scheduleChecks() {
  clearInterval(checkTimer);
  if (settings.get().autoCheck) checkTimer = setInterval(() => checkNow(false), CHECK_INTERVAL_MS);
}

function onFinished({ id, type, ok, version }) {
  if (win && win.isVisible() && win.isFocused()) return;
  const appInfo = manager.snapshot().apps.find((a) => a.id === id);
  if (!appInfo) return;
  const s = t();
  if (!ok) return notify(appInfo.name, s.failed(appInfo.name));
  if (type === 'install') notify(appInfo.name, s.installed(appInfo.name, version));
  else if (type === 'update') notify(appInfo.name, s.updated(appInfo.name, version));
  else if (type === 'uninstall') notify(appInfo.name, s.uninstalled(appInfo.name));
}

// ---------- mise à jour du lanceur lui-même ----------

function setupLauncherUpdates() {
  if (!app.isPackaged || SIMULATE) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  const set = (patch) => {
    launcherUpdate = { ...launcherUpdate, ...patch };
    pushState();
  };
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ status: 'none' }));
  autoUpdater.on('update-available', (i) => set({ status: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version }));
  autoUpdater.on('error', (e) => set({ status: 'error', error: String(e && e.message) }));
  autoUpdater.checkForUpdates().catch(() => {});
}

// ---------- IPC ----------

function registerIpc() {
  const validId = (id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid id');
    return id;
  };
  ipcMain.handle('orbit:get-state', () => payload());
  ipcMain.handle('orbit:refresh', () => manager.refresh());
  ipcMain.handle('orbit:install', (_e, id) => { manager.install(validId(id)); });
  ipcMain.handle('orbit:uninstall', (_e, id) => { manager.uninstall(validId(id)); });
  ipcMain.handle('orbit:cancel', (_e, id) => manager.cancel(validId(id)));
  ipcMain.handle('orbit:launch', (_e, id) => manager.launch(validId(id)));
  ipcMain.handle('orbit:dismiss', (_e, id) => manager.dismiss(validId(id)));
  ipcMain.handle('orbit:update-all', () => { manager.updateAll(); });
  ipcMain.handle('orbit:set-settings', (_e, patch) => {
    const changed = settings.set(patch);
    if ('launchAtLogin' in changed) applyLoginItem();
    if ('autoCheck' in changed) scheduleChecks();
    if ('theme' in changed) nativeTheme.themeSource = changed.theme;
    if ('language' in changed) updateTray();
    if ('catalogUrl' in changed) {
      manager.catalogUrl = catalogUrl();
      manager.refresh();
    }
    pushState();
    return settings.get();
  });
  ipcMain.handle('orbit:set-effective-theme', (_e, theme) => applyTheme(theme));
  ipcMain.handle('orbit:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('orbit:open-logs', () => shell.openPath(userPath('logs')));
  ipcMain.handle('orbit:launcher-check', () => {
    if (autoUpdater) return autoUpdater.checkForUpdates().catch(() => {});
  });
  ipcMain.handle('orbit:launcher-install', () => {
    if (autoUpdater && launcherUpdate.status === 'ready') {
      quitting = true;
      autoUpdater.quitAndInstall();
    }
  });
}

function applyLoginItem() {
  if (!app.isPackaged) return; // évite d'enregistrer le binaire de développement
  app.setLoginItemSettings({ openAtLogin: settings.get().launchAtLogin, args: ['--hidden'] });
}

// ---------- cycle de vie ----------

app.on('second-instance', () => showWindow());

app.on('before-quit', async (e) => {
  if (quitting || !manager || !manager.hasActiveOps()) {
    quitting = true;
    return;
  }
  e.preventDefault();
  const s = t();
  const { response } = await dialog.showMessageBox(win && win.isVisible() ? win : undefined, {
    type: 'warning',
    title: s.quitBusyTitle,
    message: s.quitBusyTitle,
    detail: s.quitBusyBody,
    buttons: [s.cancel, s.quitAnyway],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) {
    quitting = true;
    for (const id of manager.ops.keys()) manager.cancel(id);
    app.quit();
  }
});

app.on('activate', () => showWindow());

app.on('window-all-closed', () => {
  if (!settings.get().runInBackground) app.quit();
});

app.whenReady().then(() => {
  settings = new Settings(userPath('settings.json'));
  const theme = settings.get().theme;
  nativeTheme.themeSource = theme;
  applyTheme(theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme);

  manager = new Manager({
    backend: createBackend(),
    fetch: (url, init) => net.fetch(url, init),
    catalogUrl: catalogUrl(),
    allowLocalHttp: !app.isPackaged,
    paths: {
      cache: userPath('catalog-cache.json'),
      downloads: path.join(app.getPath('temp'), 'creative-orbit-downloads'),
      logs: userPath('logs'),
    },
  });
  manager.on('change', pushState);
  manager.on('finished', onFinished);

  registerIpc();
  createWindow();
  createTray();
  applyLoginItem();
  setupLauncherUpdates();
  scheduleChecks();
  checkNow(false);
});

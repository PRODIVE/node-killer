const { app, Menu, Tray, nativeImage, Notification, dialog, BrowserWindow, ipcMain, shell, clipboard, screen, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const prefs = require('./prefs');
const scanner = require('./scanner');
const { buildSnapshot, History } = require('./snapshot');
const { readMemory } = require('./memory');
const { REFRESH_CHOICES, DEFAULT_REFRESH_MS } = prefs;

/**
 * ⚡️ Node Killer: a minimal macOS menubar app that hunts down and kills your stray Node.js processes.
 * Processes are grouped by the command that started them and labelled with app + project (see scanner.js).
 */

const PANEL_REFRESH_MS = 2000;

let tray = null;
let refreshTimeout = null;
let refreshInFlight = false;
let isQuitting = false;
let refreshQueued = false;
let latestProcesses = [];
let prefsWindow = null;
let panelWindow = null;
let latestSnapshot = null;
const history = new History();

const isMac = process.platform === 'darwin';

const ICON_RELATIVE_PATH = path.join('assets', 'icons', 'node-killer.icns');

prefs.initPrefsFromEnvIfEmpty();

const ONE_BY_ONE_TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';

const LIGHTNING_TEMPLATE_DATA_URL =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNicgaGVpZ2h0PScxNicgdmlld0JveD0nMCAwIDE2IDE2Jz48cGF0aCBmaWxsPScjMDAwMDAwJyBkPSdNNy41IDBMMSAxMGg0bC0xIDYgNy0xMGgtNGwwLjUtNnonLz48L3N2Zz4=';

const transparentImage = nativeImage.createFromDataURL(ONE_BY_ONE_TRANSPARENT_PNG);
const lightningImage = nativeImage.createFromDataURL(LIGHTNING_TEMPLATE_DATA_URL);
if (!lightningImage.isEmpty()) {
  lightningImage.setTemplateImage(true);
}
if (!transparentImage.isEmpty()) {
  transparentImage.setTemplateImage(true);
}
const textOnlyImage = transparentImage.resize({ width: 18, height: 18, quality: 'best' });
if (!textOnlyImage.isEmpty()) {
  textOnlyImage.setTemplateImage(true);
}

let cachedTrayIcon = null;

function getTrayIconImage() {
  if (cachedTrayIcon && !cachedTrayIcon.isEmpty()) {
    return cachedTrayIcon;
  }
  const iconPath = getIconPath();
  if (!fs.existsSync(iconPath)) {
    cachedTrayIcon = null;
    return null;
  }
  const image = nativeImage.createFromPath(iconPath);
  if (!image.isEmpty()) {
    image.setTemplateImage(true);
    cachedTrayIcon = image;
    return cachedTrayIcon;
  }
  cachedTrayIcon = null;
  return null;
}

function loadDockIconImage() {
  const iconPath = getIconPath();
  if (!fs.existsSync(iconPath)) return null;
  const image = nativeImage.createFromPath(iconPath);
  if (image && !image.isEmpty()) {
    return image;
  }
  return null;
}

function getIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ICON_RELATIVE_PATH);
  }
  return path.join(__dirname, '..', ICON_RELATIVE_PATH);
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: true }).show();
      return;
    }
  } catch (e) {
    // Fallback to dialog below
  }
  try {
    dialog.showMessageBox({ type: 'info', message: `${title}\n${body}` });
  } catch (e) {
    // As last resort
    console.log(`[Notification] ${title}: ${body}`);
  }
}

async function scanProcessListeners() {
  return scanner.scan({
    allUsers: prefs.getAllUsers(),
    types: prefs.getProcessTypes(),
  });
}

function fmtCores(n) {
  if (n >= 10) return n.toFixed(0);
  if (n >= 0.995) return n.toFixed(1);
  if (n < 0.005) return '0';
  return n.toFixed(2);
}

const HEAT_DOTS = { idle: '', light: '🟢', busy: '🟡', heavy: '🟠', hot: '🔴' };

// --- Panel (popover under the tray icon) -----------------------------------

function createPanelWindow() {
  const window = new BrowserWindow({
    width: 440,
    height: 680,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0d0d' : '#f9f9f7',
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'panel', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.loadFile(path.join(__dirname, 'panel', 'index.html')).catch((err) => console.error('Failed to load panel:', err));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (!app.isPackaged) {
    window.webContents.on('console-message', (event) => console.log(`[panel] ${event.message}`));
  }
  window.on('blur', () => {
    if (!window.webContents.isDevToolsOpened()) hidePanel();
  });
  window.on('closed', () => {
    panelWindow = null;
  });
  return window;
}

function positionPanel() {
  if (!tray || !panelWindow) return;
  const trayBounds = tray.getBounds();
  const winBounds = panelWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const area = display.workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - winBounds.width - 8));
  const y = isMac ? Math.round(trayBounds.y + trayBounds.height + 4) : Math.round(trayBounds.y - winBounds.height - 4);
  panelWindow.setPosition(x, y, false);
}

function showPanel() {
  if (!panelWindow) panelWindow = createPanelWindow();
  positionPanel();
  panelWindow.show();
  panelWindow.focus();
  sendSnapshot();
  performRefresh().finally(scheduleNextRefresh); // switch to the faster panel cadence now
}

function hidePanel() {
  if (panelWindow && panelWindow.isVisible()) panelWindow.hide();
  scheduleNextRefresh();
}

function togglePanel() {
  if (panelWindow && panelWindow.isVisible()) hidePanel();
  else showPanel();
}

function isPanelVisible() {
  return Boolean(panelWindow && panelWindow.isVisible());
}

function sendSnapshot() {
  if (!latestSnapshot || !panelWindow || panelWindow.isDestroyed()) return;
  panelWindow.webContents.send('panel:snapshot', { ...latestSnapshot, colorSlots: prefs.getColorSlots() });
}

function buildContextMenu() {
  const count = latestProcesses.filter((g) => !g.isSelf).length;
  return Menu.buildFromTemplate([
    { label: 'Open Node Killer', click: () => showPanel() },
    { label: 'Refresh', click: async () => { await performRefresh(); scheduleNextRefresh(); } },
    { type: 'separator' },
    {
      label: `Kill everything (${count} task${count === 1 ? '' : 's'})…`,
      enabled: count > 0,
      click: () => killEverything(),
    },
    { type: 'separator' },
    { label: 'Preferences…', click: () => openPreferencesWindow() },
    { label: 'Quit', role: 'quit' },
  ]);
}

async function killEverything() {
  const snapshot = latestProcesses.filter((g) => !g.isSelf);
  if (snapshot.length === 0) return;
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Kill everything'],
      defaultId: 0,
      cancelId: 0,
      message: `Kill all ${snapshot.length} Node/Bun tasks?`,
      detail: 'This includes dev servers, tests, and MCP servers started by other apps. Each process gets SIGTERM, then SIGKILL if it survives.',
    });
    if (response !== 1) return;
  } catch (e) {
    console.error('Kill all confirmation failed:', e);
    return;
  }
  let ok = 0;
  const failed = [];
  for (const group of snapshot) {
    for (const res of await scanner.killGroup(group)) {
      if (res.ok) ok++;
      else failed.push(`${res.pid} (${res.step})`);
    }
  }
  if (failed.length === 0) notify('✅ Kill everything', `${ok} processes terminated.`);
  else notify('⚠️ Kill everything had issues', `${ok} succeeded, ${failed.length} failed — ${failed.join(', ')}`);
  await performRefresh();
  scheduleNextRefresh();
}

function applySnapshot(groups, memory) {
  latestProcesses = Array.isArray(groups) ? groups : [];
  latestSnapshot = buildSnapshot(latestProcesses, history, memory);
  prefs.assignColorSlots(latestSnapshot.projects.filter((p) => p.cores >= 0.05).map((p) => p.key));
  applyDisplayMode();
  const active = latestSnapshot.projects.filter((p) => p.heat.level !== 'idle').length;
  const mem = latestSnapshot.memory;
  tray?.setToolTip(
    `Node Killer — ${fmtCores(latestSnapshot.cores)} of ${latestSnapshot.machineCores} cores busy, ${active} active project${active === 1 ? '' : 's'}` +
      (mem ? `\nMemory ${mem.usedGb} of ${mem.totalGb} GB · ${mem.label}` : '')
  );
  sendSnapshot();
}

function applyDisplayMode() {
  if (!tray) return;
  const mode = prefs.getDisplayMode();
  const cores = latestSnapshot ? latestSnapshot.cores : 0;
  const dot = latestSnapshot ? HEAT_DOTS[latestSnapshot.heat.level] : '';
  const memStatus = latestSnapshot?.memory?.status;
  const memWarn = memStatus === 'critical' || memStatus === 'swapping' ? ' ⚠️' : '';
  const figure = `${dot ? `${dot} ` : ''}${fmtCores(cores)}${memWarn}`;
  if (isMac) {
    if (mode === 'icon-plus-number') {
      tray.setTitle(`⚡️ ${figure}`);
    } else if (mode === 'icon-only') {
      tray.setTitle('');
    } else {
      tray.setTitle(` ${figure} cores `);
    }
  }

  if (mode === 'icon-only') {
    const iconImage = getTrayIconImage();
    if (iconImage) {
      tray.setImage(iconImage);
    } else if (!lightningImage.isEmpty()) {
      tray.setImage(lightningImage);
    } else {
      tray.setImage(transparentImage);
      if (isMac) {
        tray.setTitle('⚡️');
      }
    }
  } else {
    tray.setImage(textOnlyImage);
  }
}

function applyAutoLaunchSetting(enabled) {
  if (!isAutoLaunchEditable()) {
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: app.getPath('exe'),
    });
  } catch (e) {
    console.error('Failed to update auto-launch setting:', e);
  }
}

function isAutoLaunchEditable() {
  return app.isPackaged && isMac && typeof app.setLoginItemSettings === 'function';
}

function createPreferencesWindow() {
  if (prefsWindow) {
    return prefsWindow;
  }

  const window = new BrowserWindow({
    width: 420,
    height: 750,
    title: 'Preferences',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#1c1f26',
    webPreferences: {
      preload: path.join(__dirname, 'preferences', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    prefsWindow = null;
  });

  window.setMenu(null);
  window.loadFile(path.join(__dirname, 'preferences', 'index.html')).catch((err) => {
    console.error('Failed to load preferences window:', err);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  prefsWindow = window;
  return window;
}

function openPreferencesWindow() {
  if (prefsWindow) {
    if (prefsWindow.isMinimized()) prefsWindow.restore();
    prefsWindow.show();
    prefsWindow.focus();
    return;
  }
  createPreferencesWindow();
}

async function performRefresh() {
  if (refreshInFlight) {
    refreshQueued = true;
    return false;
  }
  refreshInFlight = true;
  try {
    const [groups, memory] = await Promise.all([scanProcessListeners(), readMemory().catch(() => null)]);
    applySnapshot(groups, memory);
    return true;
  } catch (e) {
    console.error('Refresh failed:', e);
    return false;
  } finally {
    refreshInFlight = false;
    if (refreshQueued) {
      refreshQueued = false;
      await performRefresh();
    }
  }
}

function createTray() {
  const displayMode = prefs.getDisplayMode();
  let baseImage = textOnlyImage;
  if (displayMode === 'icon-only') {
    baseImage = getTrayIconImage() || (!lightningImage.isEmpty() ? lightningImage : transparentImage);
  }
  try {
    tray = new Tray(baseImage);
  } catch (e) {
    console.error('Failed to create Tray:', e);
    return;
  }
  tray.setToolTip('Node Killer');
  tray.on('click', () => togglePanel());
  tray.on('right-click', () => tray.popUpContextMenu(buildContextMenu()));
  applyDisplayMode();
}

function scheduleNextRefresh() {
  if (isQuitting) return;
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = null;

  // The open panel always updates quickly so the chart moves; otherwise follow the preference.
  const refreshPref = isPanelVisible() ? PANEL_REFRESH_MS : prefs.getRefreshMs();
  if (refreshPref === 'paused') {
    return;
  }

  let delay = Number(refreshPref);
  if (!Number.isFinite(delay) || delay <= 0) {
    delay = DEFAULT_REFRESH_MS;
    prefs.setRefreshMs(delay);
  }

  refreshTimeout = setTimeout(() => {
    if (isQuitting) return;
    performRefresh()
      .catch((e) => console.error('Auto-refresh failed:', e))
      .finally(() => {
        scheduleNextRefresh();
      });
  }, delay);
}

function buildPreferencesPayload() {
  return {
    values: prefs.getAllPreferences(),
    meta: {
      refreshChoices: REFRESH_CHOICES,
      defaultRefreshMs: DEFAULT_REFRESH_MS,
      autoLaunchEditable: isAutoLaunchEditable(),
      isPackaged: app.isPackaged,
      platform: process.platform,
    },
  };
}

ipcMain.handle('prefs:get', async () => {
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-autoLaunch', async (_event, value) => {
  const next = prefs.setAutoLaunch(Boolean(value));
  applyAutoLaunchSetting(next);
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-refresh', async (_event, value) => {
  prefs.setRefreshMs(value);
  await performRefresh();
  scheduleNextRefresh();
  sendSnapshot();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-allUsers', async (_event, value) => {
  const next = prefs.setAllUsers(Boolean(value));
  await performRefresh();
  scheduleNextRefresh();
  sendSnapshot();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-display', async (_event, value) => {
  prefs.setDisplayMode(value);
  applyDisplayMode();
  sendSnapshot();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-processType', async (_event, typeName, enabled) => {
  prefs.setProcessType(typeName, enabled);
  await performRefresh();
  scheduleNextRefresh();
  sendSnapshot();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-processTypes', async (_event, types) => {
  prefs.setProcessTypes(types);
  await performRefresh();
  scheduleNextRefresh();
  sendSnapshot();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:openExternal', async (_event, url) => {
  if (typeof url !== 'string' || !url.trim()) {
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    console.error('Failed to open external link:', err);
    return false;
  }
});

ipcMain.on('panel:ready', () => sendSnapshot());

ipcMain.on('panel:menu', () => {
  if (tray) tray.popUpContextMenu(buildContextMenu());
});

ipcMain.handle('panel:kill-group', async (_event, rootPid) => {
  // Re-scan so we kill what is running now, not what was there two seconds ago.
  const groups = await scanProcessListeners();
  const group = groups.find((g) => g.rootPid === Number(rootPid));
  if (!group) {
    await performRefresh();
    return { ok: true, gone: true };
  }
  const results = await scanner.killGroup(group);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    notify('❌ Could not stop everything', `${group.task} — ${failed.map((r) => `${r.pid} ${r.step} ${r.error || ''}`).join(', ')}`);
  }
  await performRefresh();
  scheduleNextRefresh();
  return { ok: failed.length === 0, failed };
});

ipcMain.handle('panel:set-paused', async (_event, rootPid, paused) => {
  const groups = await scanProcessListeners();
  const group = groups.find((g) => g.rootPid === Number(rootPid));
  if (group) {
    const results = paused ? scanner.pauseGroup(group) : scanner.resumeGroup(group);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) notify(paused ? '❌ Could not pause' : '❌ Could not resume', failed.map((r) => `${r.pid} ${r.error || r.step}`).join(', '));
  }
  await performRefresh();
  scheduleNextRefresh();
});

ipcMain.handle('panel:reveal', async (_event, folder) => {
  if (typeof folder === 'string' && folder.startsWith('/')) await shell.openPath(folder);
});

ipcMain.handle('panel:copy', async (_event, text) => {
  if (typeof text === 'string') clipboard.writeText(text);
});

app.on('window-all-closed', (e) => {
  // Prevent app from quitting (we are menubar-only)
  e.preventDefault();
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    notify('ℹ️ Node Killer', 'Node Killer is already running.');
  });
}

app.whenReady().then(async () => {
  if (isMac && app.dock) {
    const dockIcon = loadDockIconImage();
    if (dockIcon) {
      try {
        app.dock.setIcon(dockIcon);
      } catch (err) {
        if (!app.isPackaged) {
          console.debug('Failed to set dock icon:', err);
        }
      }
    }
    try {
      app.setActivationPolicy('accessory');
    } catch (_) {}
    try { app.dock.hide(); } catch (_) {}
  }

  createTray();
  applyAutoLaunchSetting(prefs.getAutoLaunch());
  await performRefresh();
  scheduleNextRefresh();
  if (process.env.NODEKILLER_OPEN_PANEL === '1') showPanel(); // dev: open without clicking the tray
  if (process.env.NODEKILLER_CAPTURE) {
    // dev: save a screenshot of the panel after a few refreshes
    showPanel();
    setTimeout(async () => {
      const image = await panelWindow.webContents.capturePage();
      fs.writeFileSync(process.env.NODEKILLER_CAPTURE, image.toPNG());
      console.log(`[dev] captured panel to ${process.env.NODEKILLER_CAPTURE}`);
    }, 9000);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (refreshTimeout) clearTimeout(refreshTimeout);
});

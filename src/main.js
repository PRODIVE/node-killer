const { app, Menu, Tray, nativeImage, Notification, dialog, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const prefs = require('./prefs');
const scanner = require('./scanner');
const { REFRESH_CHOICES, DEFAULT_REFRESH_MS } = prefs;

/**
 * ⚡️ Node Killer: a minimal macOS menubar app that hunts down and kills your stray Node.js processes.
 * Processes are grouped by the command that started them and labelled with app + project (see scanner.js).
 */

const MENU_TOP_GROUPS = 15;


let tray = null;
let refreshTimeout = null;
let refreshInFlight = false;
let isQuitting = false;
let refreshQueued = false;
let latestProcesses = [];
let prefsWindow = null;

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

function formatCpu(cpu) {
  return `${Math.round(cpu)}%`;
}

function groupLabel(g) {
  const ports = g.ports.length ? ` :${g.ports.join(',')}` : '';
  const count = g.processCount > 1 ? ` ×${g.processCount}` : '';
  return `${formatCpu(g.cpu).padStart(5)}  ${g.task}${count} — ${scanner.projectLabel(g)}${ports}  ·  ${g.app}`;
}

async function killGroupAndReport(g) {
  const results = await scanner.killGroup(g);
  const failed = results.filter((r) => !r.ok);
  const name = `${g.task} — ${scanner.projectLabel(g)}`;
  if (failed.length === 0) {
    notify('✅ Terminated', `${name} (${results.length} process${results.length === 1 ? '' : 'es'})`);
  } else {
    notify('❌ Could not terminate', `${name} — ${failed.map((r) => `${r.pid} ${r.step} ${r.error || ''}`).join(', ')}`);
  }
  return failed.length === 0;
}

function groupMenuItem(g) {
  const info = (label) => ({ label, enabled: false });
  const submenu = [
    info(`App: ${g.app}`),
    info(`Project: ${scanner.projectLabel(g)}${g.package ? ` (${g.package})` : ''}`),
    info(`CPU ${formatCpu(g.cpu)} · ${g.memoryMb} MB · up ${g.elapsed}`),
  ];
  if (g.ports.length) submenu.push(info(`Ports: ${g.ports.join(', ')}`));
  submenu.push({ type: 'separator' });
  submenu.push({
    label: g.processCount > 1 ? `Kill all ${g.processCount} processes` : `Kill (PID ${g.rootPid})`,
    enabled: !g.isSelf,
    click: async () => {
      await killGroupAndReport(g);
      await performRefresh();
      scheduleNextRefresh();
    },
  });
  if (g.processCount > 1) {
    submenu.push({
      label: 'Kill one…',
      submenu: g.members.map((m) => ({
        label: `${formatCpu(m.cpu).padStart(5)}  ${m.pid}  ${m.task}`,
        click: async () => {
          const [res] = await scanner.killPids([m.pid]);
          notify(res.ok ? '✅ Process terminated' : '❌ Could not terminate', `PID ${m.pid} (${res.step}) ${res.error || ''}`);
          await performRefresh();
          scheduleNextRefresh();
        },
      })),
    });
  }
  submenu.push({ type: 'separator' });
  const folder = g.projectRoot || g.cwd;
  if (folder && folder !== '/') {
    submenu.push({ label: 'Reveal folder in Finder', click: () => shell.openPath(folder) });
  }
  submenu.push({ label: 'Copy command', click: () => clipboard.writeText(g.command) });
  return { label: groupLabel(g), submenu };
}

function buildMenuAndUpdate(procs = []) {
  latestProcesses = Array.isArray(procs) ? procs : [];
  const count = latestProcesses.length;

  applyDisplayMode(count, totalCpu(latestProcesses));
  tray?.setToolTip(`Node Killer — ${count} process groups, ${formatCpu(totalCpu(latestProcesses))} CPU`);

  const items = [];

  const top = latestProcesses.slice(0, MENU_TOP_GROUPS);
  const rest = latestProcesses.slice(MENU_TOP_GROUPS);
  items.push({ label: `Total CPU ${formatCpu(totalCpu(latestProcesses))} across ${count} group${count === 1 ? '' : 's'}`, enabled: false });
  items.push({ type: 'separator' });
  for (const g of top) items.push(groupMenuItem(g));
  if (rest.length) {
    items.push({ label: `${rest.length} more…`, submenu: rest.map(groupMenuItem) });
  }

  items.push({ type: 'separator' });
  items.push({
    label: `Kill all (${count})`,
    enabled: count > 0,
    click: async () => {
      if (count === 0) return;
      try {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['Cancel', 'Kill all'],
          defaultId: 1,
          cancelId: 0,
          message: count === 1 ? 'Kill 1 process group?' : `Kill ${count} process groups?`,
          detail: 'Every process in each listed group will receive SIGTERM. If it survives, SIGKILL is sent next.',
        });
        if (response !== 1) {
          return;
        }
      } catch (e) {
        console.error('Kill all confirmation failed:', e);
        return;
      }
      let ok = 0;
      let fail = 0;
      const failed = [];
      const snapshot = latestProcesses.filter((g) => !g.isSelf);
      for (const group of snapshot) {
        for (const res of await scanner.killGroup(group)) {
          if (res.ok) ok++;
          else {
            fail++;
            failed.push(`${res.pid} (${res.step})`);
          }
        }
      }
      if (fail === 0) {
        notify('✅ Kill all', `${ok} processes terminated.`);
      } else {
        notify('⚠️ Kill all with issues', `${ok} succeeded, ${fail} failed — ${failed.join(', ')}`);
      }
      await performRefresh();
      scheduleNextRefresh();
    },
  });
  items.push({
    label: 'Refresh',
    click: async () => {
      await performRefresh();
      scheduleNextRefresh();
    },
  });
  items.push({
    label: 'Preferences…',
    click: () => {
      openPreferencesWindow();
    },
  });
  items.push({ label: 'Quit', role: 'quit' });

  const menu = Menu.buildFromTemplate(items);
  tray?.setContextMenu(menu);
}

function rebuildMenuFromCache() {
  buildMenuAndUpdate(latestProcesses);
}

function totalCpu(groups) {
  return groups.reduce((sum, g) => sum + g.cpu, 0);
}

function applyDisplayMode(count, cpu = totalCpu(latestProcesses)) {
  if (!tray) return;
  const mode = prefs.getDisplayMode();
  if (isMac) {
    if (mode === 'number') {
      tray.setTitle(` ${count} · ${formatCpu(cpu)} `);
    } else if (mode === 'icon-plus-number') {
      tray.setTitle(`⚡️ ${count} · ${formatCpu(cpu)}`);
    } else if (mode === 'icon-only') {
      tray.setTitle('');
    } else {
      tray.setTitle(` ${count} · ${formatCpu(cpu)} `);
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
    const procs = await scanProcessListeners();
    buildMenuAndUpdate(procs);
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
  applyDisplayMode(latestProcesses.length);
}

function scheduleNextRefresh() {
  if (isQuitting) return;
  if (refreshTimeout) clearTimeout(refreshTimeout);
  refreshTimeout = null;

  const refreshPref = prefs.getRefreshMs();
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
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-allUsers', async (_event, value) => {
  const next = prefs.setAllUsers(Boolean(value));
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-display', async (_event, value) => {
  prefs.setDisplayMode(value);
  applyDisplayMode(latestProcesses.length);
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-processType', async (_event, typeName, enabled) => {
  prefs.setProcessType(typeName, enabled);
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
  return buildPreferencesPayload();
});

ipcMain.handle('prefs:set-processTypes', async (_event, types) => {
  prefs.setProcessTypes(types);
  await performRefresh();
  scheduleNextRefresh();
  rebuildMenuFromCache();
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
});

app.on('before-quit', () => {
  isQuitting = true;
  if (refreshTimeout) clearTimeout(refreshTimeout);
});

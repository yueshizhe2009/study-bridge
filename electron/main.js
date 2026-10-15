'use strict';
const { app, BrowserWindow, Notification, ipcMain, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Supervisor, webcodexTunnelActive, setWebcodexTunnel } = require('./supervisor');
const { ArenaBridge } = require('./arenaBridge');
const { TailManager } = require('./events');
const { ChatPanes } = require('./chatview');
const { LocalEntry } = require('./localEntry');
const settings = require('./settings');

const HUB_DIR = path.join(__dirname, '..', 'hub').replace('app.asar', 'app.asar.unpacked');
const supervisor = new Supervisor();
const arena = new ArenaBridge();
let chatPanes = null;
let tails = null;
let localEntry = null;

// Native Wayland only: Chromium reaches fcitx5/ibus through the text-input protocol, and that path
// stays off unless --enable-wayland-ime is set. It then defaults to text-input-v1, which niri does
// not implement -- the renderer logs "text-input-v1 not available" and the IME stays dead. Pin v3,
// which is what niri and fcitx5's wayland_v2 frontend actually speak. No-op on X11 / XWayland.
// Cloudflare treats a Chromium that reports navigator.webdriver / the AutomationControlled blink
// feature as a bot. The embedded panes are meant to be driven, but we still present as a normal
// browser so the sites' own bot checks pass (see chatview.js CHROME_UA).
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('enable-wayland-ime');
  app.commandLine.appendSwitch('wayland-text-input-version', '3');
}

// Electron's default userData path would be ~/.config/study-bridge -- the same directory as our
// settings.json and mode file. Push Chromium's profile (cache, storage, the ChatGPT login
// partition) into the state dir so config stays clean and readable.
app.setPath('userData', path.join(settings.read().stateDir, 'electron'));

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Study Bridge',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Surface renderer warnings/errors in the terminal; otherwise a broken preload or a CSP
  // violation is invisible from the main-process side.
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error(`[renderer] ${message}`);
  });

  const stateDir = settings.read().stateDir;
  tails = new TailManager(path.join(stateDir, 'events.jsonl'), path.join(stateDir, 'sessions'));
  tails.on('events', (events) => {
    send(win, 'events:append', events);
    for (const ev of events) noteEvent(ev);
  });
  tails.on('session-output', (payload) => send(win, 'session:output', payload));
  tails.startEvents();

  chatPanes = new ChatPanes(win, { onFail: (info) => send(win, 'chat:fail', info) });
  chatPanes.select('chatgpt');

  win.on('closed', () => {
    if (chatPanes) { chatPanes.destroy(); chatPanes = null; }
    if (tails) { tails.stop(); tails = null; }
  });
  return win;
}

function send(win, channel, payload) {
  if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

supervisor.on('status', (status) => {
  broadcast('status:change', status);
  if (status.state === 'error') notify('Study Bridge: tunnel 异常', status.error || '连接中断，正在重试');
});

arena.on('status', (status) => {
  broadcast('arena:change', status);
  if (status.state === 'error') notify('Study Bridge: Arena 通道异常', status.error || '公网入口中断');
});

let lastFailureNotify = 0;

function notify(title, body) {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  } catch { /* notifications are best-effort */ }
}

/** Turn raw events into desktop notifications. Throttled so a burst of failures is one ping. */
function noteEvent(ev) {
  if (!settings.read().notifyOnFailure) return;
  const now = Date.now();
  if (ev.event === 'tool_result' && ev.ok === false && now - lastFailureNotify > 8000) {
    lastFailureNotify = now;
    notify('Study Bridge: 工具调用失败', `${ev.tool}: ${ev.error || 'unknown error'}`);
  }
  if (ev.event === 'model_catalog' && ev.changed) {
    // Rides the existing notifyOnFailure switch rather than adding a setting for a rare event.
    notify('Study Bridge: arena 模型目录已更新',
           `新增 ${(ev.added || []).length} / 移除 ${(ev.removed || []).length}`);
  }
  if (ev.event === 'progress' && ev.percent >= 100) {
    notify('Study Bridge: 任务完成', ev.task || '报告进度 100%');
  }
}

// The catalog is fetched by the hub (Python), never here -- one implementation, shared with the
// list_models tool. A fetch costs ~10s, so the UI only ever reads the cache file and a refresh is
// a fire-and-forget spawn that the renderer does not wait on.
function modelCatalogPath() {
  return path.join(settings.read().stateDir, 'model_catalog.json');
}

function readModelCatalog() {
  try {
    return JSON.parse(fs.readFileSync(modelCatalogPath(), 'utf-8'));
  } catch {
    return {}; // absent, or caught mid-write; the panel renders its own empty state
  }
}

function refreshModelCatalog() {
  try {
    spawn('/usr/bin/python3', [path.join(HUB_DIR, 'models.py'), '--refresh'],
          { cwd: HUB_DIR, detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    console.error('[models]', (e && e.message) || e);
  }
  return { started: true };
}

function readRecentEvents(limit = 300) {
  const file = path.join(settings.read().stateDir, 'events.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean).slice(-limit);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings.read());
  ipcMain.handle('settings:set', (_e, patch) => settings.write(patch || {}));

  ipcMain.handle('mode:get', () => settings.readMode());
  ipcMain.handle('mode:set', (_e, mode) => settings.writeMode(mode));

  ipcMain.handle('hub:start', () => supervisor.start());
  ipcMain.handle('hub:stop', () => supervisor.stop());
  ipcMain.handle('hub:status', () => supervisor.status());

  ipcMain.handle('webcodex:status', () => ({ active: webcodexTunnelActive() }));
  ipcMain.handle('webcodex:set', (_e, active) => setWebcodexTunnel(!!active));

  ipcMain.handle('arena:start', () => arena.start());
  ipcMain.handle('arena:stop', () => arena.stop());
  ipcMain.handle('arena:status', () => arena.status());
  // Clipboard lives in the main process: a renderer write would depend on permissions the
  // sandboxed view does not have.
  ipcMain.handle('arena:copy-prompt', () => {
    const { prompt } = arena.status();
    if (!prompt) return { ok: false };
    clipboard.writeText(prompt);
    return { ok: true };
  });
  ipcMain.handle('arena:open-url', () => {
    const { url } = arena.status();
    if (url) shell.openExternal(url);
    return { ok: !!url };
  });

  // The local entry (third door). Starting it persists enabled=true so it survives a restart.
  ipcMain.handle('localEntry:status', () => (localEntry ? localEntry.status() : { running: false, enabled: false }));
  ipcMain.handle('localEntry:start', async () => {
    settings.write({ localEntry: { enabled: true } });
    if (!localEntry) return { running: false, enabled: true };
    return localEntry.start();
  });
  ipcMain.handle('localEntry:stop', () => {
    settings.write({ localEntry: { enabled: false } });
    return localEntry ? localEntry.stop() : { running: false };
  });

  ipcMain.handle('models:get', () => readModelCatalog());
  ipcMain.handle('models:refresh', () => refreshModelCatalog());
  ipcMain.handle('models:copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

  ipcMain.handle('events:recent', () => readRecentEvents());

  ipcMain.handle('session:subscribe', (_e, id) => { if (tails) tails.subscribeSession(id); return true; });
  ipcMain.handle('session:unsubscribe', (_e, id) => { if (tails) tails.unsubscribeSession(id); return true; });

  ipcMain.handle('patch:get', (_e, id) => {
    if (!/^p_[0-9a-f]{6,}$/.test(String(id))) return null;   // reject path tricks outright
    const file = path.join(settings.read().stateDir, 'patches', `${id}.json`);
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
  });

  ipcMain.handle('chat:bounds', (_e, rect) => { if (chatPanes) chatPanes.setBounds(rect); return true; });
  ipcMain.handle('chat:reload', () => { if (chatPanes) chatPanes.reload(); return true; });
  ipcMain.handle('chat:external', () => { if (chatPanes) chatPanes.openExternal(); return true; });
  ipcMain.handle('chat:focus', () => { if (chatPanes) chatPanes.focus(); return true; });
  ipcMain.handle('chat:sources', () => (chatPanes ? chatPanes.status() : { active: null, sources: [] }));
  ipcMain.handle('chat:select', (_e, name) => (chatPanes ? chatPanes.select(String(name)) : null));

  ipcMain.handle('state:open', () => shell.openPath(settings.read().stateDir));
}

app.whenReady().then(() => {
  // Materialise the mode file on first run so the hub's posture matches the app's default
  // (the hub hard-falls-back to 'ask' when the file is absent).
  try {
    if (!fs.existsSync(settings.MODE_FILE)) settings.writeMode(settings.read().mode);
  } catch { /* non-fatal */ }
  registerIpc();
  createWindow();

  // Warm the model catalog in the background; the panel stays empty until this lands.
  refreshModelCatalog();

  // The local entry outlives individual windows (its getPanes closure reads the current one).
  localEntry = new LocalEntry({ getPanes: () => chatPanes, log: (s) => console.log(s) });
  if (settings.read().localEntry.enabled) {
    localEntry.start().catch((e) => console.error('[localEntry]', (e && e.message) || e));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  try { supervisor.stop(); } catch { /* ignore */ }
  try { arena.stop(); } catch { /* ignore */ }
  try { if (localEntry) localEntry.stop(); } catch { /* ignore */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

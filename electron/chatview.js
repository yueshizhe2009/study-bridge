'use strict';
// The conversation pane: embedded web AI views, one per entry point.
//
// By default these are plain browser views -- they do NOT inject prompts or click anything. The
// human types; the web AI calls local tools over a tunnel; results come back and the page
// continues on its own. If a site refuses to render in an embedded view, we fall back to the
// system browser.
//
// The ONE exception is the local entry (localEntry.js): when it is explicitly enabled, a local
// agent may drive a pane through webContentsOf() + injector.js. Everything here stays injection-
// free; that capability lives behind the loopback door and is off unless settings enable it.
//
// Each site gets its OWN persistent partition, so the ChatGPT session and the Arena session never
// share cookies and logging out of one cannot disturb the other.
const { WebContentsView, shell } = require('electron');

const CHATGPT_URL = 'https://chatgpt.com/';
const ARENA_URL = 'https://arena.ai/agent';

// Cloudflare fronts chatgpt.com and challenges Electron's stock UA (which advertises
// "Electron/34.5.8") outright -- the pane gets stuck on the "请稍候…" interstitial. Present as
// plain desktop Chrome instead. Kept Chromium-accurate (version pinned to this Electron build) so
// the Client-Hints / UA-derivation the sites do stay consistent.
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/132.0.6834.210 Safari/537.36';

const SOURCES = [
  { name: 'chatgpt', label: 'ChatGPT', url: CHATGPT_URL, partition: 'persist:study-bridge-chatgpt' },
  { name: 'arena', label: 'Arena', url: ARENA_URL, partition: 'persist:study-bridge-arena' },
];

class ChatView {
  constructor(win, { url, partition, onFail } = {}) {
    this.url = url;
    this.onFail = onFail;
    this.loaded = false;
    this.failed = false;
    this.view = new WebContentsView({
      webPreferences: {
        partition, contextIsolation: true, nodeIntegration: false, sandbox: true,
        userAgent: CHROME_UA,
      },
    });
    this.win = win;
    win.contentView.addChildView(this.view);
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });  // hidden until shown

    const wc = this.view.webContents;
    // webPreferences.userAgent is ignored for WebContentsView on this Electron; set it on the
    // webContents directly, before any navigation. See CHROME_UA above for why.
    try { wc.setUserAgent(CHROME_UA); } catch { /* older Electron: keep the webPreferences value */ }
    wc.on('did-fail-load', (_e, code, desc, failedUrl) => {
      if (code === -3) return;  // ERR_ABORTED: normal during navigation
      this.failed = true;
      this.onFail && this.onFail({ code, desc, url: failedUrl });
    });
    wc.setWindowOpenHandler(({ url: target }) => { shell.openExternal(target); return { action: 'deny' }; });
  }

  /** Nothing is fetched until the pane is actually shown -- loading a site the user is not
   *  looking at wastes a login check, bandwidth and a renderer process. */
  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    this.view.webContents.loadURL(this.url);
  }

  setBounds(rect) {
    if (!rect) return;
    this.view.setBounds({
      x: Math.round(rect.x), y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)),
    });
  }

  hide() { this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 }); }

  reload() { this.failed = false; this.loaded = true; this.view.webContents.loadURL(this.url); }

  openExternal() { shell.openExternal(this.url); }

  focus() { try { this.view.webContents.focus(); } catch { /* ignore */ } }

  destroy() {
    try { this.win.contentView.removeChildView(this.view); } catch { /* already gone */ }
    try { this.view.webContents.close(); } catch { /* already gone */ }
  }
}

/** Holds every embedded site and swaps which one is painted into the pane. */
class ChatPanes {
  constructor(win, { onFail } = {}) {
    this.win = win;
    this.onFail = onFail;
    this.views = new Map();
    this.active = SOURCES[0].name;
    this.rect = null;
  }

  sources() { return SOURCES.map(({ name, label }) => ({ name, label })); }

  current() { return this.views.get(this.active) || null; }

  _ensure(name) {
    let v = this.views.get(name);
    if (v) return v;
    const src = SOURCES.find((s) => s.name === name);
    if (!src) return null;
    v = new ChatView(this.win, {
      url: src.url, partition: src.partition,
      // Only surface a failure for the pane the user is actually looking at; a background
      // site that fails to load is not worth an error card.
      onFail: (info) => { if (name === this.active) this.onFail && this.onFail({ ...info, name }); },
    });
    this.views.set(name, v);
    return v;
  }

  select(name) {
    if (!SOURCES.some((s) => s.name === name)) return this.status();
    const prev = this.current();
    if (prev && name !== this.active) prev.hide();
    this.active = name;
    const v = this._ensure(name);
    v.ensureLoaded();
    if (this.rect) v.setBounds(this.rect);
    return this.status();
  }

  status() { return { active: this.active, sources: this.sources() }; }

  /** The webContents of a pane, created and loading on demand. Powers the local entry's injection
   *  path (see localEntry.js + injector.js). Returns null for an unknown site name. */
  webContentsOf(name) {
    const v = this._ensure(name);
    return v ? v.view.webContents : null;
  }

  setBounds(rect) {
    if (!rect) return;
    this.rect = rect;
    const v = this.current();
    if (v) v.setBounds(rect);
  }

  reload() { const v = this.current(); if (v) v.reload(); }
  openExternal() { const v = this.current(); if (v) v.openExternal(); }
  focus() { const v = this.current(); if (v) v.focus(); }

  destroy() {
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
  }
}

module.exports = { ChatPanes, CHATGPT_URL, ARENA_URL };

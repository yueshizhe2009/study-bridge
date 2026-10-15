'use strict';
// The THIRD door: a loopback-only HTTP entry that lets a local agent (cc-haha, Claudian, a shell
// script) drive the embedded web-AI panes -- type a message into ChatGPT/Arena and read the reply.
//
// This is the reverse direction of the two tunnels: those let a WEB agent call LOCAL tools; this
// lets a LOCAL agent call a WEB conversation. Bound to 127.0.0.1 and gated by a path token, and
// off by default (settings.localEntry.enabled), because it can act as your logged-in account.
const http = require('http');
const crypto = require('crypto');
const settings = require('./settings');
const injector = require('./injector');

class LocalEntry {
  /** @param {{getPanes: () => (import('./chatview').ChatPanes|null), log?: (s:string)=>void}} opts */
  constructor(opts = {}) {
    this.getPanes = opts.getPanes || (() => null);
    this.log = opts.log || (() => {});
    this.server = null;
    this.port = null;
  }

  /** Stable per-install token, generated once and persisted (same pattern as the arena door). */
  _ensureToken() {
    const s = settings.read();
    if (s.localEntry && s.localEntry.token && s.localEntry.token.length >= 16) return s.localEntry.token;
    const token = crypto.randomBytes(24).toString('hex');
    settings.write({ localEntry: { token } });
    return token;
  }

  status() {
    const s = settings.read();
    return {
      running: !!this.server,
      port: this.port,
      enabled: !!(s.localEntry && s.localEntry.enabled),
      token: this.server ? s.localEntry.token : null,
    };
  }

  async start() {
    if (this.server) return this.status();
    const s = settings.read();
    const port = (s.localEntry && s.localEntry.port) || 8770;
    const token = this._ensureToken();
    this.server = http.createServer((req, res) => this._handle(req, res, token));
    // A /say call blocks until the site finishes streaming; keep that well under the request cap.
    this.server.requestTimeout = 0;
    this.server.on('error', (e) => this.log(`[localEntry] ${e.message}`));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', resolve);
    });
    this.port = port;
    this.log(`[localEntry] 就绪 http://127.0.0.1:${port}/`);
    return this.status();
  }

  stop() {
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
    }
    this.server = null;
    this.port = null;
    return this.status();
  }

  _json(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  _body(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    });
  }

  /** Resolve a pane to a loaded webContents, waiting for the first navigation to settle. */
  async _wc(target) {
    const panes = this.getPanes();
    if (!panes) return null;
    const wc = panes.webContentsOf(target);
    if (!wc) return null;
    if (wc.isLoading()) {
      await new Promise((r) => {
        const done = () => r();
        wc.once('did-finish-load', done);
        wc.once('did-fail-load', done);
        setTimeout(done, 15000);
      });
    }
    return wc;
  }

  async _handle(req, res, token) {
    let parts;
    try { parts = new URL(req.url, 'http://127.0.0.1').pathname.split('/').filter(Boolean); }
    catch { return this._json(res, 400, { ok: false, error: 'bad url' }); }
    const [action, given] = parts;

    if (given !== token) return this._json(res, 403, { ok: false, error: 'bad token' });

    try {
      if (action === 'status') {
        const panes = this.getPanes();
        return this._json(res, 200, { ok: true, ...this.status(),
          panes: panes ? panes.status() : null });
      }

      if (action === 'read') {
        const target = new URL(req.url, 'http://127.0.0.1').searchParams.get('target') || 'chatgpt';
        const wc = await this._wc(target);
        if (!wc) return this._json(res, 200, { ok: false, error: `pane 不可用: ${target}` });
        const out = await wc.executeJavaScript(injector.readScript(target), true);
        return this._json(res, 200, { ...out, target });
      }

      if (action === 'probe') {
        const target = new URL(req.url, 'http://127.0.0.1').searchParams.get('target') || 'chatgpt';
        const wc = await this._wc(target);
        if (!wc) return this._json(res, 200, { ok: false, error: `pane 不可用: ${target}` });
        const out = await wc.executeJavaScript(injector.probeScript(target), true);
        return this._json(res, 200, { ...out, target });
      }

      if (action === 'inject' || action === 'say') {
        if (req.method !== 'POST') return this._json(res, 405, { ok: false, error: 'use POST' });
        const { target = 'chatgpt', text = '', timeout } = await this._body(req);
        if (!text) return this._json(res, 400, { ok: false, error: 'text 为空' });
        const wc = await this._wc(target);
        if (!wc) return this._json(res, 200, { ok: false, error: `pane 不可用: ${target}` });

        const script = action === 'say'
          ? injector.sayAndWaitScript(target, text, timeout)
          : injector.composeScript(target, text);
        const out = await wc.executeJavaScript(script, true);
        return this._json(res, 200, { ...out, target, reply: action === 'say' ? (out && out.text) : undefined });
      }

      return this._json(res, 404, { ok: false, error: `unknown action: ${action}` });
    } catch (e) {
      return this._json(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  }
}

module.exports = { LocalEntry };

'use strict';
// Owns the SECOND entry point: a public Cloudflare quick tunnel in front of hub/http_mcp.py.
//
// Deliberately shaped like supervisor.js -- same state machine, same restart backoff, same
// "systemd may own this, in which case do not spawn a second copy" arbitration -- so there is
// one mental model for both doors into the workspace.
//
// The difference from Supervisor is that this one manages a PAIR of processes:
//   python3 hub/http_mcp.py      the MCP endpoint, bound to 127.0.0.1 only
//   cloudflared tunnel --url ... the public face, whose assigned hostname changes every restart
// Instead of an OpenAI health endpoint we read cloudflared's own log for the hostname it was
// given, which is why this one keeps stdio pipes where Supervisor uses 'ignore'.
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const settings = require('./settings');

const HUB_DIR = path.join(__dirname, '..', 'hub').replace('app.asar', 'app.asar.unpacked');
const HTTP_SERVER = path.join(HUB_DIR, 'http_mcp.py');
const READY_TIMEOUT_MS = 60000;   // cloudflared registration over a slow link can take a while
const WATCH_INTERVAL_MS = 10000;
const MAX_RESTARTS = 5;
const LOG_TAIL_LINES = 200;

// cloudflared prints its assigned hostname once, in a banner. Quick tunnels get a random
// subdomain, so this is the only way to learn the URL -- there is no API for it.
const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/;

// The banner prints the hostname BEFORE the edge connection is established, so a URL alone is
// not readiness -- probing it too early just gets a connection refused. This line is the signal
// that traffic actually flows. (cloudflared also retries internally and re-logs it on reconnect.)
const REGISTERED_RE = /Registered tunnel connection/;

// Units that may already own these processes. If any is active we must NOT spawn our own: two
// cloudflared processes would each get a different hostname, and two http_mcp processes would
// collide on the port.
const EXTERNAL_UNITS = [
  'study-bridge-arena.service',
  'study-bridge-http-mcp.service',
  'study-bridge-cloudflared.service',
];

// Units whose journal mentions the public hostname, in preference order.
const URL_LOGGING_UNITS = [
  'study-bridge-arena.service',
  'study-bridge-cloudflared.service',
];

const PROMPT_SUFFIX = '快速连接这个 MCP（URL），明确使用规则，熟悉可用工具，做好处理接下来一系列工作的准备。';

// The pre-integration standalone units kept their token in their own env file. Only those two
// ever did -- study-bridge-arena.service runs run-arena.js, which takes the token from
// settings.json like the app does. Reading the wrong one produces a prompt with a dead token.
const ENV_FILE = path.join(settings.CONFIG_DIR, 'http-mcp.env');
const LEGACY_ENV_UNITS = ['study-bridge-http-mcp.service', 'study-bridge-cloudflared.service'];

function unitActive(unit) {
  const r = spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf-8' });
  return (r.stdout || '').trim() === 'active';
}

function externalOwner() {
  return EXTERNAL_UNITS.find(unitActive) || null;
}

/** Best-effort current hostname, read back from the journals of the units that actually log one.
 *  Only cloudflared (and run-arena.js echoing it) ever prints this -- the http_mcp unit never
 *  does -- so the search is over the loggers, not over whichever unit happens to be the owner.
 *  The last match wins: a quick tunnel that restarted gets a new hostname and re-logs it. */
function tunnelUrlFromUnits(units) {
  for (const unit of units) {
    const r = spawnSync('journalctl', ['--user', '-u', unit, '-o', 'cat', '--no-pager'],
      { encoding: 'utf-8', maxBuffer: 8 * 1024 * 1024 });
    const hits = String(r.stdout || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
    if (hits && hits.length) return hits[hits.length - 1];
  }
  return null;
}

class ArenaBridge extends EventEmitter {
  /** @param {{ownsService?: boolean}} [opts] opts.ownsService mirrors Supervisor: set it when this
   *  object IS the systemd unit, otherwise the unit's own "active" state is mistaken for a rival. */
  constructor(opts = {}) {
    super();
    this.ownsService = !!opts.ownsService;
    this.child = null;        // python hub/http_mcp.py
    this.tunnel = null;       // cloudflared
    this.state = 'stopped';   // stopped | starting | ready | degraded | error
    this.url = null;
    this.registered = false;
    this.restarts = 0;
    this.error = null;
    this.external = null;     // unit name that owns it, if any
    this._owner = undefined;  // memo for the systemd probe (status() is called by the UI)
    this._ownerAt = 0;
    this._ownerUrl = null;
    this._healthFails = 0;
    this._watchTimer = null;
    this._stopRequested = false;
    this._log = [];
  }

  /** Which unit, if any, is running this channel. Memoised for a few seconds because status()
   *  is polled by the UI and this shells out to systemctl. */
  _external() {
    const now = Date.now();
    if (now - this._ownerAt < 4000) return this._owner;
    this._ownerAt = now;
    this._owner = this.ownsService ? null : externalOwner();
    this._ownerUrl = this._owner ? tunnelUrlFromUnits(URL_LOGGING_UNITS) : null;
    return this._owner;
  }

  status() {
    const s = settings.read();
    const owner = this._external();
    // A live systemd unit means the channel IS up, even though this object never started it.
    // Reporting "stopped" there would be a lie the user can see through immediately.
    const delegating = !!owner && this.state === 'stopped';
    const url = delegating ? this._ownerUrl : this.url;
    const token = delegating && LEGACY_ENV_UNITS.includes(owner)
      ? (settings.readEnvFile(ENV_FILE).HTTP_MCP_TOKEN || s.arena.token)
      : s.arena.token;
    return {
      state: delegating ? 'ready' : this.state,
      url,
      prompt: url && token ? this.promptFor(url, token) : null,
      port: s.arena.port,
      modeCap: s.arena.modeCap,
      allowExec: !!s.arena.allowExec,
      pid: this.child ? this.child.pid : null,
      tunnelPid: this.tunnel ? this.tunnel.pid : null,
      restarts: this.restarts,
      error: this.error,
      managedBy: owner ? `systemd (${owner})` : 'app',
    };
  }

  promptFor(url, token) {
    return `${url}/mcp/${token} ${PROMPT_SUFFIX}`;
  }

  tail() {
    return this._log.join('\n');
  }

  _set(patch) {
    Object.assign(this, patch);
    this.emit('status', this.status());
  }

  _note(line) {
    this._log.push(line);
    if (this._log.length > LOG_TAIL_LINES) this._log.splice(0, this._log.length - LOG_TAIL_LINES);
  }

  /** Generate and persist the path token on first start so it is stable across restarts. */
  _ensureToken() {
    const s = settings.read();
    if (s.arena.token && s.arena.token.length >= 16) return s.arena.token;
    const token = crypto.randomBytes(24).toString('hex');
    settings.write({ arena: { token } });
    return token;
  }

  async start() {
    if (this.child || this.tunnel) return this.status();
    this._stopRequested = false;
    this._healthFails = 0;

    if (!this.ownsService) {
      const owner = externalOwner();
      if (owner) {
        this.external = owner;
        this._set({ state: 'ready', error: null });
        return this.status();
      }
    }
    this.external = null;
    this._set({ state: 'starting', error: null, url: null, registered: false });

    const s = settings.read();
    const token = this._ensureToken();
    const bind = `127.0.0.1:${s.arena.port}`;

    // --- the MCP endpoint -------------------------------------------------
    // Env is the only control surface http_mcp.py has; the mode ceiling and the capability
    // denylist are per-process so they cannot be widened by anything the remote agent sends.
    const env = {
      ...process.env,
      HTTP_MCP_TOKEN: token,
      HTTP_MCP_BIND: bind,
      STUDY_BRIDGE_MODE_CAP: s.arena.modeCap || 'ask',
      STUDY_BRIDGE_CAP_DENY: s.arena.allowExec ? '' : 'exec',
    };
    const child = spawn('/usr/bin/python3', [HTTP_SERVER], {
      cwd: HUB_DIR,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    child.unref();
    child.stdout.on('data', (b) => this._note(String(b).trimEnd()));
    child.stderr.on('data', (b) => this._note(String(b).trimEnd()));
    child.on('exit', (code) => {
      this.child = null;
      if (this._stopRequested) return;
      this._set({ state: 'error', error: `http_mcp exited (code ${code})` });
      this._scheduleRestart();
    });
    this.child = child;

    if (!await this._waitLocal()) {
      this._set({ state: 'error', error: `本地 ${bind} 未就绪（端口被占？token 太短？）` });
      this._killAll();
      return this.status();
    }

    // --- the public face --------------------------------------------------
    const tunnel = spawn(s.cloudflaredBin || 'cloudflared',
      ['tunnel', '--no-autoupdate',
        '--protocol', s.arena.protocol || 'http2',
        '--url', `http://127.0.0.1:${s.arena.port}`],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    tunnel.unref();
    const onTunnelLog = (b) => {
      const text = String(b);
      this._note(text.trimEnd());
      const m = URL_RE.exec(text);
      if (m && !this.url) this._set({ url: m[0] });
      if (!this.registered && REGISTERED_RE.test(text)) this.registered = true;
    };
    tunnel.stdout.on('data', onTunnelLog);
    tunnel.stderr.on('data', onTunnelLog);
    tunnel.on('exit', (code) => {
      this.tunnel = null;
      this.url = null;
      if (this._stopRequested) return;
      this._set({ state: 'error', error: `cloudflared exited (code ${code})` });
      this._scheduleRestart();
    });
    this.tunnel = tunnel;

    const url = await this._waitUrl();
    if (url) this._set({ state: 'ready', url, error: null });
    else this._set({ state: 'error', error: 'cloudflared 未在超时内注册到边缘节点' });

    this._startWatch();
    return this.status();
  }

  _waitLocal() {
    const deadline = Date.now() + 10000;
    return (async () => {
      while (Date.now() < deadline) {
        if (this._stopRequested) return false;
        if (await this._localAlive()) return true;
        await new Promise((r) => setTimeout(r, 400));
      }
      return false;
    })();
  }

  _waitUrl() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    return (async () => {
      while (Date.now() < deadline) {
        if (this._stopRequested) return null;
        if (this.url && this.registered) return this.url;
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    })();
  }

  /** Liveness of the local endpoint. A token-less GET answers 405 when the server is up, which
   *  distinguishes "listening" from "some other process grabbed the port". */
  _localAlive() {
    const { port } = settings.read().arena;
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/mcp/`, { timeout: 2500 }, (res) => {
        res.resume();
        resolve(res.statusCode === 405 || res.statusCode === 404);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  _startWatch() {
    this._stopWatch();
    this._watchTimer = setInterval(async () => {
      if (this._stopRequested || !this.child) return;
      if (await this._localAlive()) {
        this._healthFails = 0;
        if (this.state === 'degraded') this._set({ state: 'ready', error: null });
        return;
      }
      this._healthFails += 1;
      if (this._healthFails < 6) {
        this._set({ state: 'degraded', error: `本地端点无响应 (${this._healthFails}/6)` });
        return;
      }
      this._healthFails = 0;
      this._set({ state: 'error', error: '本地端点持续无响应，重启通道' });
      this._restart();
    }, WATCH_INTERVAL_MS);
  }

  _stopWatch() {
    if (this._watchTimer) clearInterval(this._watchTimer);
    this._watchTimer = null;
  }

  _restart() {
    this._killAll();
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this._stopRequested) return;
    if (this.restarts >= MAX_RESTARTS) {
      this._set({ state: 'error', error: `已连续重启 ${MAX_RESTARTS} 次，放弃` });
      return;
    }
    this.restarts += 1;
    const delay = Math.min(30000, 1000 * 2 ** this.restarts);
    setTimeout(() => {
      if (!this._stopRequested && !this.child && !this.tunnel) this.start();
    }, delay);
  }

  /** SIGTERM the process group, then escalate. cloudflared's shutdown is a graceful drain that
   *  can stall for seconds on a flaky link, and a half-dead tunnel keeps the port and the
   *  hostname alive -- so a survivor gets SIGKILL rather than being leaked. */
  _kill(proc) {
    if (!proc) return;
    const pid = proc.pid;
    const signal = (sig) => {
      try { process.kill(-pid, sig); }
      catch { try { proc.kill(sig); } catch { /* already gone */ } }
    };
    signal('SIGTERM');
    const t = setTimeout(() => {
      try { process.kill(pid, 0); } catch { return; }   // exited on its own
      signal('SIGKILL');
    }, 3000);
    if (t.unref) t.unref();
  }

  _killAll() {
    this._kill(this.tunnel);
    this._kill(this.child);
    this.tunnel = null;
    this.child = null;
    this.url = null;
    this.registered = false;
  }

  stop() {
    this._stopRequested = true;
    this._stopWatch();
    if (!this.external) this._killAll();
    this.external = null;
    this.restarts = 0;
    this._set({ state: 'stopped', url: null, error: null });
    return this.status();
  }
}

module.exports = { ArenaBridge, externalOwner, HTTP_SERVER };

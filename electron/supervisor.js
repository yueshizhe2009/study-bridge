'use strict';
// Owns the tunnel-client process: generates its config, starts it, watches health, restarts on
// failure, and shuts it down without orphaning children.
//
// No Electron import here on purpose -- it is a plain Node EventEmitter so it can be exercised
// with `node -e` and reused by a future headless systemd unit.
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const settings = require('./settings');

// In a packaged build the app lives inside app.asar, which python cannot execute from -- the
// hub is flagged asarUnpack, so point at the unpacked copy.
const HUB_SERVER = path.join(__dirname, '..', 'hub', 'server.py').replace('app.asar', 'app.asar.unpacked');
const READY_TIMEOUT_MS = 30000;
const WATCH_INTERVAL_MS = 5000;
const MAX_RESTARTS = 5;
// Verified: when its MCP child dies, tunnel-client exits itself and does NOT respawn it. So the
// child 'exit' handler below is the PRIMARY restart trigger. This health threshold is only a
// secondary net for a tunnel that is alive but wedged (health bad, process not exiting).
const HEALTH_FAIL_THRESHOLD = Number(process.env.STUDY_BRIDGE_HEALTH_FAILS || 6);
const CONTROL_PLANE_BASE = 'https://api.openai.com';

class Supervisor extends EventEmitter {
  /** @param {{ownsService?: boolean}} [opts] opts.ownsService must be set by run-hub.js: that
   *  script IS study-bridge-hub.service, and a Type=simple unit reports itself "active" the
   *  instant it forks -- so without this the unit detects itself as a second client and bails. */
  constructor(opts = {}) {
    super();
    this.ownsService = !!opts.ownsService;
    this.child = null;
    this.state = 'stopped'; // stopped | starting | ready | error
    this.healthUrl = null;
    this.tunnelId = null;
    this.restarts = 0;
    this.error = null;
    this.credentialSource = null;
    this.external = false;      // true => the systemd unit owns the tunnel, we must not spawn
    this._healthFails = 0;
    this._watchTimer = null;
    this._stopRequested = false;
  }

  status() {
    return {
      state: this.state,
      healthUrl: this.healthUrl,
      tunnelId: this.tunnelId,
      pid: this.child ? this.child.pid : null,
      restarts: this.restarts,
      error: this.error,
      credentialSource: this.credentialSource,
      managedBy: this.external ? 'systemd' : 'app',
    };
  }

  _set(patch) {
    Object.assign(this, patch);
    this.emit('status', this.status());
  }

  _paths() {
    const s = settings.read();
    const stateDir = s.stateDir;
    const tunnelDir = path.join(stateDir, 'tunnel');
    fs.mkdirSync(tunnelDir, { recursive: true });
    return {
      settings: s,
      tunnelDir,
      configFile: path.join(tunnelDir, 'tunnel-client.json'),
      healthFile: path.join(tunnelDir, 'health.url'),
      logFile: path.join(tunnelDir, 'tunnel.log'),
    };
  }

  /** Write the tunnel-client config. Workspace/state are passed as CLI args to the MCP server so
   *  we never depend on the child inheriting our environment (that inheritance is unverified). */
  writeConfig() {
    const { settings: s, configFile, healthFile, logFile } = this._paths();
    const creds = settings.readCredentials();
    const env = creds.env;
    const tunnelId = creds.tunnelId;
    this.credentialSource = creds.source;
    if (!tunnelId || !env.CONTROL_PLANE_API_KEY) {
      throw new Error(`no tunnel credentials. Run scripts/set-tunnel-credentials.sh `
        + `(looked in ${s.envFile}, then ${s.fallbackEnvFile})`);
    }
    const command = `/usr/bin/python3 ${HUB_SERVER} --workspace ${s.workspace} --state-dir ${s.stateDir}`;
    const config = {
      admin_ui: { open_browser: false },
      config_version: 1,
      control_plane: { api_key: 'env:CONTROL_PLANE_API_KEY', base_url: CONTROL_PLANE_BASE, tunnel_id: tunnelId },
      health: { listen_addr: '127.0.0.1:0', url_file: healthFile },
      log: { file: logFile, format: 'json', level: 'info' },
      mcp: { commands: [{ channel: 'main', command }] },
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    this.tunnelId = tunnelId;
    return { configFile, healthFile, env, tunnelId };
  }

  async start() {
    if (this.child) return this.status();
    this._stopRequested = false;
    this._healthFails = 0;

    // If the systemd unit already owns this tunnel, do NOT spawn a second client: two clients on
    // one tunnel makes command routing ambiguous. Just report the unit's state. Skipped when we
    // ARE that unit (see constructor).
    if (!this.ownsService && hubUnitActive()) {
      const { healthFile } = this._paths();
      let url = '';
      try { url = fs.readFileSync(healthFile, 'utf-8').trim(); } catch { /* not written yet */ }
      const ok = url ? await this._isReady(url) : false;
      this.external = true;
      this.credentialSource = settings.readCredentials().source;
      this._set(ok
        ? { state: 'ready', healthUrl: url, error: null }
        : { state: 'error', healthUrl: null,
            error: 'study-bridge-hub.service 在运行但健康端点不可达（看 journalctl --user -u study-bridge-hub）' });
      return this.status();
    }
    this.external = false;
    this._set({ state: 'starting', error: null });
    let cfg;
    try {
      cfg = this.writeConfig();
    } catch (err) {
      this._set({ state: 'error', error: String(err.message || err) });
      return this.status();
    }
    try { fs.unlinkSync(cfg.healthFile); } catch { /* fresh start */ }

    const child = spawn(settings.read().tunnelClientBin, ['run', '--config', cfg.configFile], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...cfg.env },
    });
    child.unref();
    this.child = child;
    child.on('exit', (code) => {
      this.child = null;
      if (this._stopRequested) return;
      this._set({ state: 'error', error: `tunnel-client exited (code ${code})` });
      this._scheduleRestart();
    });

    const ready = await this._waitReady(cfg.healthFile);
    if (ready) this._set({ state: 'ready', healthUrl: ready });
    else this._set({ state: 'error', error: 'health endpoint never came up' });

    this._startWatch(cfg.healthFile);
    return this.status();
  }

  async _waitReady(healthFile) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this._stopRequested) return null;
      try {
        const url = fs.readFileSync(healthFile, 'utf-8').trim();
        if (url && await this._isReady(url)) return url;
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  _isReady(baseUrl) {
    return new Promise((resolve) => {
      const req = http.get(`${baseUrl}/readyz`, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  _startWatch(healthFile) {
    this._stopWatch();
    this._watchTimer = setInterval(async () => {
      if (this._stopRequested || !this.child) return;
      let url = '';
      try { url = fs.readFileSync(healthFile, 'utf-8').trim(); } catch { /* not written */ }
      const ok = url ? await this._isReady(url) : false;

      if (ok) {
        this._healthFails = 0;
        if (this.state !== 'ready') this._set({ state: 'ready', healthUrl: url, error: null });
        return;
      }
      this._healthFails += 1;
      if (this._healthFails < HEALTH_FAIL_THRESHOLD) {
        // Most dips are tunnel-client respawning its own MCP child; surface it, do not restart.
        this._set({ state: 'degraded', error: `health check failing (${this._healthFails}/${HEALTH_FAIL_THRESHOLD})` });
        return;
      }
      this._healthFails = 0;
      this._set({ state: 'error', error: 'health failed past the self-heal window; restarting tunnel' });
      this._restart();
    }, WATCH_INTERVAL_MS);
  }

  _stopWatch() {
    if (this._watchTimer) clearInterval(this._watchTimer);
    this._watchTimer = null;
  }

  _restart() {
    this._killChild();
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this._stopRequested) return;
    if (this.restarts >= MAX_RESTARTS) {
      this._set({ state: 'error', error: `giving up after ${MAX_RESTARTS} restarts` });
      return;
    }
    this.restarts += 1;
    const delay = Math.min(30000, 1000 * 2 ** this.restarts);
    setTimeout(() => { if (!this._stopRequested && !this.child) this.start(); }, delay);
  }

  _killChild() {
    const child = this.child;
    if (!child) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    this.child = null;
  }

  stop() {
    this._stopRequested = true;
    this._stopWatch();
    if (!this.external) this._killChild();   // never kill a tunnel owned by systemd
    this.external = false;
    this.restarts = 0;
    this._set({ state: 'stopped', healthUrl: null, error: null });
    return this.status();
  }
}

// ---- WebCodex arbitration -------------------------------------------------------------------
// The hub and WebCodex share ONE tunnel id. Both clients can connect simultaneously (verified),
// but the control plane gives no routing guarantee with two live clients, so the reliable posture
// is for Study Bridge to be the only client. These helpers only start/stop the unit -- no unit
// file is ever modified.
function hubUnitActive() {
  const r = spawnSync('systemctl', ['--user', 'is-active', 'study-bridge-hub.service'], { encoding: 'utf-8' });
  return (r.stdout || '').trim() === 'active';
}

function webcodexTunnelActive() {
  const r = spawnSync('systemctl', ['--user', 'is-active', 'webcodex-tunnel.service'], { encoding: 'utf-8' });
  return (r.stdout || '').trim() === 'active';
}

function setWebcodexTunnel(active) {
  const r = spawnSync('systemctl', ['--user', active ? 'start' : 'stop', 'webcodex-tunnel.service'], { encoding: 'utf-8' });
  return { ok: r.status === 0, output: (r.stderr || r.stdout || '').trim() };
}

module.exports = { Supervisor, webcodexTunnelActive, setWebcodexTunnel, hubUnitActive, HUB_SERVER };

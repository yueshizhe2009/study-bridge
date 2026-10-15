'use strict';
// Settings + mode-file access. Deliberately free of any Electron import so it can be unit-tested
// with plain node and reused by the supervisor.
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.STUDY_BRIDGE_CONFIG_DIR || path.join(os.homedir(), '.config', 'study-bridge');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const MODE_FILE = path.join(CONFIG_DIR, 'mode');

function discoverTunnelClient() {
  const base = path.join(os.homedir(), '.local', 'state', 'webcodex', 'tools', 'tunnel-client');
  try {
    const versions = fs.readdirSync(base).sort().reverse();
    for (const v of versions) {
      const bin = path.join(base, v, 'linux-amd64', 'tunnel-client');
      if (fs.existsSync(bin)) return bin;
    }
  } catch { /* fall through */ }
  return 'tunnel-client';
}

/** cloudflared carries the second entry point (see arenaBridge.js). Prefer a real path so the
 *  spawned process does not depend on the service's PATH, which systemd units do not inherit. */
function discoverCloudflared() {
  const candidates = [
    '/usr/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* try next */ }
  }
  return 'cloudflared';
}

const DEFAULTS = {
  workspace: path.join(os.homedir(), 'workspace'),
  stateDir: path.join(os.homedir(), '.local', 'state', 'study-bridge'),
  tunnelClientBin: discoverTunnelClient(),
  // Primary credential file -- Study Bridge's own tunnel (never written by the app; you fill it
  // once with scripts/set-tunnel-credentials.sh). Falls back to WebCodex's tunnel.env so the app
  // still works before you set up a dedicated tunnel.
  envFile: path.join(CONFIG_DIR, 'tunnel.env'),
  fallbackEnvFile: path.join(os.homedir(), '.config', 'webcodex', 'tunnel.env'),
  tunnelId: '',            // blank -> taken from the credential file
  mode: 'code',            // ask | plan | code ; the app's default posture for a personal tool
  // Desktop notification when a tool call fails or a task reports completion. Cross-turn
  // auto-continue is deliberately NOT implemented: it would need page injection, which this
  // design rules out (the human drives the conversation; we only make the tool layer reliable).
  notifyOnFailure: true,
  cloudflaredBin: discoverCloudflared(),
  // The SECOND entry point: a public quick-tunnel onto hub/http_mcp.py, so a web agent (e.g.
  // arena.ai/agent) can drive the same tools the OpenAI tunnel exposes. Kept off by default --
  // starting it points a public URL at the workspace, so that stays an explicit user action.
  // modeCap/allowExec are separate from the app-wide mode toggle on purpose: the internet-facing
  // door stays read-only while a ChatGPT session on the other tunnel can still be in 'code'.
  arena: {
    enabled: false,
    port: 8766,
    token: '',          // blank -> generated and persisted on first start
    modeCap: 'ask',     // ask | plan | code
    allowExec: false,   // false -> STUDY_BRIDGE_CAP_DENY=exec (edits yes, shell no)
    // cloudflared defaults to QUIC, which needs unfiltered UDP. Behind a TUN/proxy setup the
    // handshake dies with "failed to dial to edge with quic: timeout". Measured here: http2
    // registered in 6s while quic never registered at all in 60s.
    protocol: 'http2',  // http2 | quic
  },
  // The THIRD door (localEntry.js): a loopback-only HTTP entry that lets a LOCAL agent (cc-haha /
  // Claudian) type a message into the embedded ChatGPT/Arena panes and read the reply back -- the
  // reverse direction of the two tunnels. This is the page-injection path the rest of the app
  // deliberately avoids, so it is OFF by default: whoever can reach 127.0.0.1:<port>/<token> can
  // drive your logged-in account.
  localEntry: {
    enabled: false,
    port: 8770,
    token: '',          // blank -> generated and persisted on first start
  },
};

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function read() {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch { /* missing or malformed -> defaults */ }
  const merged = { ...DEFAULTS, ...stored };
  // Deep-merge nested groups: a caller that patches one field (e.g. just the port) must not
  // silently drop the rest of the group back to undefined.
  merged.arena = { ...DEFAULTS.arena, ...(stored.arena || {}) };
  merged.localEntry = { ...DEFAULTS.localEntry, ...(stored.localEntry || {}) };
  return merged;
}

function write(patch) {
  ensureDir();
  const current = read();
  const next = { ...current, ...patch };
  if (patch && patch.arena) next.arena = { ...current.arena, ...patch.arena };
  if (patch && patch.localEntry) next.localEntry = { ...current.localEntry, ...patch.localEntry };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

function readMode() {
  try {
    const value = fs.readFileSync(MODE_FILE, 'utf-8').trim().toLowerCase();
    return ['ask', 'plan', 'code'].includes(value) ? value : 'ask';
  } catch {
    return 'ask';
  }
}

function writeMode(mode) {
  if (!['ask', 'plan', 'code'].includes(mode)) throw new Error(`invalid mode: ${mode}`);
  ensureDir();
  fs.writeFileSync(MODE_FILE, mode);
  return mode;
}

/**
 * Resolve where the tunnel credentials come from: Study Bridge's own env file first, then the
 * WebCodex fallback. Reports which one won so the UI can say so honestly.
 */
function readCredentials() {
  const s = read();
  const own = readEnvFile(s.envFile);
  const fallback = s.fallbackEnvFile ? readEnvFile(s.fallbackEnvFile) : {};
  const merged = {};
  for (const key of ['CONTROL_PLANE_TUNNEL_ID', 'CONTROL_PLANE_API_KEY']) {
    merged[key] = own[key] || fallback[key] || '';
  }
  const source = own.CONTROL_PLANE_API_KEY && own.CONTROL_PLANE_TUNNEL_ID ? 'own'
    : (fallback.CONTROL_PLANE_API_KEY && fallback.CONTROL_PLANE_TUNNEL_ID ? 'webcodex' : 'none');
  return { env: merged, source, tunnelId: s.tunnelId || merged.CONTROL_PLANE_TUNNEL_ID || '' };
}

/** Parse a KEY=VALUE env file without shelling out and without ever logging the values. */
function readEnvFile(file) {
  const out = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

module.exports = {
  CONFIG_DIR, SETTINGS_FILE, MODE_FILE,
  DEFAULTS, ensureDir, read, write, readMode, writeMode, readEnvFile, readCredentials,
  discoverTunnelClient, discoverCloudflared,
};

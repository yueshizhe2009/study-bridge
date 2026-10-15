'use strict';
// Run the public entry point headless -- no Electron window -- and keep it alive until Ctrl-C.
// Mirrors run-hub.js: the counterpart for the Cloudflare tunnel + hub/http_mcp.py pair, for when
// you want the Arena door open without the GUI, or as a systemd unit.
//
// Usage:  node scripts/run-arena.js
const { ArenaBridge } = require('../electron/arenaBridge');

// ownsService: this script is what study-bridge-arena.service runs, so it must not mistake the
// unit's own "active" state for a competing owner and refuse to start.
const bridge = new ArenaBridge({ ownsService: true });

bridge.on('status', (s) => {
  const mark = s.state === 'ready' ? '🟢' : s.state === 'error' ? '🔴' : '⏳';
  const line = `${mark} ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${s.state}`
    + (s.url ? ` ${s.url}` : '') + (s.error ? ` — ${s.error}` : '');
  console.log(line);
});

bridge.start().then((s) => {
  if (s.state === 'ready') {
    console.log(`\n公网地址: ${s.url}`);
    console.log(`权限: ${s.modeCap}${s.allowExec ? ' (含 shell 执行)' : ' (禁 exec)'}`);
    console.log('\n把下面这段作为 Arena 新对话的第一句整段贴出去：');
    console.log(s.prompt);
    console.log('\n保持本窗口开着；按 Ctrl-C 停止。\n');
  } else {
    console.error('启动失败:', JSON.stringify(s));
    process.exitCode = 1;
  }
}).catch((err) => { console.error('ERROR', err); process.exitCode = 1; });

function shutdown() {
  console.log('\n停止通道…');
  try { bridge.stop(); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode || 0), 3500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

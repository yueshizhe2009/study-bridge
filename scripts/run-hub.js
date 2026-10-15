'use strict';
// Run the tunnel headless -- no Electron window -- and keep it alive in the foreground until
// Ctrl-C. Use this when you want the tunnel up while you work in a browser (e.g. while creating
// or testing the ChatGPT connector), or to keep it running without the GUI.
//
// Usage:  node scripts/run-hub.js
const { Supervisor } = require('../electron/supervisor');

// ownsService: this script is what study-bridge-hub.service runs, so it must not mistake the
// unit's own "active" state for a competing client and refuse to start.
const sup = new Supervisor({ ownsService: true });
let ready = false;

sup.on('status', (s) => {
  const mark = s.state === 'ready' ? '🟢' : s.state === 'error' ? '🔴' : '⏳';
  console.log(`${mark} ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${JSON.stringify(s)}`);
  if (s.state === 'ready') ready = true;
});

sup.start().then((s) => {
  if (s.state === 'ready') {
    console.log(`\n隧道已就绪: ${s.healthUrl}`);
    console.log('凭据来源:', s.credentialSource, '| tunnel:', s.tunnelId);
    console.log('\n现在可以去 ChatGPT 建连接器了（Connection=Tunnel，选这个名字对应的那条，');
    console.log('Authentication=No authentication，然后 Scan Tools）。');
    console.log('保持本窗口开着；按 Ctrl-C 停止。\n');
  } else {
    console.error('启动失败:', JSON.stringify(s));
    process.exitCode = 1;
  }
}).catch((err) => { console.error('ERROR', err); process.exitCode = 1; });

function shutdown() {
  console.log('\n停止隧道…');
  try { sup.stop(); } catch { /* ignore */ }
  setTimeout(() => process.exit(process.exitCode || 0), 900);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

'use strict';
// Smoke test for the supervisor without Electron: start the tunnel, wait for ready, stop.
// Usage: node scripts/supervisor-smoke.js
const { Supervisor } = require('../electron/supervisor');

const sup = new Supervisor();
sup.on('status', (s) => console.log(JSON.stringify(s)));

const HOLD_MS = Number(process.env.HOLD_MS || 4000);

function finish(code) {
  try { sup.stop(); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 1500);
}

(async () => {
  const started = await sup.start();
  if (started.state !== 'ready') {
    console.error('FAILED to reach ready:', JSON.stringify(started));
    return finish(1);
  }
  console.log('READY at', started.healthUrl);
  setTimeout(() => { console.log('stopping'); finish(0); }, HOLD_MS);
})().catch((err) => { console.error('ERROR', err); finish(1); });

setTimeout(() => { console.error('TIMEOUT'); finish(1); }, 60000).unref?.();

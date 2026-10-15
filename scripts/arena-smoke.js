'use strict';
// Exercise ArenaBridge end to end without touching a running deployment:
// starts the pair on a throwaway port with a throwaway token, waits for the public hostname,
// checks both the local endpoint and the public URL, then shuts everything down.
//
//   node scripts/arena-smoke.js [port]
//
// Exits non-zero on any failed expectation, so it doubles as a regression check.
const { ArenaBridge } = require('../electron/arenaBridge');
const settings = require('../electron/settings');
const fs = require('fs');
const http = require('http');
const https = require('https');

const PORT = Number(process.argv[2] || 8799);

function get(url, { method = 'GET', token } = {}) {
  const mod = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    const req = mod.request(url, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.setTimeout(15000);
    req.end();
  });
}

(async () => {
  const original = settings.read().arena;
  settings.write({ arena: { port: PORT, token: '', modeCap: 'ask', allowExec: false } });
  const bridge = new ArenaBridge({ ownsService: true });
  let failed = 0;
  const check = (label, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
    if (!ok) failed += 1;
  };

  try {
    const started = await bridge.start();
    console.log('state:', started.state, '| url:', started.url, '| err:', started.error);
    check('开始后进入 ready', started.state === 'ready', started.error || '');
    check('解析出 trycloudflare 地址', /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(started.url || ''));
    check('生成了 token', (settings.read().arena.token || '').length === 48);
    check('提示词含本机不暴露的 token 路径', (started.prompt || '').includes(settings.read().arena.token));

    const local = await get(`http://127.0.0.1:${PORT}/mcp/`);
    check('本机端点存活（GET -> 405）', local === 405, `got ${local}`);

    const pub = await get(`${started.url}/mcp/`);
    check('公网 URL 存活（GET -> 405）', pub === 405, `got ${pub}`);

    const wrong = await get(`${started.url}/mcp/WRONG`, { method: 'POST' });
    check('错误 token 被拒（POST -> 404）', wrong === 404, `got ${wrong}`);

    console.log('\n--- http_mcp 日志尾部 ---');
    console.log(bridge.tail().split('\n').slice(-4).join('\n'));
  } catch (err) {
    console.log('FAIL  未捕获异常:', err && err.message);
    failed += 1;
  } finally {
    bridge.stop();
    settings.write({ arena: original });
    // Long enough to cover the SIGTERM -> SIGKILL escalation if cloudflared's drain stalls.
    await new Promise((r) => setTimeout(r, 5000));
    // `pgrep -x` matches the executable name only. A `pgrep -f` pattern would also match the
    // shell running the pgrep itself (its command line contains the pattern), reporting a
    // phantom orphan every time.
    const pids = require('child_process').execSync('pgrep -x cloudflared || true', { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
    const orphans = pids.filter((pid) => {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').includes(`127.0.0.1:${PORT}`); }
      catch { return false; }
    }).join(' ');
    check('退出后无遗留 cloudflared', orphans === '', orphans);
    console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
    process.exit(failed === 0 ? 0 : 1);
  }
})();

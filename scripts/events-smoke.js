'use strict';
// Smoke test for the observability pipeline without Electron:
//   tail events.jsonl  ->  run the MCP probe (which emits events)  ->  assert we saw them.
// Usage: node scripts/events-smoke.js
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const { TailManager } = require('../electron/events');

const STATE_DIR = process.env.STUDY_BRIDGE_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'study-bridge');
const tails = new TailManager(path.join(STATE_DIR, 'events.jsonl'), path.join(STATE_DIR, 'sessions'));

const seen = [];
tails.on('events', (events) => {
  for (const ev of events) seen.push(ev);
});
tails.startEvents();

const probe = spawn('/usr/bin/python3', [path.join(__dirname, 'mcp-probe.py'), '--tool', 'read_files', '--args', '{"paths":["欢迎.md"]}'], { stdio: 'ignore' });

const deadline = Date.now() + 15000;
const timer = setInterval(() => {
  const call = seen.find((e) => e.event === 'tool_call' && e.tool === 'read_files');
  const result = seen.find((e) => e.event === 'tool_result' && e.tool === 'read_files');
  if (call && result) {
    console.log(`OK: saw tool_call(read_files) seq=${call.seq} and tool_result ok=${result.ok} in ${result.duration_ms}ms`);
    finish(0);
  } else if (Date.now() > deadline) {
    console.error('FAIL: did not observe the expected events; saw', JSON.stringify(seen.slice(-5)));
    finish(1);
  }
}, 300);

function finish(code) {
  clearInterval(timer);
  tails.stop();
  try { probe.kill(); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 200);
}

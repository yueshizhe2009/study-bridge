'use strict';
// Wiring: status bar, mode switch, tunnel controls, chat-pane geometry, event fan-out.
const $ = (id) => document.getElementById(id);
const SB = window.SB;

let running = false;

// ---- chat pane geometry -------------------------------------------------------------------
// The embedded site is a native child view, not part of this DOM, so the renderer has to tell
// the main process exactly where it sits. A native view always paints ABOVE the window's own
// DOM, so the pane's title bar has to be excluded -- otherwise it covers the tabs and buttons
// that live there and they become invisible and unclickable.
function reportChatBounds() {
  const pane = $('chat-pane');
  const rect = pane.getBoundingClientRect();
  const title = pane.querySelector('.pane-title').getBoundingClientRect();
  const top = title.bottom;
  window.bridge.chatSetBounds({
    x: rect.x, y: top, width: rect.width, height: Math.max(0, rect.bottom - top),
  });
}

// ---- statusbar ----------------------------------------------------------------------------
function renderStatus(status) {
  const managed = status.managedBy === 'systemd';   // tunnel owned by study-bridge-hub.service
  running = ['starting', 'ready', 'degraded'].includes(status.state);
  const pill = $('status-tunnel');
  const labels = { stopped: '未启动', starting: '启动中…', ready: '已就绪', degraded: '重连中…', error: '错误' };
  pill.textContent = `tunnel: ${labels[status.state] || status.state}${managed ? ' · systemd' : ''}`;
  pill.className = 'pill ' + (status.state === 'ready' ? 'pill-ok'
    : status.state === 'error' ? 'pill-bad' : 'pill-idle');
  pill.title = status.error || '';
  $('status-url').textContent = status.healthUrl || '';
  $('btn-toggle').textContent = managed ? 'systemd 托管' : (running ? '停止' : '启动');
  $('btn-toggle').disabled = managed;

  const creds = $('creds-state');
  const sources = {
    own: ['凭据: 独立 tunnel', 'pill-ok'],
    webcodex: ['凭据: 复用 WebCodex', 'pill-idle'],
    none: ['凭据: 未配置', 'pill-bad'],
  };
  const [label, cls] = sources[status.credentialSource] || sources.none;
  creds.textContent = label;
  creds.className = 'pill ' + cls;
}

function renderMode(mode) {
  for (const btn of document.querySelectorAll('.mode')) btn.classList.toggle('active', btn.dataset.mode === mode);
}

async function renderWebcodex() {
  const { active } = await window.bridge.webcodexStatus();
  const el = $('webcodex-state');
  el.textContent = `WebCodex tunnel: ${active ? '运行中' : '已停止'}`;
  el.className = 'pill ' + (active ? 'pill-ok' : 'pill-idle');
  $('btn-webcodex').textContent = active ? '让位（停 WebCodex）' : '恢复 WebCodex';
}

// ---- arena (public entry) -------------------------------------------------------------------
// The permission select maps onto two separate settings: the mode ceiling and whether the shell
// capability is denied. 'code' is the only pair that hands out process execution.
const PERMS = {
  ask: { modeCap: 'ask', allowExec: false },
  'code-noexec': { modeCap: 'code', allowExec: false },
  code: { modeCap: 'code', allowExec: true },
};

function permOf({ modeCap, allowExec }) {
  if (modeCap !== 'code') return 'ask';
  return allowExec ? 'code' : 'code-noexec';
}

function renderArena(status) {
  const managed = String(status.managedBy).startsWith('systemd');
  const running = ['starting', 'ready', 'degraded'].includes(status.state);
  const labels = { stopped: '未启动', starting: '启动中…', ready: '已就绪', degraded: '重连中…', error: '错误' };
  const pill = $('arena-state');
  pill.textContent = labels[status.state] || status.state;
  pill.className = 'pill ' + (status.state === 'ready' ? 'pill-ok'
    : status.state === 'error' ? 'pill-bad' : 'pill-idle');
  pill.title = status.error || '';

  $('arena-url').textContent = status.url || '';
  $('arena-url').title = status.url || '';
  $('arena-perm').value = permOf(status);
  $('arena-perm').disabled = running || managed;
  $('btn-arena-copy').disabled = !status.prompt;
  $('btn-arena-open').disabled = !status.url;
  $('btn-arena-toggle').textContent = managed ? 'systemd 托管' : (running ? '停止' : '启动');
  $('btn-arena-toggle').disabled = managed;

  $('arena-warn').textContent = permOf(status) === 'code' ? '⚠ 已授予远程 shell 执行'
    : (permOf(status) === 'code-noexec' ? '⚠ 远程可写工作区' : '');
}

async function applyPerm(value) {
  const patch = PERMS[value] || PERMS.ask;
  await window.bridge.settingsSet({ arena: patch });
  // The cap is read at process start, so a change only takes effect on a restart.
  const status = await window.bridge.arenaStatus();
  if (['starting', 'ready', 'degraded'].includes(status.state)) {
    await window.bridge.arenaStop();
    renderArena(await window.bridge.arenaStart());
  } else {
    renderArena(status);
  }
}

// ---- events -------------------------------------------------------------------------------
function handleEvent(ev) {
  if (ev.event === 'session') SB.terminal.noteSession(ev);
  if (ev.event === 'model_catalog') SB.models.noteChange(ev);
}

async function openPatch(id) {
  const patch = await window.bridge.patchGet(id);
  if (patch) SB.diff.render(patch);
}

// ---- embedded web panes ---------------------------------------------------------------------
let activeChat = null;

function renderChatTabs({ active, sources }) {
  activeChat = active;
  const box = $('chat-tabs');
  box.textContent = '';
  for (const src of sources) {
    const b = document.createElement('button');
    b.className = 'tab' + (src.name === active ? ' active' : '');
    b.textContent = src.label;
    b.addEventListener('click', () => selectChat(src.name));
    box.appendChild(b);
  }
  $('chat-placeholder-title').textContent = `正在内嵌 ${
    (sources.find((s) => s.name === active) || {}).label || '对话页面'}…`;
}

async function selectChat(name) {
  renderChatTabs(await window.bridge.chatSelect(name));
  // The native view is swapped behind the DOM, so the pane has to re-announce its rectangle.
  reportChatBounds();
  $('chat-placeholder').classList.add('hidden');
}

async function init() {
  SB.activity.init($('activity'), openPatch);
  SB.diff.init($('diff-panel'), $('diff-title'), $('diff-body'));
  SB.terminal.init($('terminal'), $('session-select'));
  SB.models.init({
    panel: $('models-panel'), body: $('models-body'), tabs: $('models-tabs'),
    search: $('models-search'), fresh: $('models-fresh'), count: $('models-count'),
    refresh: $('btn-models-refresh'), close: $('btn-models-close'),
  });
  SB.models.render(await window.bridge.modelsGet());

  const s = await window.bridge.settingsGet();
  $('workspace-label').textContent = `工作区: ${s.workspace}`;
  renderMode(await window.bridge.modeGet());
  renderStatus(await window.bridge.hubStatus());
  renderArena(await window.bridge.arenaStatus());
  renderChatTabs(await window.bridge.chatSources());
  await renderWebcodex();

  const recent = await window.bridge.eventsRecent();
  SB.activity.add(recent);
  for (const ev of recent) handleEvent(ev);

  window.bridge.onStatus(renderStatus);
  window.bridge.onArena(renderArena);
  window.bridge.onEvents((events) => { SB.activity.add(events); events.forEach(handleEvent); });
  window.bridge.onSessionOutput((payload) => SB.terminal.append(payload));
  window.bridge.onChatFail(() => $('chat-placeholder').classList.remove('hidden'));

  $('btn-toggle').addEventListener('click', async () => {
    renderStatus(running ? await window.bridge.hubStop() : await window.bridge.hubStart());
  });
  for (const btn of document.querySelectorAll('.mode')) {
    btn.addEventListener('click', async () => renderMode(await window.bridge.modeSet(btn.dataset.mode)));
  }
  $('btn-webcodex').addEventListener('click', async () => {
    const { active } = await window.bridge.webcodexStatus();
    await window.bridge.webcodexSet(!active);
    await renderWebcodex();
  });
  $('btn-arena-toggle').addEventListener('click', async () => {
    const status = await window.bridge.arenaStatus();
    const running = ['starting', 'ready', 'degraded'].includes(status.state);
    renderArena(running ? await window.bridge.arenaStop() : await window.bridge.arenaStart());
  });
  $('arena-perm').addEventListener('change', (e) => applyPerm(e.target.value));
  $('btn-arena-copy').addEventListener('click', async () => {
    const { ok } = await window.bridge.arenaCopyPrompt();
    const btn = $('btn-arena-copy');
    const was = btn.textContent;
    btn.textContent = ok ? '已复制 ✓' : '复制失败';
    setTimeout(() => { btn.textContent = was; }, 1500);
  });
  $('btn-arena-open').addEventListener('click', () => window.bridge.arenaOpenUrl());
  $('btn-models').addEventListener('click', () => SB.models.toggle());
  $('btn-state-dir').addEventListener('click', () => window.bridge.openStateDir());
  $('btn-diff-close').addEventListener('click', () => SB.diff.hide());
  $('btn-chat-focus').addEventListener('click', () => window.bridge.chatFocus());
  $('btn-chat-reload').addEventListener('click', () => window.bridge.chatReload());
  $('btn-chat-external').addEventListener('click', () => window.bridge.chatExternal());

  new ResizeObserver(reportChatBounds).observe($('chat-pane'));
  window.addEventListener('resize', reportChatBounds);
  reportChatBounds();
}

window.addEventListener('DOMContentLoaded', init);

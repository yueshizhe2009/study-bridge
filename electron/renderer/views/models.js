'use strict';
// arena.ai model catalog. Read-only: the hub (Python) owns fetching and caching, this panel only
// renders the cache file -- so opening it never blocks on the ~10s upstream fetch.
window.SB = window.SB || {};
window.SB.models = (function () {
  const ARENA_LABELS = {
    text: 'agent (text)',
    code: 'code',
    search: 'search',
    'text-to-image': '图像',
    'text-to-video': '视频',
    document: '文档',
  };
  const CAP_LABELS = { text: '文', image: '图', file: '件', audio: '音', video: '视' };

  let panel = null, bodyEl = null, tabsEl = null, searchEl = null, freshEl = null, countEl = null;
  let data = {};
  let arena = 'text';
  let query = '';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function arenaKeys() {
    const present = Object.keys(data.arenas || {});
    return Object.keys(ARENA_LABELS).filter((k) => present.includes(k))
      .concat(present.filter((k) => !ARENA_LABELS[k]));
  }

  function capsOf(m) {
    const input = (m.capabilities || {}).inputCapabilities || {};
    return Object.keys(CAP_LABELS).filter((k) => input[k]).map((k) => CAP_LABELS[k]);
  }

  function freshness() {
    if (!data.fetched_at) return '未缓存 — 点「刷新」拉取（约 10 秒）';
    const mins = Math.max(0, Math.round((data.age_seconds || 0) / 60));
    const age = mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`;
    return (data.stale ? '⚠ 已过期 · ' : '缓存于 ') + age;
  }

  function rows() {
    const all = (data.arenas || {})[arena] || [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((m) => [m.public_name, m.display_name, m.organization, m.provider, m.id]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }

  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.textContent = '';
    for (const key of arenaKeys()) {
      const n = ((data.arenas || {})[key] || []).length;
      const btn = el('button', 'tab' + (key === arena ? ' active' : ''),
                     `${ARENA_LABELS[key] || key} ${n}`);
      btn.addEventListener('click', () => { arena = key; renderTabs(); renderBody(); });
      tabsEl.appendChild(btn);
    }
  }

  function renderBody() {
    if (!bodyEl) return;
    const list = rows();
    bodyEl.textContent = '';
    if (countEl) countEl.textContent = `${list.length} 个`;
    if (!list.length) {
      bodyEl.appendChild(el('div', 'placeholder',
        data.fetched_at ? '没有匹配的模型' : '尚未拉取模型目录'));
      return;
    }
    for (const m of list) {
      const r = el('div', 'model-row');
      r.appendChild(el('span', 'model-rank mono dim', String(m.rank)));
      const name = el('span', 'model-name mono', m.public_name || m.display_name || m.id || '?');
      name.title = `id: ${m.id || ''}\nprovider: ${m.provider || ''}`;
      r.appendChild(name);
      r.appendChild(el('span', 'model-org dim', m.organization || ''));
      const caps = el('span', 'model-caps');
      for (const c of capsOf(m)) caps.appendChild(el('span', 'cap', c));
      r.appendChild(caps);
      const copy = el('button', 'mini', '复制');
      copy.addEventListener('click', async () => {
        const ok = await window.bridge.modelsCopy(m.public_name || m.id || '');
        copy.textContent = ok ? '已复制' : '失败';
        setTimeout(() => { copy.textContent = '复制'; }, 1200);
      });
      r.appendChild(copy);
      bodyEl.appendChild(r);
    }
  }

  function render(payload) {
    data = (payload && typeof payload === 'object') ? payload : {};
    if (!arenaKeys().includes(arena)) arena = arenaKeys()[0] || 'text';
    if (freshEl) freshEl.textContent = freshness();
    renderTabs();
    renderBody();
  }

  function reload() { return window.bridge.modelsGet().then(render); }

  function noteChange(ev) {
    // A changed catalog means the cache on disk is newer than what we rendered.
    if (panel && !panel.classList.contains('hidden')) reload();
    else if (ev && ev.changed && freshEl) freshEl.textContent = '目录已更新 — 打开面板查看';
  }

  function show() { if (panel) { panel.classList.remove('hidden'); reload(); } }
  function hide() { if (panel) panel.classList.add('hidden'); }
  function toggle() { if (panel) (panel.classList.contains('hidden') ? show() : hide()); }

  function init(opts) {
    panel = opts.panel; bodyEl = opts.body; tabsEl = opts.tabs;
    searchEl = opts.search; freshEl = opts.fresh; countEl = opts.count;
    if (searchEl) searchEl.addEventListener('input', () => { query = searchEl.value; renderBody(); });
    if (opts.refresh) {
      opts.refresh.addEventListener('click', () => {
        if (freshEl) freshEl.textContent = '拉取中…（约 10 秒）';
        window.bridge.modelsRefresh();
      });
    }
    if (opts.close) opts.close.addEventListener('click', hide);
  }

  return { init, render, noteChange, show, hide, toggle };
})();

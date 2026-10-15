'use strict';
// Activity stream: one row per event, newest at the bottom, capped so the DOM cannot grow forever.
window.SB = window.SB || {};
window.SB.activity = (function () {
  const MAX_ROWS = 800;
  let list = null;
  let onOpenPatch = null;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function stamp(ts) {
    try { return new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false }); }
    catch { return ''; }
  }

  function row(ev) {
    const r = el('div', 'ev');
    r.appendChild(el('span', 'ev-time mono', stamp(ev.ts)));
    switch (ev.event) {
      case 'server_start':
        r.classList.add('ev-ok');
        r.appendChild(el('span', 'ev-kind', 'server'));
        r.appendChild(el('span', null, `启动 · 模式 ${ev.mode} · ${(ev.tools || []).length} 个工具`));
        break;
      case 'tool_call':
        r.appendChild(el('span', 'ev-kind', 'call'));
        r.appendChild(el('span', 'ev-tool mono', ev.tool));
        r.appendChild(el('span', 'dim', (ev.arg_keys || []).join(', ')));
        break;
      case 'tool_result': {
        const ok = ev.ok !== false;
        r.classList.add(ok ? 'ev-ok' : 'ev-bad');
        r.appendChild(el('span', 'ev-kind', ok ? 'ok' : 'err'));
        r.appendChild(el('span', 'ev-tool mono', ev.tool));
        r.appendChild(el('span', 'dim', ev.duration_ms != null ? `${ev.duration_ms}ms` : ''));
        if (!ok && ev.error) r.appendChild(el('span', 'ev-err', ev.error));
        break;
      }
      case 'patch': {
        r.classList.add('ev-ok');
        r.appendChild(el('span', 'ev-kind', 'patch'));
        const files = ev.files || [];
        const added = files.reduce((n, f) => n + (f.added || 0), 0);
        const removed = files.reduce((n, f) => n + (f.removed || 0), 0);
        r.appendChild(el('span', null, `${files.length} 个文件  +${added} -${removed}`));
        const btn = el('button', 'mini', '查看 diff');
        btn.addEventListener('click', () => onOpenPatch && onOpenPatch(ev.patch_id));
        r.appendChild(btn);
        break;
      }
      case 'progress': {
        r.classList.add('ev-progress');
        r.appendChild(el('span', 'ev-kind', 'task'));
        const label = [ev.task, ev.percent != null ? `${ev.percent}%` : null, ev.message]
          .filter(Boolean).join(' · ');
        r.appendChild(el('span', null, label));
        break;
      }
      case 'session':
        r.appendChild(el('span', 'ev-kind', ev.action === 'start' ? 'run' : 'exit'));
        r.appendChild(el('span', 'mono', (ev.command || []).join(' ') || ev.id));
        if (ev.action === 'exit') r.appendChild(el('span', 'dim', `exit ${ev.returncode}`));
        break;
      default:
        r.appendChild(el('span', 'ev-kind', ev.event));
    }
    return r;
  }

  function init(listEl, openPatch) {
    list = listEl;
    onOpenPatch = openPatch;
  }

  function add(events) {
    if (!list) return;
    const stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
    for (const ev of events) list.appendChild(row(ev));
    while (list.childElementCount > MAX_ROWS) list.removeChild(list.firstChild);
    if (stick) list.scrollTop = list.scrollHeight;
  }

  return { init, add };
})();

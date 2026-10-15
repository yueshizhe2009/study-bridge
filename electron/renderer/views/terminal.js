'use strict';
// Terminal panel: tails the selected PTY session's log via the main process.
window.SB = window.SB || {};
window.SB.terminal = (function () {
  const MAX_CHARS = 200000;
  let out = null;
  let select = null;
  let current = null;
  let rawText = '';
  const DISPLAY_LINE_CHARS = 44;

  function init(outEl, selectEl) {
    out = outEl; select = selectEl;
    select.addEventListener('change', () => subscribe(select.value));
  }

  function ensureOption(id, label) {
    if (![...select.options].some((o) => o.value === id)) {
      const opt = document.createElement('option');
      opt.value = id; opt.textContent = label || id;
      select.appendChild(opt);
    }
  }

  async function subscribe(id) {
    if (!id || id === current) return;
    if (current) await window.bridge.sessionUnsubscribe(current);
    current = id;
    select.value = id;
    rawText = '';
    out.textContent = '';
    out.title = '';
    await window.bridge.sessionSubscribe(id);
  }

  function noteSession(ev) {
    ensureOption(ev.id, (ev.command || []).join(' ') || ev.id);
    if (ev.action === 'start') subscribe(ev.id);
  }

  function append(payload) {
    if (payload.id !== current) return;
    rawText += payload.text;
    if (rawText.length > MAX_CHARS) rawText = rawText.slice(-MAX_CHARS);
    // Keep the narrow side panel readable; the full unabridged output remains available on hover.
    out.title = rawText;
    out.textContent = rawText.split('\n').map((line) => line.length > DISPLAY_LINE_CHARS
      ? line.slice(0, DISPLAY_LINE_CHARS - 1) + '…' : line).join('\n');
    out.scrollTop = out.scrollHeight;
  }

  return { init, noteSession, append };
})();

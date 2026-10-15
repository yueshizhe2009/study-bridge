'use strict';
// Minimal unified-diff renderer: colourises +/-/@@ lines. No parsing library, no XSS surface
// (everything goes through textContent).
window.SB = window.SB || {};
window.SB.diff = (function () {
  let panel = null;
  let title = null;
  let body = null;

  function init(panelEl, titleEl, bodyEl) {
    panel = panelEl; title = titleEl; body = bodyEl;
  }

  function lineClass(line) {
    if (line.startsWith('+++') || line.startsWith('---')) return 'd-meta';
    if (line.startsWith('@@')) return 'd-hunk';
    if (line.startsWith('+')) return 'd-add';
    if (line.startsWith('-')) return 'd-del';
    return 'd-ctx';
  }

  function render(patch) {
    if (!patch || !patch.files) return;
    title.textContent = `patch ${patch.patch_id} · ${patch.files.length} 个文件`;
    body.textContent = '';
    for (const f of patch.files) {
      body.appendChild(document.createTextNode(`${f.op} ${f.path}  (+${f.added} -${f.removed})\n`));
      const diff = f.diff || '(无内容变化)';
      for (const line of diff.split('\n')) {
        const span = document.createElement('span');
        span.className = 'd-line ' + lineClass(line);
        span.textContent = line + '\n';
        body.appendChild(span);
      }
      body.appendChild(document.createTextNode('\n'));
    }
    panel.classList.remove('hidden');
    panel.scrollTop = 0;
  }

  function hide() { if (panel) panel.classList.add('hidden'); }

  return { init, render, hide };
})();

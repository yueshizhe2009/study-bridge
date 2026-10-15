'use strict';
// Page-level driving of the embedded web-AI panes: type a message into the site's composer and
// send it, then read the reply back out of the DOM.
//
// ⚠️ This is the capability chatview.js deliberately rules out ("these are plain browser views --
// they do NOT inject prompts or click anything"). It is opt-in, off by default, and only reachable
// through the local entry (see localEntry.js), which binds to 127.0.0.1 and requires a token.
//
// The scripts below run INSIDE the page via webContents.executeJavaScript, so they see the site's
// real DOM. Site markup changes without notice -- every adapter is best-effort and reports the
// exact selector it failed on, so a break is diagnosable rather than silent.

const POLL_MS = 500;

// ---------------------------------------------------------------------------
// ChatGPT (chatgpt.com)
// ---------------------------------------------------------------------------
const CHATGPT = {
  composer: '#prompt-textarea',
  sendButton: '[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send"]',
  assistant: '[data-message-author-role="assistant"]',
  streaming: '[data-testid="stop-button"]',
};

function chatgptCompose(text) {
  const t = JSON.stringify(text);
  return `(() => {
  const T = ${t};
  const el = document.querySelector(${JSON.stringify(CHATGPT.composer)})
          || document.querySelector('div[contenteditable="true"]');
  if (!el) return Promise.resolve({ ok:false, stage:'composer', error:'找不到输入框' });
  el.focus();
  // ProseMirror ignores a plain value assignment; execCommand('insertText') fires the events it
  // listens for. Fall back to a manual InputEvent only if the command is rejected.
  const sel = window.getSelection();
  sel && sel.removeAllRanges();
  el.innerHTML = '';
  const inserted = document.execCommand('insertText', false, T);
  if (!inserted) {
    el.textContent = T;
    el.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:T }));
  }
  return new Promise((res) => setTimeout(() => {
    const btn = document.querySelector(${JSON.stringify(CHATGPT.sendButton)});
    if (!btn) return res({ ok:false, stage:'send-button', error:'找不到发送按钮' });
    if (btn.disabled) return res({ ok:false, stage:'send-button', error:'发送按钮被禁用' });
    btn.click();
    res({ ok:true });
  }, 150));
})()`;
}

function chatgptRead() {
  return `(() => {
  const nodes = document.querySelectorAll(${JSON.stringify(CHATGPT.assistant)});
  const last = nodes[nodes.length - 1];
  const streaming = !!document.querySelector(${JSON.stringify(CHATGPT.streaming)});
  return { ok: true, count: nodes.length, streaming,
           text: last ? (last.innerText || '') : '' };
})()`;
}

// ---------------------------------------------------------------------------
// Arena (arena.ai/agent) -- NOT yet verified against the live DOM. Generic heuristics only.
// ---------------------------------------------------------------------------
const ARENA = {
  composer: 'textarea, div[contenteditable="true"]',
  sendButton: 'button[type="submit"], button[aria-label*="Send"]',
  assistant: '[data-role="assistant"], .assistant, [class*="assistant" i]',
  streaming: '[aria-label*="Stop"], button[class*="stop" i]',
};

function arenaCompose(text) {
  const t = JSON.stringify(text);
  return `(() => {
  const T = ${t};
  const el = document.querySelector(${JSON.stringify(ARENA.composer)});
  if (!el) return Promise.resolve({ ok:false, stage:'composer', error:'找不到输入框' });
  el.focus();
  if (el.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, T);
    el.dispatchEvent(new Event('input', { bubbles:true }));
  } else {
    el.innerHTML = '';
    if (!document.execCommand('insertText', false, T)) {
      el.textContent = T;
      el.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:T }));
    }
  }
  return new Promise((res) => setTimeout(() => {
    const btn = document.querySelector(${JSON.stringify(ARENA.sendButton)});
    if (!btn) return res({ ok:false, stage:'send-button', error:'找不到发送按钮' });
    btn.click();
    res({ ok:true });
  }, 150));
})()`;
}

function arenaRead() {
  return `(() => {
  const nodes = document.querySelectorAll(${JSON.stringify(ARENA.assistant)});
  const last = nodes[nodes.length - 1];
  return { ok: true, count: nodes.length,
           streaming: !!document.querySelector(${JSON.stringify(ARENA.streaming)}),
           text: last ? (last.innerText || '') : '' };
})()`;
}

const SITES = {
  chatgpt: { compose: chatgptCompose, read: chatgptRead, sel: CHATGPT },
  arena:   { compose: arenaCompose,   read: arenaRead,   sel: ARENA },
};

/**
 * A read-only diagnostic: report whether each selector currently matches, without typing or
 * clicking anything. This is how a broken adapter is told apart from a logged-out page.
 */
function probeScript(target) {
  const site = SITES[target];
  if (!site) throw new Error(`unknown target: ${target}`);
  const sel = site.sel;
  return `(() => {
  const one = (s) => { try { return document.querySelector(s); } catch { return null; } };
  const n = (s) => { try { return document.querySelectorAll(s).length; } catch { return 0; } };
  const composer = one(${JSON.stringify(sel.composer)});
  const btn = one(${JSON.stringify(sel.sendButton)});
  return {
    ok: true, url: location.href, title: document.title,
    userAgent: navigator.userAgent,
    webdriver: !!navigator.webdriver,
    composer: !!composer, composerTag: composer ? composer.tagName : null,
    sendButton: !!btn, sendDisabled: btn ? !!btn.disabled : null,
    assistantCount: n(${JSON.stringify(sel.assistant)}),
    bodyHead: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240),
  };
})()`;
}

/** Print the message into the pane's composer and press send. Returns the compose script's result. */
function composeScript(target, text) {
  const site = SITES[target];
  if (!site) throw new Error(`unknown target: ${target}`);
  return site.compose(text);
}

/** Report the last assistant message (plus whether the site is still streaming). */
function readScript(target) {
  const site = SITES[target];
  if (!site) throw new Error(`unknown target: ${target}`);
  return site.read();
}

/**
 * A single in-page script that composes, sends, and then polls until a NEW assistant message
 * appears and streaming stops. Doing the wait in-page keeps it to one round-trip instead of a
 * cross-process poll loop.
 */
function sayAndWaitScript(target, text, timeoutMs) {
  const site = SITES[target];
  if (!site) throw new Error(`unknown target: ${target}`);
  const t = JSON.stringify(text);
  const timeout = Math.max(1000, Number(timeoutMs) || 120000);
  // Reuse the site's own compose/read bodies by inlining their selectors.
  return `(async () => {
  const T = ${t};
  const DEADLINE = Date.now() + ${timeout};
  const SEL = { assistant: ${JSON.stringify(site.sel.assistant)}, streaming: ${JSON.stringify(site.sel.streaming)} };
  const countBefore = document.querySelectorAll(SEL.assistant).length;

  const compose = ${site.compose(text)};
  const sent = await compose;
  if (!sent || !sent.ok) return sent;

  let last = '';
  while (Date.now() < DEADLINE) {
    await new Promise((r) => setTimeout(r, ${POLL_MS}));
    const nodes = document.querySelectorAll(SEL.assistant);
    const streaming = !!document.querySelector(SEL.streaming);
    if (nodes.length > countBefore && !streaming) {
      const txt = nodes[nodes.length - 1].innerText || '';
      if (txt && txt === last) return { ok:true, text: txt, waited: true };
      last = txt;
    }
  }
  return { ok:false, stage:'wait', error:'等待回复超时', text:last };
})()`;
}

module.exports = { composeScript, readScript, sayAndWaitScript, probeScript, SITES };

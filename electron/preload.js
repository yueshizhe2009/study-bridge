'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Explicit allowlist -- the renderer gets exactly these channels and nothing else.
function on(channel, cb) {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('bridge', {
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),

  modeGet: () => ipcRenderer.invoke('mode:get'),
  modeSet: (mode) => ipcRenderer.invoke('mode:set', mode),

  hubStart: () => ipcRenderer.invoke('hub:start'),
  hubStop: () => ipcRenderer.invoke('hub:stop'),
  hubStatus: () => ipcRenderer.invoke('hub:status'),

  webcodexStatus: () => ipcRenderer.invoke('webcodex:status'),
  webcodexSet: (active) => ipcRenderer.invoke('webcodex:set', active),

  arenaStart: () => ipcRenderer.invoke('arena:start'),
  arenaStop: () => ipcRenderer.invoke('arena:stop'),
  arenaStatus: () => ipcRenderer.invoke('arena:status'),
  arenaCopyPrompt: () => ipcRenderer.invoke('arena:copy-prompt'),
  arenaOpenUrl: () => ipcRenderer.invoke('arena:open-url'),

  modelsGet: () => ipcRenderer.invoke('models:get'),
  modelsRefresh: () => ipcRenderer.invoke('models:refresh'),
  modelsCopy: (text) => ipcRenderer.invoke('models:copy', text),

  localEntryStatus: () => ipcRenderer.invoke('localEntry:status'),
  localEntryStart: () => ipcRenderer.invoke('localEntry:start'),
  localEntryStop: () => ipcRenderer.invoke('localEntry:stop'),

  eventsRecent: () => ipcRenderer.invoke('events:recent'),
  sessionSubscribe: (id) => ipcRenderer.invoke('session:subscribe', id),
  sessionUnsubscribe: (id) => ipcRenderer.invoke('session:unsubscribe', id),
  patchGet: (id) => ipcRenderer.invoke('patch:get', id),

  chatSetBounds: (rect) => ipcRenderer.invoke('chat:bounds', rect),
  chatReload: () => ipcRenderer.invoke('chat:reload'),
  chatExternal: () => ipcRenderer.invoke('chat:external'),
  chatFocus: () => ipcRenderer.invoke('chat:focus'),
  chatSources: () => ipcRenderer.invoke('chat:sources'),
  chatSelect: (name) => ipcRenderer.invoke('chat:select', name),

  openStateDir: () => ipcRenderer.invoke('state:open'),

  onStatus: (cb) => on('status:change', cb),
  onArena: (cb) => on('arena:change', cb),
  onEvents: (cb) => on('events:append', cb),
  onSessionOutput: (cb) => on('session:output', cb),
  onChatFail: (cb) => on('chat:fail', cb),
});

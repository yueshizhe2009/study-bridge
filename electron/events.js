'use strict';
// Main-process tailers that feed the renderer: the JSONL event log (tool calls, patches,
// progress, session lifecycle) and per-session terminal logs.
//
// fs.watch is unreliable on some filesystems, so every tailer ALSO polls. Offsets are tracked
// against file size; if the size ever goes backwards the file was rotated or truncated and we
// restart from the beginning of the new content.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const REPLAY_CAP = 512 * 1024;   // on first attach, replay at most this much history
const BATCH_MS = 50;

class FileTailer extends EventEmitter {
  constructor(file, { pollMs = 500 } = {}) {
    super();
    this.file = file;
    this.pollMs = pollMs;
    this.offset = 0;
    this._partial = '';
    this._timer = null;
    this._watcher = null;
    this._batch = [];
    this._batchTimer = null;
  }

  start() {
    if (this._timer) return;
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { size = 0; }
    this.offset = Math.max(0, size - REPLAY_CAP);
    this._drain();
    try {
      this._watcher = fs.watch(path.dirname(this.file), () => this._drain());
    } catch { /* directory may not exist yet; polling covers us */ }
    this._timer = setInterval(() => this._drain(), this.pollMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._watcher) { try { this._watcher.close(); } catch { /* ignore */ } }
    if (this._batchTimer) clearTimeout(this._batchTimer);
    this._timer = this._watcher = this._batchTimer = null;
  }

  _drain() {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.offset) { this.offset = 0; this._partial = ''; }  // rotated
    if (size === this.offset) return;
    let chunk;
    try {
      const fd = fs.openSync(this.file, 'r');
      const len = size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      fs.closeSync(fd);
      chunk = buf.toString('utf-8');
    } catch { return; }
    this.offset = size;
    const text = this._partial + chunk;
    const lines = text.split('\n');
    this._partial = lines.pop();            // keep the trailing partial line
    if (!lines.length) return;
    this._queue(lines);
  }

  _queue(lines) {
    this._batch.push(...lines);
    if (this._batchTimer) return;
    this._batchTimer = setTimeout(() => {
      this._batchTimer = null;
      const batch = this._batch;
      this._batch = [];
      this.emit('lines', batch);
    }, BATCH_MS);
  }
}

/** One tailer for the event log, plus lazily-created tailers for session terminals. */
class TailManager extends EventEmitter {
  constructor(eventsFile, sessionsDir) {
    super();
    this.eventsFile = eventsFile;
    this.sessionsDir = sessionsDir;
    this._events = new FileTailer(eventsFile);
    this._sessions = new Map();
  }

  startEvents() {
    this._events.on('lines', (lines) => {
      const parsed = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try { parsed.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
      if (parsed.length) this.emit('events', parsed);
    });
    this._events.start();
  }

  subscribeSession(id) {
    if (this._sessions.has(id)) return;
    const tailer = new FileTailer(path.join(this.sessionsDir, `${id}.log`));
    tailer.on('lines', (lines) => this.emit('session-output', { id, text: lines.join('\n') + '\n' }));
    tailer.start();
    this._sessions.set(id, tailer);
  }

  unsubscribeSession(id) {
    const t = this._sessions.get(id);
    if (t) { t.stop(); this._sessions.delete(id); }
  }

  stop() {
    this._events.stop();
    for (const t of this._sessions.values()) t.stop();
    this._sessions.clear();
  }
}

module.exports = { FileTailer, TailManager };

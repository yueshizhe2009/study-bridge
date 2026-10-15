#!/usr/bin/env python3
"""Structured event stream for the Electron activity panel.

The tunnel exposes no local view of tool calls, so the server writes one JSON object per line to
events.jsonl -- which the UI tails -- and mirrors each PTY session's output to sessions/<id>.log.

Guarantees:
  * One process-wide lock serializes all appends; lines are kept small so a write is a single
    atomic append (< PIPE_BUF) and the tailer never sees a half line from another thread.
  * Oversized string/array fields are shrunk BEFORE serialization, so a record is always valid
    JSON (never truncated mid-scalar).
  * events.jsonl and each session log rotate at a size cap, keeping one previous generation.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import config

_lock = threading.Lock()
_seq = 0

FIELD_LIMIT = 2000
MAX_LIST_ITEMS = 50
MAX_EVENTS_BYTES = 8 * 1024 * 1024
MAX_SESSION_BYTES = 4 * 1024 * 1024


def _shrink(value):
    if isinstance(value, str):
        return value if len(value) <= FIELD_LIMIT else value[:FIELD_LIMIT] + "…[truncated]"
    if isinstance(value, dict):
        return {str(k): _shrink(v) for k, v in list(value.items())[:MAX_LIST_ITEMS]}
    if isinstance(value, (list, tuple)):
        return [_shrink(v) for v in list(value)[:MAX_LIST_ITEMS]]
    return value


def _rotate(path: Path, limit: int) -> None:
    try:
        if path.exists() and path.stat().st_size > limit:
            path.replace(path.with_suffix(path.suffix + ".1"))
    except OSError:
        pass


def emit(event: str, **fields) -> dict:
    """Append one event record. Returns the record (useful for tests)."""
    global _seq
    with _lock:
        _seq += 1
        record = {"ts": time.time(), "seq": _seq, "event": event}
        record.update({k: _shrink(v) for k, v in fields.items()})
        try:
            config.STATE_DIR.mkdir(parents=True, exist_ok=True)
            _rotate(config.EVENTS_FILE, MAX_EVENTS_BYTES)
            with open(config.EVENTS_FILE, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        except OSError:
            pass  # the activity stream is best-effort; never break a tool call over it
    return record


def session_log_path(sid: str) -> Path:
    return config.SESSIONS_DIR / f"{sid}.log"


def append_session(sid: str, data: bytes) -> None:
    """Mirror a session's raw PTY output to its log so the terminal panel can tail it."""
    with _lock:
        try:
            config.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
            path = session_log_path(sid)
            _rotate(path, MAX_SESSION_BYTES)
            with open(path, "a", encoding="utf-8", errors="replace") as fh:
                fh.write(data.decode("utf-8", "replace"))
        except OSError:
            pass


def read_events(limit: int = 200) -> list[dict]:
    """Read the tail of the event log (used by tests; the UI tails the file directly)."""
    try:
        lines = config.EVENTS_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out

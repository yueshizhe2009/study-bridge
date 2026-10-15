#!/usr/bin/env python3
"""Ask / Plan / Code permission gate.

The mode is read from a human-controlled file (written by the Electron toggle). It is NEVER a
tool argument, so the model cannot elevate its own privileges. When the file is missing or
blank the HARD default is 'ask' (read-only), the safest posture.

An optional STUDY_BRIDGE_MODE_CAP env var clamps the result further, per process -- see _CAP.

Capability classes:
    read  -- never mutates anything
    meta  -- writes only to the activity stream (progress reports)
    write -- mutates workspace files (apply_patch)
    exec  -- runs processes / writes to their stdin
"""
from __future__ import annotations

import os

from config import MODE_FILE

MODES = ("ask", "plan", "code")

# Lowest-to-highest privilege. Used only to clamp, never to grant.
_RANK = {"ask": 0, "plan": 1, "code": 2}

# Optional per-process ceiling, read once at import. It exists so an alternate entry point
# (hub/http_mcp.py, which faces the public internet) can be held read-only while the primary
# stdio server still honours whatever the user set. An env var is not reachable from a tool
# call, so the ceiling cannot be lifted by the model itself -- only by whoever starts the process.
_CAP = os.environ.get("STUDY_BRIDGE_MODE_CAP", "").strip().lower()
if _CAP not in _RANK:
    _CAP = None

# Optional per-process capability denylist, read once at import. Same rationale as _CAP: 'code'
# bundles write and exec together, but an internet-facing entry point may want to hand out file
# edits without also handing out a shell. Denying is subtractive -- it can never grant anything.
_DENY = {c for c in os.environ.get("STUDY_BRIDGE_CAP_DENY", "").replace(" ", "").split(",") if c}

# Explicit capability sets -- clearer and safer than a numeric ordering, which silently
# mis-handled capabilities absent from the table.
ALLOWED = {
    "ask": {"read", "meta"},
    "plan": {"read", "meta"},
    "code": {"read", "meta", "write", "exec"},
}

CAP = {
    "list_directory": "read",
    "find_files": "read",
    "search_files": "read",
    "read_files": "read",
    "list_models": "read",
    "list_processes": "read",
    "report_progress": "meta",
    "apply_patch": "write",
    "process_start": "exec",
    "process_output": "exec",
    "process_status": "exec",
    "process_stop": "exec",
    "send_command_input": "exec",
}


def current() -> str:
    try:
        value = MODE_FILE.read_text(encoding="utf-8").strip().lower()
    except OSError:
        value = "ask"
    if value not in MODES:
        value = "ask"
    if _CAP is not None and _RANK[value] > _RANK[_CAP]:
        return _CAP
    return value


def allows(cap: str, mode: str | None = None) -> bool:
    if cap in _DENY:
        return False
    return cap in ALLOWED.get(mode or current(), ALLOWED["ask"])


def allowed(name: str) -> bool:
    """Whether a tool should be visible/callable in the current mode."""
    return allows(CAP.get(name, "exec"))


def require(cap: str) -> None:
    """Defence in depth: implementations call this so a routing bug still cannot write in ask/plan."""
    if not allows(cap):
        raise PermissionError(f"not available in {current()} mode")

#!/usr/bin/env python3
"""Runtime configuration for the study-bridge hub.

Resolves the workspace root and state paths, in order of precedence (first wins):

    1. CLI argument   (--workspace / --state-dir)
    2. environment    (STUDY_BRIDGE_WORKSPACE / STUDY_BRIDGE_STATE_DIR)
    3. settings file  (~/.config/study-bridge/settings.json  ->  keys "workspace" / "stateDir")
    4. built-in default (~/workspace)

The hub never hardcodes the workspace again: every path check goes through hub.safe_path,
which reads WORKSPACE from here.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("STUDY_BRIDGE_CONFIG_DIR", Path.home() / ".config" / "study-bridge"))
DEFAULT_WORKSPACE = Path.home() / "workspace"
DEFAULT_STATE_DIR = Path.home() / ".local" / "state" / "study-bridge"


def _from_cli(flag: str) -> str | None:
    argv = sys.argv[1:]
    for i, arg in enumerate(argv):
        if arg == flag and i + 1 < len(argv):
            return argv[i + 1]
        if arg.startswith(flag + "="):
            return arg.split("=", 1)[1]
    return None


def _from_settings(key: str) -> str | None:
    try:
        data = json.loads((CONFIG_DIR / "settings.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    value = data.get(key)
    return value if isinstance(value, str) and value else None


def _resolve(cli_flag: str, env_key: str, settings_key: str, default: Path) -> Path:
    for candidate in (_from_cli(cli_flag), os.environ.get(env_key), _from_settings(settings_key)):
        if candidate:
            return Path(candidate).expanduser().resolve()
    return Path(default).expanduser().resolve()


WORKSPACE: Path = _resolve("--workspace", "STUDY_BRIDGE_WORKSPACE", "workspace", DEFAULT_WORKSPACE)
STATE_DIR: Path = _resolve("--state-dir", "STUDY_BRIDGE_STATE_DIR", "stateDir", DEFAULT_STATE_DIR)

# Human-controlled permission mode (Ask / Plan / Code). Never settable by a tool call.
MODE_FILE: Path = CONFIG_DIR / "mode"
# Structured event log tailed by the Electron activity panel.
EVENTS_FILE: Path = STATE_DIR / "events.jsonl"
SESSIONS_DIR: Path = STATE_DIR / "sessions"


def validate() -> None:
    """Fail fast with a clear message if the configured workspace root is unusable.

    Called once at server startup. Guards against a typo'd or missing workspace, which would
    otherwise surface as a confusing per-call 'path does not exist' from deep inside safe_path.
    """
    if not WORKSPACE.exists():
        raise SystemExit(f"workspace root does not exist: {WORKSPACE}")
    if not WORKSPACE.is_dir():
        raise SystemExit(f"workspace root is not a directory: {WORKSPACE}")

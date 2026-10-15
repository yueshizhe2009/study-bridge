"""Shared hermetic workspace for the hub test suite.

Imported by every test module BEFORE it imports config/hub, so STUDY_BRIDGE_* env vars point at
a throwaway tree and the suite never touches the real Obsidian vault -- regardless of the order
unittest discovery happens to import modules in.
"""
from __future__ import annotations

import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

# A wrapper on PATH may hijack sys.executable (e.g. an AppImage); resolve a real interpreter.
PYTHON = os.environ.get("STUDY_BRIDGE_PYTHON") or shutil.which("python3") or sys.executable


def _setup() -> Path:
    root = Path(tempfile.mkdtemp(prefix="study-bridge-test-"))
    (root / "欢迎.md").write_text("# 欢迎\n\nhello world\n", encoding="utf-8")
    (root / "sub").mkdir()
    (root / "sub" / "note.md").write_text("alpha\nbeta\n", encoding="utf-8")
    os.environ.setdefault("STUDY_BRIDGE_WORKSPACE", str(root))
    os.environ.setdefault("STUDY_BRIDGE_STATE_DIR", str(root / ".state"))
    os.environ.setdefault("STUDY_BRIDGE_CONFIG_DIR", str(root / ".config"))
    atexit.register(shutil.rmtree, root, True)
    return root


WORKSPACE: Path = _setup()

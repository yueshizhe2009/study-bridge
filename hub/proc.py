#!/usr/bin/env python3
"""Session control beyond start/stop: feed stdin and enumerate live sessions.

`send_command_input` is what makes REPLs, install prompts and interactive CLIs usable over
MCP -- the model can answer a prompt instead of killing and restarting the command.
"""
from __future__ import annotations

import os

from hub import hub


def send_command_input(sid, data, newline=True):
    s = hub.get(sid)
    if s.returncode is not None:
        raise ValueError(f"process {sid} already exited (code {s.returncode})")
    payload = data.encode("utf-8") if isinstance(data, str) else bytes(data)
    if newline and not payload.endswith(b"\n"):
        payload += b"\n"
    try:
        written = os.write(s.master_fd, payload)
    except OSError as exc:
        raise ValueError(f"cannot write to process {sid}: {exc}") from exc
    return {"id": sid, "written": written, "newline": newline}


def list_processes():
    processes = hub.list()
    return {"count": len(processes), "processes": processes}

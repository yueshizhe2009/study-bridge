#!/usr/bin/env python3
"""Local stdio JSON-RPC probe for the study-bridge hub.

Spawns hub/server.py exactly the way tunnel-client does -- newline-delimited JSON-RPC over
stdin/stdout -- and exercises initialize -> tools/list -> tools/call. Exits non-zero on any
protocol or tool failure, so it is usable as a smoke test in CI or before shipping a change.

Usage:
  python3 scripts/mcp-probe.py                       # list tools, then read a file
  python3 scripts/mcp-probe.py --tool list_directory
  python3 scripts/mcp-probe.py --tool read_files --args '{"paths":["欢迎.md"]}'
  python3 scripts/mcp-probe.py --workspace /tmp/ws   # probe an explicit workspace root
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HUB_DIR = Path(__file__).resolve().parent.parent / "hub"
SERVER = HUB_DIR / "server.py"

# The invoking shell may hijack sys.executable (wrapper/AppImage); resolve a real interpreter.
PYTHON = os.environ.get("STUDY_BRIDGE_PYTHON") or shutil.which("python3") or sys.executable


def _rpc(proc, payload, expect_id):
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()
    while True:
        line = proc.stdout.readline()
        if not line:
            raise SystemExit(f"server closed stdout while awaiting id={expect_id}")
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        if msg.get("id") == expect_id:
            return msg


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workspace", help="workspace root to probe (defaults to settings/env)")
    ap.add_argument("--tool", default="read_files")
    ap.add_argument("--args", default='{"paths":["欢迎.md"]}')
    ap.add_argument("--python", default=PYTHON)
    args = ap.parse_args()

    env = dict(os.environ)
    if args.workspace:
        env["STUDY_BRIDGE_WORKSPACE"] = args.workspace

    proc = subprocess.Popen(
        [args.python, str(SERVER)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=env,
    )
    try:
        init = _rpc(proc, {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                           "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                      "clientInfo": {"name": "mcp-probe", "version": "0"}}}, 1)
        if "result" not in init:
            raise SystemExit(f"initialize failed: {init}")
        info = init["result"]["serverInfo"]
        print(f"initialize OK: {info['name']} {info['version']} protocol={init['result']['protocolVersion']}")

        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        proc.stdin.flush()

        listing = _rpc(proc, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, 2)
        names = [t["name"] for t in listing["result"]["tools"]]
        print(f"tools/list OK: {len(names)} tools -> {', '.join(names)}")

        call = _rpc(proc, {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                           "params": {"name": args.tool, "arguments": json.loads(args.args)}}, 3)
        result = call.get("result", {})
        text = "".join(c.get("text", "") for c in result.get("content", []))
        if result.get("isError"):
            print(f"tools/call {args.tool} -> isError: {text}", file=sys.stderr)
            return 1
        print(f"tools/call {args.tool} OK: {text[:400]}{'...' if len(text) > 400 else ''}")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        err = proc.stderr.read()
        if err:
            print("--- server stderr ---", file=sys.stderr)
            print(err.strip(), file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Report task progress back to the user's activity panel.

This is the one tool that flows *outward* to the human: the web AI calls it at phase
boundaries so the panel shows what stage the task is at, without polluting the tool result
stream. It mutates nothing on disk beyond the event log.
"""
from __future__ import annotations

import events


def report(args: dict) -> dict:
    percent = args.get("percent")
    if percent is not None:
        try:
            percent = max(0.0, min(100.0, float(percent)))
        except (TypeError, ValueError):
            percent = None
    record = events.emit("progress", task=args.get("task"), percent=percent,
                         message=args.get("message"))
    return {"ok": True, "seq": record["seq"], "task": args.get("task"), "percent": percent}

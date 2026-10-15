#!/usr/bin/env python3
"""arena.ai model catalog probe.

arena.ai's agent mode routes across many frontier models but exposes no OpenAI-compatible
endpoint, so the only public view of what is available is an unauthenticated catalog at
arena.ai/nextjs-api/model-catalog. Fetching it costs ~10s, so the result is cached under
STATE_DIR and refreshed lazily: readers (the models panel, and the list_models tool) never
block on the network, and a failed refresh falls back to the last good copy.

Nothing here touches the workspace -- the catalog is not workspace data -- so these paths
deliberately bypass hub.safe_path.
"""
from __future__ import annotations

import hashlib
import json
import sys
import threading
import time
import urllib.request

import config
import events

URL = "https://arena.ai/nextjs-api/model-catalog"
TTL = 12 * 3600
TIMEOUT = 20
CACHE_PATH = config.STATE_DIR / "model_catalog.json"
ARENAS = ("text", "code", "search", "text-to-image", "text-to-video", "document")

# The endpoint 403s a bare Python-urllib UA; it serves fine to a browser-shaped one.
_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

_lock = threading.Lock()


def _fetch() -> list:
    req = urllib.request.Request(URL, headers={"User-Agent": _UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _normalize(raw: list) -> tuple[dict, str]:
    """Keep the catalog's own array order as an implicit rank.

    It is the only ordering signal the endpoint gives us; inventing a score from capability
    flags would be worse than admitting we do not have one.
    """
    arenas: dict[str, list] = {}
    for group in raw or []:
        if not isinstance(group, dict):
            continue
        name, models = group.get("arena"), group.get("models")
        if not isinstance(name, str) or not isinstance(models, list):
            continue
        arenas[name] = [
            {
                "rank": i,
                "id": m.get("id"),
                "public_name": m.get("publicName"),
                "display_name": m.get("displayName"),
                "organization": m.get("organization"),
                "provider": m.get("provider"),
                "capabilities": m.get("capabilities") or {},
            }
            for i, m in enumerate(models)
            if isinstance(m, dict)
        ]
    digest = hashlib.sha256(json.dumps(arenas, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    return arenas, digest


def _read_cache() -> dict | None:
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("arenas"), dict) else None


def _write_cache(data: dict) -> None:
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = CACHE_PATH.with_name(CACHE_PATH.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        tmp.replace(CACHE_PATH)
    except OSError:
        pass  # the cache is best-effort; the next call simply refetches


def _text_names(data: dict | None) -> set:
    models = ((data or {}).get("arenas") or {}).get("text") or []
    return {m.get("public_name") or m.get("id") for m in models if isinstance(m, dict)}


def catalog(arena: str | None = None, top: int | None = None,
            refresh: bool = False, max_age: int = TTL) -> dict:
    """Return the cached catalog, refreshing it first if it is missing, stale, or forced."""
    with _lock:
        data = _read_cache()
        age = time.time() - data.get("fetched_at", 0) if data else None
        if refresh or data is None or age > max_age:
            try:
                arenas, digest = _normalize(_fetch())
                new = {"fetched_at": time.time(), "hash": digest, "source": URL, "arenas": arenas}
                _write_cache(new)
                if data is not None and digest != data.get("hash"):
                    before, after = _text_names(data), _text_names(new)
                    events.emit("model_catalog", changed=True, hash=digest,
                                added=sorted(after - before), removed=sorted(before - after))
                data = new
            except Exception as exc:
                # urllib raises a zoo of exception types (URLError, HTTPError, socket.timeout,
                # ValueError from a truncated body). The probe must never take the server down,
                # so catch broadly and degrade to whatever we already have.
                if data is None:
                    return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "arenas": {}}
                data = {**data, "stale": True, "error": f"{type(exc).__name__}: {exc}"}

        arenas = data["arenas"]
        if arena:
            arenas = {arena: arenas.get(arena, [])}
        if top:
            arenas = {k: v[:top] for k, v in arenas.items()}
        fetched_at = data.get("fetched_at", 0)
        return {
            "ok": True,
            "fetched_at": fetched_at,
            "age_seconds": int(time.time() - fetched_at),
            "hash": data.get("hash"),
            "stale": bool(data.get("stale")),
            "error": data.get("error"),
            "counts": {k: len(v) for k, v in arenas.items()},
            "arenas": arenas,
        }


if __name__ == "__main__":
    # One-shot entry point for the Electron main process: refresh in the background, print a
    # one-line summary, exit. Never used for reads -- the UI reads the cache file directly.
    result = catalog(refresh="--refresh" in sys.argv[1:])
    print(json.dumps({k: v for k, v in result.items() if k != "arenas"}, ensure_ascii=False))
    sys.exit(0 if result.get("ok") else 1)

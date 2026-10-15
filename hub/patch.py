#!/usr/bin/env python3
"""apply_patch: multi-file, atomic-precheck, version-checked edits.

Invariants (these are the point of the module):
  * Read-only preflight. Every path, existence rule, version check and text match is validated
    BEFORE anything is written. Any failure means ZERO bytes change on disk.
  * expected_versions. read_files returns a 16-char content hash per file; a caller that supplies
    it here gets a version_conflict instead of silently clobbering a concurrent edit (Obsidian and
    obsidian-git both rewrite these files).
  * Format preservation. UTF-8 BOM and CRLF/LF line endings survive a round trip.
  * Serialized writers. Per-file locks are acquired in sorted order, so two calls touching the
    same file cannot interleave and two calls can never deadlock on each other.
  * Journaled commit. Originals are snapshotted first; a failure mid-commit rolls every already
    applied change back.
  * Honest diffs. The returned unified diff is computed from the bytes actually written.
"""
from __future__ import annotations

import difflib
import json
import os
import tempfile
import threading
import uuid
from pathlib import Path

import config
import events
import files
import hub
import mode

OPS = ("add", "update", "move", "delete")

_locks_guard = threading.Lock()
_file_locks: dict[str, threading.Lock] = {}


def _lock_for(rel: str) -> threading.Lock:
    with _locks_guard:
        return _file_locks.setdefault(rel, threading.Lock())


def _normalize(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _decode(data: bytes) -> tuple[str, bool, str]:
    """Return (lf-normalized text, had_bom, dominant newline)."""
    bom = data.startswith(b"\xef\xbb\xbf")
    body = data[3:] if bom else data
    crlf = body.count(b"\r\n")
    lf = body.count(b"\n") - crlf
    newline = "\r\n" if crlf > lf else "\n"
    return _normalize(body.decode("utf-8", "replace")), bom, newline


def _encode(text: str, bom: bool, newline: str) -> bytes:
    out = text.replace("\n", newline) if newline == "\r\n" else text
    data = out.encode("utf-8")
    return (b"\xef\xbb\xbf" + data) if bom else data


def _diff(old: str, new: str, rel: str) -> tuple[str, int, int]:
    lines = list(difflib.unified_diff(old.splitlines(), new.splitlines(),
                                      fromfile=f"a/{rel}", tofile=f"b/{rel}", lineterm=""))
    added = sum(1 for ln in lines if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in lines if ln.startswith("-") and not ln.startswith("---"))
    return "\n".join(lines), added, removed


def _require_absent(rel: str) -> Path:
    path = hub.safe_path(rel, must_exist=False)
    if path.exists():
        raise ValueError(f"path already exists: {rel}")
    parent = path.parent
    if not parent.is_dir():
        raise ValueError(f"parent directory does not exist: {files.rel(parent)}")
    return path


def _require_file(rel: str) -> Path:
    path = hub.safe_path(rel)  # must_exist within workspace
    if not path.is_file():
        raise ValueError(f"not a file: {rel}")
    return path


def _new_text_for_update(rel: str, op: dict, original: str) -> str:
    has_content = "content" in op
    has_pair = "old_text" in op or "new_text" in op
    if has_content and has_pair:
        raise ValueError(f"update {rel}: give either 'content' or 'old_text'/'new_text', not both")
    if has_content:
        return _normalize(str(op["content"]))
    if "old_text" not in op or "new_text" not in op:
        raise ValueError(f"update {rel}: needs 'content' or both 'old_text' and 'new_text'")
    old = _normalize(str(op["old_text"]))
    count = original.count(old)
    if count != 1:
        raise ValueError(f"update {rel}: old_text matched {count} times, expected exactly 1")
    return original.replace(old, _normalize(str(op["new_text"])), 1)


def apply(payload: dict) -> dict:
    mode.require("write")
    operations = payload.get("operations") or []
    expected = payload.get("expected_versions") or {}
    if not isinstance(operations, list) or not operations:
        raise ValueError("operations must be a non-empty list")

    # ---- 1. classify ops and collect the set of paths each one claims --------------------
    writes: dict[str, str] = {}        # rel -> new lf-normalized text (add/update)
    adds: set[str] = set()
    updates: set[str] = set()
    deletes: set[str] = set()
    moves: list[tuple[str, str]] = []
    seen: dict[str, str] = {}          # rel -> first op that claimed it

    def claim(rel: str, kind: str) -> None:
        if rel in seen:
            raise ValueError(f"path {rel} is touched by both '{seen[rel]}' and '{kind}'")
        seen[rel] = kind

    for raw in operations:
        if not isinstance(raw, dict):
            raise ValueError("each operation must be an object")
        op = str(raw.get("op", "")).lower()
        if op not in OPS:
            raise ValueError(f"unknown op: {op!r}")

        if op == "add":
            rel = str(raw.get("path", ""))
            if "content" not in raw:
                raise ValueError(f"add {rel}: 'content' is required")
            claim(rel, op)
            adds.add(rel)
            writes[rel] = _normalize(str(raw["content"]))
        elif op == "update":
            rel = str(raw.get("path", ""))
            claim(rel, op)
            updates.add(rel)
            writes[rel] = ""  # filled in after originals are read
        elif op == "delete":
            rel = str(raw.get("path", ""))
            claim(rel, op)
            deletes.add(rel)
        elif op == "move":
            src, dst = str(raw.get("from", "")), str(raw.get("to", ""))
            if src == dst:
                raise ValueError(f"move {src}: 'from' and 'to' are identical")
            claim(src, "move:from")
            claim(dst, "move:to")
            moves.append((src, dst))

    involved = sorted(set(writes) | deletes | {s for s, _ in moves} | {d for _, d in moves})

    # ---- 2. hold every relevant lock (sorted order => no deadlock) ------------------------
    locks = [_lock_for(rel) for rel in involved]
    for lk in locks:
        lk.acquire()
    try:
        return _apply_locked(operations, expected, writes, adds, updates, deletes, moves)
    finally:
        for lk in reversed(locks):
            lk.release()


def _apply_locked(operations, expected, writes, adds, updates, deletes, moves) -> dict:
    # ---- 3. read-only preflight ----------------------------------------------------------
    originals: dict[str, bytes] = {}       # rel -> current bytes
    versions: dict[str, str] = {}

    for rel in sorted(adds):
        _require_absent(rel)

    for rel in sorted(set(updates) | deletes | {s for s, _ in moves}):
        path = _require_file(rel)
        data = path.read_bytes()
        originals[rel] = data
        versions[rel] = files.version_of(data)

    for _, dst in moves:
        _require_absent(dst)

    for rel, want in (expected or {}).items():
        if rel in versions and versions[rel] != want:
            raise ValueError(
                f"version_conflict: {rel} changed on disk (expected {want}, found {versions[rel]}); re-read and retry")

    # build the new text for updates (needs originals) -------------------------------------
    for raw in operations:
        if str(raw.get("op", "")).lower() == "update":
            rel = str(raw["path"])
            original_text, _, _ = _decode(originals[rel])
            writes[rel] = _new_text_for_update(rel, raw, original_text)

    # ---- 4. compute the exact bytes to commit --------------------------------------------
    new_bytes: dict[str, bytes] = {}
    for rel, text in writes.items():
        if rel in originals:
            _, bom, newline = _decode(originals[rel])
        else:
            bom, newline = False, "\n"          # add: no existing file to inherit from
        new_bytes[rel] = _encode(text, bom, newline)

    # ---- 5. commit with a journal --------------------------------------------------------
    patch_id = "p_" + uuid.uuid4().hex[:10]
    backup_dir = config.STATE_DIR / "rollback" / patch_id
    journal: list[dict] = []
    results: list[dict] = []

    def snapshot(rel: str, path: Path) -> Path:
        backup_dir.mkdir(parents=True, exist_ok=True)
        dest = backup_dir / (rel.replace("/", "__") or "root")
        dest.write_bytes(path.read_bytes())
        return dest

    try:
        for rel in sorted(new_bytes):
            target = hub.safe_path(rel, must_exist=False) if rel in adds else hub.safe_path(rel)
            backup = snapshot(rel, target) if target.exists() else None
            journal.append({"action": "write", "rel": rel, "backup": backup})
            fd, tmp = tempfile.mkstemp(dir=str(target.parent), prefix=".sb-", suffix=".tmp")
            with os.fdopen(fd, "wb") as fh:
                fh.write(new_bytes[rel])
            if target.exists():
                os.chmod(tmp, target.stat().st_mode)
            os.replace(tmp, target)

        for src, dst in moves:
            src_path = hub.safe_path(src)
            dst_path = hub.safe_path(dst, must_exist=False)
            backup = snapshot(src, src_path)
            journal.append({"action": "move", "src": src, "dst": dst, "backup": backup})
            os.replace(src_path, dst_path)

        for rel in sorted(deletes):
            path = hub.safe_path(rel)
            backup = snapshot(rel, path)
            journal.append({"action": "delete", "rel": rel, "backup": backup})
            os.remove(path)

    except Exception as exc:  # noqa: BLE001 -- we must roll back for ANY failure
        try:
            _rollback(journal)
        except Exception as rb:  # noqa: BLE001
            raise RuntimeError(f"commit failed ({exc!r}) AND rollback failed ({rb!r}); "
                               f"recovery copies under {backup_dir}") from exc
        raise

    # ---- 6. report, with diffs computed from real before/after ---------------------------
    version_after = {rel: files.version_of(data) for rel, data in new_bytes.items()}
    for raw in operations:
        op = str(raw["op"]).lower()
        if op == "add":
            rel = str(raw["path"])
            diff, added, removed = _diff("", writes[rel], rel)
            results.append({"op": "add", "path": rel, "version_before": None,
                            "version_after": version_after.get(rel), "added": added, "removed": removed, "diff": diff})
        elif op == "update":
            rel = str(raw["path"])
            old, _, _ = _decode(originals[rel])
            diff, added, removed = _diff(old, writes[rel], rel)
            results.append({"op": "update", "path": rel, "version_before": versions[rel],
                            "version_after": version_after.get(rel), "added": added, "removed": removed, "diff": diff})
        elif op == "delete":
            rel = str(raw["path"])
            old, _, _ = _decode(originals[rel])
            diff, added, removed = _diff(old, "", rel)
            results.append({"op": "delete", "path": rel, "version_before": versions[rel],
                            "version_after": None, "added": added, "removed": removed, "diff": diff})
        elif op == "move":
            src, dst = str(raw["from"]), str(raw["to"])
            old, _, _ = _decode(originals[src])
            diff, added, removed = _diff(old, old, f"{src} -> {dst}")
            results.append({"op": "move", "path": f"{src} -> {dst}", "from": src, "to": dst,
                            "version_before": versions[src], "version_after": version_after.get(dst),
                            "added": 0, "removed": 0, "diff": diff})

    # Full diffs live in their own file (the event log stays small); the UI fetches on demand.
    try:
        patches_dir = config.STATE_DIR / "patches"
        patches_dir.mkdir(parents=True, exist_ok=True)
        (patches_dir / f"{patch_id}.json").write_text(
            json.dumps({"patch_id": patch_id, "files": results}, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass

    events.emit("patch", patch_id=patch_id, ok=True,
                files=[{k: f.get(k) for k in ("op", "path", "added", "removed")} for f in results])
    return {"patch_id": patch_id, "ok": True, "files": results}


def _rollback(journal) -> None:
    """Undo applied changes in reverse order, restoring from the snapshot copies."""
    for entry in reversed(journal):
        action = entry["action"]
        if action == "write":
            target = hub.safe_path(entry["rel"], must_exist=False)
            backup = entry["backup"]
            if backup is None:
                if target.exists():
                    target.unlink()
            else:
                target.write_bytes(backup.read_bytes())
        elif action == "delete":
            hub.safe_path(entry["rel"], must_exist=False).write_bytes(entry["backup"].read_bytes())
        elif action == "move":
            dst = hub.safe_path(entry["dst"], must_exist=False)
            if dst.exists():
                dst.unlink()
            hub.safe_path(entry["src"], must_exist=False).write_bytes(entry["backup"].read_bytes())

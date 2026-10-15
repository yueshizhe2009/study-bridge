#!/usr/bin/env python3
"""Read-only workspace tools.

Every path is resolved through hub.safe_path, so nothing can escape the configured workspace
root -- symlinks included, because safe_path resolves before checking containment. Directory
walks re-check containment per entry for the same reason.
"""
from __future__ import annotations
import hashlib, re
from collections import deque
from pathlib import Path
from hub import WORKSPACE, safe_path

MAX_READ_BYTES=256*1024
MAX_LIST_ENTRIES=500
MAX_GLOB_RESULTS=200
MAX_SEARCH_RESULTS=200
MAX_SCAN_FILES=20000
MAX_SCAN_BYTES=4*1024*1024
SKIP_DIRS={".git","__pycache__",".venv","node_modules",".obsidian"}

def rel(p:Path)->str:
    try: return str(p.relative_to(WORKSPACE)) or "."
    except ValueError: return str(p)

def version_of(data:bytes)->str:
    """Content hash used as the concurrency token for write tools (see expected_versions)."""
    return hashlib.sha256(data).hexdigest()[:16]

def _contained(p:Path)->bool:
    try: p.relative_to(WORKSPACE); return True
    except ValueError: return False

def _walk(root:Path):
    """Yield files under root breadth-first, skipping noisy dirs and refusing anything that
    resolves outside the workspace (defends against symlinked directories in the vault).
    BFS keeps the order deterministic and hits shallow, usually-relevant files first; a LIFO
    stack would dive into the largest sibling subtree first and burn the scan budget there."""
    queue=deque([root])
    while queue:
        d=queue.popleft()
        try: children=sorted(d.iterdir(),key=lambda c:c.name)
        except (OSError,PermissionError): continue
        for c in children:
            try:
                if c.is_symlink() and not _contained(c.resolve()): continue
                if c.is_dir():
                    if c.name in SKIP_DIRS: continue
                    queue.append(c)
                elif c.is_file():
                    if _contained(c.resolve()): yield c
            except (OSError,PermissionError): continue

def list_directory(path="",depth=1):
    root=safe_path(path)
    if not root.is_dir(): raise ValueError("path is not a directory")
    depth=max(1,min(int(depth),3))
    entries=[]; truncated=False
    def walk(d:Path,level:int):
        nonlocal truncated
        if truncated: return
        try: children=sorted(d.iterdir(),key=lambda c:(c.is_dir(),c.name))
        except (OSError,PermissionError): return
        for c in children:
            if c.name in SKIP_DIRS: continue
            if c.is_symlink() and not _contained(c.resolve()): continue
            if len(entries)>=MAX_LIST_ENTRIES: truncated=True; return
            try: isdir=c.is_dir()
            except OSError: continue
            entries.append({"path":rel(c),"type":"dir" if isdir else "file",
                            "size":None if isdir else c.stat().st_size})
            if isdir and level<depth: walk(c,level+1)
    walk(root,1)
    return {"root":rel(root),"count":len(entries),"truncated":truncated,"entries":entries}

def find_files(pattern,path="",max_results=MAX_GLOB_RESULTS):
    root=safe_path(path)
    max_results=max(1,min(int(max_results),MAX_GLOB_RESULTS))
    base=root if root.is_dir() else root.parent
    matches=[]; truncated=False
    for f in _walk(base):
        if f.match(pattern):
            if len(matches)>=max_results: truncated=True; break
            matches.append({"path":rel(f),"size":f.stat().st_size})
    return {"pattern":pattern,"root":rel(base),"count":len(matches),"truncated":truncated,"matches":matches}

def search_files(pattern,path="",glob=None,max_results=MAX_SEARCH_RESULTS):
    """Regex search across text files. Pure Python: no subprocess, so no shell surface."""
    try: rx=re.compile(pattern)
    except re.error as exc: raise ValueError(f"invalid regex: {exc}") from exc
    root=safe_path(path); base=root if root.is_dir() else root.parent
    max_results=max(1,min(int(max_results),MAX_SEARCH_RESULTS))
    hits=[]; scanned=0; truncated=False; skipped_binary=0
    for f in _walk(base):
        if len(hits)>=max_results: truncated=True; break
        if glob and not f.match(glob): continue
        if scanned>=MAX_SCAN_FILES: truncated=True; break
        try:
            if f.stat().st_size>MAX_SCAN_BYTES: continue
            data=f.read_bytes()
        except (OSError,PermissionError): continue
        if b"\0" in data[:8192]: skipped_binary+=1; continue
        scanned+=1
        for i,line in enumerate(data.decode("utf-8","replace").splitlines(),1):
            if rx.search(line):
                hits.append({"path":rel(f),"line":i,"text":line[:400]})
                if len(hits)>=max_results: truncated=True; break
    return {"pattern":pattern,"root":rel(base),"scanned_files":scanned,
            "skipped_binary":skipped_binary,"count":len(hits),"truncated":truncated,"matches":hits}

def read_files(paths,max_bytes=MAX_READ_BYTES,max_lines=None):
    if isinstance(paths,str): paths=[paths]
    if not paths: raise ValueError("paths must not be empty")
    max_bytes=max(1,min(int(max_bytes),MAX_READ_BYTES))
    out=[]
    for p in paths:
        f=safe_path(p)
        if not f.is_file(): raise ValueError(f"not a file: {rel(f)}")
        try: data=f.read_bytes()
        except (OSError,PermissionError) as exc: raise ValueError(f"cannot read {rel(f)}: {exc}") from exc
        text=data.decode("utf-8","replace")
        lines=text.splitlines()
        if max_lines is not None:
            lines=lines[:max(1,int(max_lines))]
            text="\n".join(lines)
        clipped=len(text.encode())>max_bytes
        if clipped: text=text.encode()[:max_bytes].decode("utf-8","replace")
        out.append({"path":rel(f),"version":version_of(data),"bytes":len(data),
                    "lines":len(text.splitlines()),"truncated":clipped,"content":text})
    return {"count":len(out),"files":out}

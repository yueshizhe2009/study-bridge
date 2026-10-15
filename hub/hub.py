#!/usr/bin/env python3
from __future__ import annotations
import os, pty, select, signal, threading, time, uuid
from dataclasses import dataclass, field
from pathlib import Path
from config import WORKSPACE
import events
MAX_OUTPUT=256*1024
MAX_SESSIONS=64
def safe_path(value,*,must_exist=True):
    candidate=(WORKSPACE if not value else WORKSPACE/value).resolve()
    try: candidate.relative_to(WORKSPACE)
    except ValueError as exc: raise ValueError(f"path must stay inside the workspace ({WORKSPACE})") from exc
    if must_exist and not candidate.exists(): raise ValueError("path does not exist")
    return candidate
def safe_cwd(value):
    candidate=safe_path(value)
    if not candidate.is_dir(): raise ValueError("cwd does not exist or is not a directory")
    return candidate
@dataclass
class Session:
    id:str; pid:int; master_fd:int; cwd:str; command:list[str]
    started_at:float=field(default_factory=time.time)
    returncode:int|None=None
    _buffer:bytearray=field(default_factory=bytearray)
    _base:int=0
    _total:int=0
    _lock:threading.Lock=field(default_factory=threading.Lock)
    def append(self,data:bytes):
        with self._lock:
            self._buffer.extend(data); self._total+=len(data)
            if len(self._buffer)>MAX_OUTPUT:
                drop=len(self._buffer)-MAX_OUTPUT
                del self._buffer[:drop]; self._base+=drop
    def read(self,offset=0):
        """Return (text, next_offset, lost). Offsets are absolute stream positions, monotonic,
        so a client can resume from any offset it has already seen. `lost=True` means that
        offset has been evicted from the bounded buffer -- the caller must not treat the
        returned text as a continuation."""
        with self._lock:
            offset=max(0,int(offset)); lost=offset<self._base
            start=max(0,offset-self._base)
            text=bytes(self._buffer[start:]).decode("utf-8","replace")
            return text,self._total,lost
class ProcessHub:
    def __init__(self): self._sessions={}; self._lock=threading.Lock()
    def start(self,command,cwd=None):
        if not command: raise ValueError("command must not be empty")
        workdir=safe_cwd(cwd)
        pid,fd=pty.fork()
        if pid==0:
            os.chdir(workdir); os.execvp(command[0],command)
        sid=uuid.uuid4().hex[:12]; s=Session(sid,pid,fd,str(workdir),command)
        with self._lock: self._sessions[sid]=s
        self._evict()
        events.emit("session",action="start",id=sid,command=command,cwd=str(workdir))
        threading.Thread(target=self._reader,args=(s,),daemon=True,name=f"agent-hub-{sid}").start()
        return self.status(sid)
    def _evict(self):
        """Drop the oldest finished sessions so a long-lived hub does not grow without bound.
        Running sessions are never evicted."""
        with self._lock:
            excess=len(self._sessions)-MAX_SESSIONS
            if excess<=0: return
            done=sorted((s for s in self._sessions.values() if s.returncode is not None),key=lambda s:s.started_at)
            for s in done[:excess]: self._sessions.pop(s.id,None)
    def _reader(self,s):
        while True:
            try:
                ready,_,_=select.select([s.master_fd],[],[],.25)
                if ready:
                    data=os.read(s.master_fd,8192)
                    if data: s.append(data); events.append_session(s.id,data); continue
            except (OSError,ValueError): pass
            result=os.waitpid(s.pid,os.WNOHANG)
            if result[0]==s.pid:
                s.returncode=os.waitstatus_to_exitcode(result[1])
                try: os.close(s.master_fd)
                except OSError: pass
                events.emit("session",action="exit",id=s.id,returncode=s.returncode)
                return
    def get(self,sid):
        with self._lock: s=self._sessions.get(sid)
        if s is None: raise KeyError(f"unknown process session: {sid}")
        return s
    def status(self,sid):
        s=self.get(sid)
        return {"id":s.id,"pid":s.pid,"command":s.command,"cwd":s.cwd,"started_at":s.started_at,"running":s.returncode is None,"returncode":s.returncode}
    def list(self):
        """Snapshot of every known session, oldest first. Read-only; safe to call while others run."""
        with self._lock: sessions=sorted(self._sessions.values(),key=lambda s:s.started_at)
        return [{"id":s.id,"pid":s.pid,"command":s.command,"cwd":s.cwd,"started_at":s.started_at,"running":s.returncode is None,"returncode":s.returncode} for s in sessions]
    def output(self,sid,offset=0):
        s=self.get(sid); text,total,lost=s.read(offset)
        return {"id":sid,"offset":total,"output":text,"truncated":lost}
    def wait(self,sid,timeout=30):
        s=self.get(sid); deadline=time.monotonic()+max(0,float(timeout))
        while s.returncode is None and time.monotonic()<deadline: time.sleep(.05)
        return self.status(sid)
    def stop(self,sid):
        s=self.get(sid)
        if s.returncode is None:
            for sig in (signal.SIGTERM,signal.SIGKILL):
                self._signal(s,sig)
                deadline=time.monotonic()+2
                while s.returncode is None and time.monotonic()<deadline: time.sleep(.05)
                if s.returncode is not None: break
        return self.status(sid)
    @staticmethod
    def _signal(s,sig):
        """pty.fork() puts the child in its own session, so pgid==pid. Signalling the whole
        group is what actually stops grandchildren (watchers, sub-shells) instead of leaking them."""
        try: os.killpg(s.pid,sig)
        except (ProcessLookupError,PermissionError):
            try: os.kill(s.pid,sig)
            except ProcessLookupError: pass
hub=ProcessHub()

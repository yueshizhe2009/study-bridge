#!/usr/bin/env python3
"""stdio MCP server for the study workspace (study-bridge hub).

Transport: newline-delimited JSON-RPC on stdin/stdout (MCP stdio framing).

stdout carries protocol traffic ONLY. Every diagnostic goes to stderr, because a stray
print() on stdout corrupts the stream and the tunnel drops the connection.

Run:  python3 hub/server.py [--workspace DIR] [--state-dir DIR]
Bound by:  tunnel-client run --mcp.command "command=/usr/bin/python3 .../hub/server.py,channel=main"
"""
from __future__ import annotations
import json, sys, time
import config
import events
import mode
from hub import hub
import files
import models
import proc
import patch
import progress

SERVER_NAME="local-agent-hub"
SERVER_VERSION="0.3.0"
PROTOCOL_VERSION="2025-06-18"

def _log(msg): print(msg,file=sys.stderr,flush=True)

TOOLS=[]
IMPL={}
def tool(name,description,schema,fn):
    TOOLS.append({"name":name,"description":description,"inputSchema":schema})
    IMPL[name]=fn

def _exec(fn):
    """Defence in depth: even if dispatch were mis-wired, an exec implementation still cannot run
    outside Code mode."""
    def wrapped(args):
        mode.require("exec")
        return fn(args)
    return wrapped

# ---------------------------------------------------------------- read-only files

tool("list_directory",
     "List files and folders inside the study workspace. Use this first to orient before reading.",
     {"type":"object","properties":{
        "path":{"type":"string","description":"Workspace-relative path. Omit or '' for the workspace root."},
        "depth":{"type":"integer","minimum":1,"maximum":3,"description":"Recursion depth, default 1."}},
      "required":[]},
     lambda a: files.list_directory(a.get("path",""),a.get("depth",1)))

tool("find_files",
     "Find files by glob pattern (e.g. '*.md', '**/*.canvas'). Use for locating by name; use search_files for content.",
     {"type":"object","properties":{
        "pattern":{"type":"string","description":"Glob matched against the filename."},
        "path":{"type":"string","description":"Directory to search under. Default workspace root."},
        "max_results":{"type":"integer","minimum":1,"maximum":200}},
      "required":["pattern"]},
     lambda a: files.find_files(a["pattern"],a.get("path",""),a.get("max_results",200)))

tool("search_files",
     "Regex-search file contents. Use this to find where something is discussed before reading whole files.",
     {"type":"object","properties":{
        "pattern":{"type":"string","description":"Python regular expression."},
        "path":{"type":"string","description":"Directory to search under. Default workspace root."},
        "glob":{"type":"string","description":"Optional filename filter, e.g. '*.md'."},
        "max_results":{"type":"integer","minimum":1,"maximum":200}},
      "required":["pattern"]},
     lambda a: files.search_files(a["pattern"],a.get("path",""),a.get("glob"),a.get("max_results",200)))

tool("read_files",
     "Read one or more files, with a content version hash per file. Prefer reading several "
     "related files in ONE call rather than one call per file. The returned 'version' is the "
     "token a later write must supply as expected_versions.",
     {"type":"object","properties":{
        "paths":{"type":"array","items":{"type":"string"},"description":"Workspace-relative file paths."},
        "max_bytes":{"type":"integer","minimum":1,"maximum":262144,"description":"Per-file byte cap."},
        "max_lines":{"type":"integer","minimum":1,"description":"Optional per-file line cap."}},
      "required":["paths"]},
     lambda a: files.read_files(a["paths"],a.get("max_bytes",files.MAX_READ_BYTES),a.get("max_lines")))

# ---------------------------------------------------------------- arena model catalog

tool("list_models",
     "List the models arena.ai can route to, grouped by arena: text (that one IS agent mode), code, "
     "search, text-to-image, text-to-video, document. Each entry carries its catalog order (rank 0 "
     "= first in the list), org, provider, and capability flags. Use when the user asks which model "
     "to pick, or wants to know what is available behind agent mode. Served from a local cache; "
     "pass refresh=true only when the user explicitly wants the newest list, since that costs ~10s.",
     {"type":"object","properties":{
        "arena":{"type":"string","enum":["text","code","search","text-to-image","text-to-video","document"],
                 "description":"Restrict the result to one arena. Omit for all of them."},
        "top":{"type":"integer","minimum":1,"maximum":200,
               "description":"Return only the first N entries of each arena."},
        "refresh":{"type":"boolean","description":"Force a network refetch (~10s). Default false."},
        "max_age_seconds":{"type":"integer","minimum":0,
               "description":"Accept a cache younger than this. Default 12 hours."}},
      "required":[]},
     lambda a: models.catalog(a.get("arena"),a.get("top"),bool(a.get("refresh")),
                              a.get("max_age_seconds",models.TTL)))

# ---------------------------------------------------------------- task progress

tool("report_progress",
     "Report task progress to the user's activity panel: a stage label, an optional percent, and a "
     "short message. Call this at phase boundaries or when you need a decision -- NOT after every "
     "small action. It changes nothing on disk.",
     {"type":"object","properties":{
        "task":{"type":"string","description":"Current stage or task name."},
        "percent":{"type":"number","minimum":0,"maximum":100},
        "message":{"type":"string"}},
      "required":[]},
     lambda a: progress.report(a))

# ---------------------------------------------------------------- workspace writes

tool("apply_patch",
     "Apply a multi-file patch atomically: add / update / move / delete in ONE call. Every path is "
     "validated and version-checked BEFORE anything is written, so a failure changes nothing on disk. "
     "For update, give either full 'content', or 'old_text'+'new_text' (old_text must match exactly "
     "once). Supply expected_versions (the 'version' hashes from read_files) to get a version_conflict "
     "instead of silently clobbering a concurrent edit. Returns a unified diff of what actually changed.",
     {"type":"object","properties":{
        "operations":{"type":"array","description":"List of {op: 'add'|'update'|'move'|'delete', ...}.",
                      "items":{"type":"object","properties":{
                        "op":{"type":"string","enum":["add","update","move","delete"]},
                        "path":{"type":"string"},
                        "from":{"type":"string"},
                        "to":{"type":"string"},
                        "content":{"type":"string"},
                        "old_text":{"type":"string"},
                        "new_text":{"type":"string"}}}},
        "expected_versions":{"type":"object","description":"Optional map: workspace-relative path -> version hash from read_files."}},
      "required":["operations"]},
     lambda a: patch.apply(a))

# ---------------------------------------------------------------- persistent processes

tool("process_start",
     "Start a command in a persistent PTY. Returns immediately with an id; the process keeps "
     "running independently, so long builds/watchers do not block you. Read its output with "
     "process_output, do NOT poll in a tight loop.",
     {"type":"object","properties":{
        "command":{"type":"array","items":{"type":"string"},"description":"argv, e.g. ['python3','-c','print(1)']."},
        "cwd":{"type":"string","description":"Workspace-relative working directory."}},
      "required":["command"]},
     _exec(lambda a: hub.start(a["command"],a.get("cwd"))))

tool("process_output",
     "Read output produced since a byte offset. Pass the returned 'offset' back next time to get "
     "only what is new. If 'truncated' is true the requested offset had already been evicted from "
     "the bounded buffer -- the returned text is NOT a continuation, so re-read from offset 0.",
     {"type":"object","properties":{
        "id":{"type":"string"},
        "offset":{"type":"integer","minimum":0,"description":"Byte offset previously returned."}},
      "required":["id"]},
     _exec(lambda a: hub.output(a["id"],a.get("offset",0))))

tool("process_status",
     "Check whether a process is still running and its exit code.",
     {"type":"object","properties":{"id":{"type":"string"}},"required":["id"]},
     _exec(lambda a: hub.status(a["id"])))

tool("list_processes",
     "List every known PTY session (id, command, cwd, running/exit code). Use this to rediscover "
     "a session id, or to see which long-running jobs are still alive, instead of guessing.",
     {"type":"object","properties":{},"required":[]},
     lambda a: proc.list_processes())

tool("send_command_input",
     "Type text into a running process's stdin (a REPL, an install prompt, a running CLI). This is "
     "how you answer an interactive prompt instead of killing and restarting the command.",
     {"type":"object","properties":{
        "id":{"type":"string"},
        "data":{"type":"string","description":"Text to send."},
        "newline":{"type":"boolean","description":"Append a newline, default true."}},
      "required":["id","data"]},
     _exec(lambda a: proc.send_command_input(a["id"],a["data"],a.get("newline",True))))

tool("process_stop",
     "Stop a process and its whole process group (child shells, watchers). SIGTERM then SIGKILL.",
     {"type":"object","properties":{"id":{"type":"string"}},"required":["id"]},
     _exec(lambda a: hub.stop(a["id"])))

# ---------------------------------------------------------------- JSON-RPC

def _ok(rid,result): return {"jsonrpc":"2.0","id":rid,"result":result}
def _err(rid,code,message): return {"jsonrpc":"2.0","id":rid,"error":{"code":code,"message":message}}

def _tool_result(value):
    return {"content":[{"type":"text","text":json.dumps(value,ensure_ascii=False,indent=2)}]}

def _tool_error(message):
    # Tool-level failures come back as a normal result with isError, so the model can read the
    # message and correct itself instead of the whole call being a protocol error.
    return {"content":[{"type":"text","text":message}],"isError":True}

def handle(req):
    if not isinstance(req,dict): return None
    method=req.get("method"); rid=req.get("id")
    if method=="initialize":
        return _ok(rid,{"protocolVersion":PROTOCOL_VERSION,
                        "capabilities":{"tools":{"listChanged":False}},
                        "serverInfo":{"name":SERVER_NAME,"version":SERVER_VERSION}})
    if method=="notifications/initialized": return None
    if method=="ping": return _ok(rid,{})
    if method=="tools/list":
        return _ok(rid,{"tools":[t for t in TOOLS if mode.allowed(t["name"])]})
    if method=="tools/call":
        params=req.get("params") or {}
        name=params.get("name"); args=params.get("arguments") or {}
        if name not in IMPL:
            return _ok(rid,_tool_error(f"unknown tool: {name}"))
        if not mode.allowed(name):
            events.emit("tool_result",tool=name,ok=False,mode=mode.current(),
                        error=f"not available in {mode.current()} mode")
            return _ok(rid,_tool_error(f"tool '{name}' is not available in {mode.current()} mode"))
        events.emit("tool_call",tool=name,mode=mode.current(),
                    arg_keys=sorted(args.keys()) if isinstance(args,dict) else [])
        started=time.monotonic()
        try:
            value=IMPL[name](args)
            events.emit("tool_result",tool=name,ok=True,
                        duration_ms=round((time.monotonic()-started)*1000))
            return _ok(rid,_tool_result(value))
        except Exception as exc:
            events.emit("tool_result",tool=name,ok=False,
                        duration_ms=round((time.monotonic()-started)*1000),
                        error=f"{type(exc).__name__}: {exc}")
            _log(f"tool {name} failed: {exc!r}")
            return _ok(rid,_tool_error(f"{type(exc).__name__}: {exc}"))
    if rid is None: return None
    return _err(rid,-32601,f"method not found: {method}")

def main():
    config.validate()
    events.emit("server_start",version=SERVER_VERSION,workspace=str(config.WORKSPACE),
                mode=mode.current(),tools=[t["name"] for t in TOOLS if mode.allowed(t["name"])])
    _log(f"{SERVER_NAME} {SERVER_VERSION} ready on stdio; {len(TOOLS)} tools; workspace={config.WORKSPACE}")
    for line in sys.stdin:
        line=line.strip()
        if not line: continue
        try: req=json.loads(line)
        except json.JSONDecodeError as exc:
            _log(f"malformed json ignored: {exc}"); continue
        for one in (req if isinstance(req,list) else [req]):
            resp=handle(one)
            if resp is not None:
                sys.stdout.write(json.dumps(resp,ensure_ascii=False)+"\n")
                sys.stdout.flush()

if __name__=="__main__": main()

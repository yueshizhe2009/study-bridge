#!/usr/bin/env python3
"""HTTP MCP endpoint for the study workspace -- the internet-facing transport.

This is a SECOND transport onto the SAME tool implementation as hub/server.py. It imports
`server` and delegates every JSON-RPC request to `server.handle()`, so the tool set, the
Ask/Plan/Code gate (mode.py) and the activity log (events.py) are shared verbatim instead of
being reimplemented here. Anything added to server.py shows up on both transports.

Reachability: binds 127.0.0.1 only. The public surface is a reverse tunnel in front of it
(Tailscale Funnel), so this process never listens on a routable address itself.

Authentication: the credential is a secret path component -- POST /mcp/<TOKEN>. A wrong or
missing token is answered exactly like an unknown route (404), so the endpoint's existence is
not disclosed to a scanner. No token, no route.

Run:  python3 hub/http_mcp.py
Env:  HTTP_MCP_TOKEN  required, the secret path component (refuses to start without it)
      HTTP_MCP_BIND   optional, host:port, default 127.0.0.1:8766
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import server

MAX_BODY = 8 * 1024 * 1024
_TOKEN = ""
_SESSION = ""
API_PATH = "/mcp"


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _wants_sse(accept: str) -> bool:
    """Strict MCP clients accept only text/event-stream. Plain JSON is valid per the Streamable
    HTTP spec, but answering in the format the caller asked for costs nothing and avoids a
    client that refuses the other one."""
    return "text/event-stream" in accept and "application/json" not in accept


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "study-bridge-http-mcp"

    def log_message(self, fmt, *args):  # route the default access log into our own logger
        _log("%s - %s" % (self.address_string(), fmt % args))

    # ------------------------------------------------------------------ helpers

    def _token_ok(self) -> bool:
        """Timing-safe comparison of the path's last segment against the configured token."""
        path = urlsplit(self.path).path
        prefix = API_PATH + "/"
        if not path.startswith(prefix):
            return False
        supplied = path[len(prefix):]
        if not supplied or "/" in supplied:
            return False
        return hmac.compare_digest(supplied, _TOKEN)

    def _send(self, status: int, payload, *, sse: bool = False, close: bool = False) -> None:
        if payload is None:
            body = b""
            ctype = "application/json"
        elif sse:
            body = b"event: message\ndata: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n"
            ctype = "text/event-stream"
        else:
            body = json.dumps(payload, ensure_ascii=False).encode()
            ctype = "application/json"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        if _SESSION:
            self.send_header("Mcp-Session-Id", _SESSION)
        if close:
            self.send_header("Connection", "close")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _reject(self, status: int) -> None:
        """Refuse a request and tear the connection down.

        We do NOT read the request body on any rejection path. Under HTTP/1.1 keep-alive an
        unread body stays in the socket and is parsed as the start of the NEXT request line
        ("{}POST /mcp/..."), which the base handler answers with a 501 HTML page and which
        silently swallows the following request. Closing instead makes the leftover bytes
        irrelevant; it also avoids a blocking read on a body the peer may never send.
        """
        self.close_connection = True
        self._send(status, None, close=True)

    # ------------------------------------------------------------------ routes

    def do_GET(self):
        self._reject(405)

    def do_DELETE(self):
        self._reject(405)

    def do_PUT(self):
        self._reject(405)

    def do_POST(self):
        # Wrong path and wrong token are answered identically: a prober learns nothing.
        if not self._token_ok():
            self._reject(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self._reject(400)
            return
        if length <= 0 or length > MAX_BODY:
            self._reject(400)
            return
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as exc:
            self._send(400, {"jsonrpc": "2.0", "id": None,
                             "error": {"code": -32700, "message": f"parse error: {exc}"}})
            return

        batch = isinstance(req, list)
        responses = []
        for one in (req if batch else [req]):
            try:
                resp = server.handle(one)
            except Exception as exc:  # a tool implementation blowing up is not a 500-crash
                _log(f"handle() raised: {exc!r}")
                rid = one.get("id") if isinstance(one, dict) else None
                resp = {"jsonrpc": "2.0", "id": rid,
                        "error": {"code": -32603, "message": f"{type(exc).__name__}: {exc}"}}
            if resp is not None:
                responses.append(resp)

        if not responses:
            # All notifications: 202 with no body, per Streamable HTTP.
            self.send_response(202)
            self.send_header("Content-Length", "0")
            if _SESSION:
                self.send_header("Mcp-Session-Id", _SESSION)
            self.end_headers()
            return

        self._send(200, responses if batch else responses[0],
                   sse=_wants_sse(self.headers.get("Accept", "")))


def main() -> int:
    global _TOKEN, _SESSION
    _TOKEN = os.environ.get("HTTP_MCP_TOKEN", "").strip()
    if len(_TOKEN) < 16:
        _log("HTTP_MCP_TOKEN missing or shorter than 16 chars; refusing to start")
        return 2

    bind = os.environ.get("HTTP_MCP_BIND", "127.0.0.1:8766").strip()
    host, _, port_s = bind.rpartition(":")
    host = host or "127.0.0.1"
    try:
        port = int(port_s)
    except ValueError:
        _log(f"bad HTTP_MCP_BIND: {bind!r}")
        return 2

    _SESSION = secrets.token_hex(16)
    httpd = ThreadingHTTPServer((host, port), Handler)
    _log(f"http-mcp ready on {host}:{port}{API_PATH}/<token>; "
         f"mode={server.mode.current()}; workspace={server.config.WORKSPACE}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

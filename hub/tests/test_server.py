"""Protocol-level tests for the stdio server: tools/list contents and tools/call failure paths.

Spawns server.py exactly like tunnel-client does, so a regression in framing or dispatch is
caught here rather than through a broken tunnel.
"""
import json, os, subprocess, sys, unittest
from pathlib import Path

from _workspace import PYTHON

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import config
import events

SERVER = Path(__file__).resolve().parent.parent / "server.py"


class ServerDispatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config.MODE_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.MODE_FILE.write_text("code", encoding="utf-8")  # full surface for the class
        cls.proc = subprocess.Popen(
            [PYTHON, str(SERVER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, env=dict(os.environ),
        )
        cls._rpc({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, 1)
        cls.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        cls.proc.stdin.flush()

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        for pipe in (cls.proc.stdin, cls.proc.stdout):
            try:
                pipe.close()
            except OSError:
                pass
        config.MODE_FILE.write_text("ask", encoding="utf-8")

    @classmethod
    def _rpc(cls, payload, expect_id):
        cls.proc.stdin.write(json.dumps(payload) + "\n")
        cls.proc.stdin.flush()
        while True:
            line = cls.proc.stdout.readline()
            if not line:
                raise AssertionError(f"server closed stdout while awaiting id={expect_id}")
            line = line.strip()
            if not line:
                continue
            msg = json.loads(line)  # also asserts stdout stays pure JSON
            if msg.get("id") == expect_id:
                return msg

    def test_tool_list_has_expected_surface(self):
        listing = self._rpc({"jsonrpc": "2.0", "id": 10, "method": "tools/list"}, 10)
        names = [t["name"] for t in listing["result"]["tools"]]
        for expected in ["list_directory", "find_files", "search_files", "read_files",
                         "apply_patch", "process_start", "process_output", "process_status",
                         "process_stop", "list_processes", "send_command_input"]:
            self.assertIn(expected, names)
        self.assertNotIn("process_wait", names, "blocking wait was removed to keep the loop responsive")

    def test_unknown_tool_is_tool_error_not_protocol_error(self):
        resp = self._rpc({"jsonrpc": "2.0", "id": 11, "method": "tools/call",
                          "params": {"name": "no_such_tool", "arguments": {}}}, 11)
        self.assertIn("result", resp)
        self.assertTrue(resp["result"].get("isError"))

    def test_escape_path_is_tool_error(self):
        resp = self._rpc({"jsonrpc": "2.0", "id": 12, "method": "tools/call",
                          "params": {"name": "read_files", "arguments": {"paths": ["../../etc/passwd"]}}}, 12)
        self.assertTrue(resp["result"].get("isError"))

    def test_valid_read_succeeds(self):
        resp = self._rpc({"jsonrpc": "2.0", "id": 13, "method": "tools/call",
                          "params": {"name": "read_files", "arguments": {"paths": ["欢迎.md"]}}}, 13)
        self.assertFalse(resp["result"].get("isError"))
        payload = json.loads(resp["result"]["content"][0]["text"])
        self.assertEqual(payload["count"], 1)

    def test_unknown_method_is_protocol_error(self):
        resp = self._rpc({"jsonrpc": "2.0", "id": 14, "method": "no/such/method"}, 14)
        self.assertIn("error", resp)
        self.assertEqual(resp["error"]["code"], -32601)

    def test_tools_list_is_filtered_by_mode(self):
        config.MODE_FILE.write_text("ask", encoding="utf-8")
        try:
            listing = self._rpc({"jsonrpc": "2.0", "id": 20, "method": "tools/list"}, 20)
            names = [t["name"] for t in listing["result"]["tools"]]
            self.assertIn("read_files", names)
            self.assertNotIn("apply_patch", names)
            self.assertNotIn("process_start", names)
        finally:
            config.MODE_FILE.write_text("code", encoding="utf-8")

    def test_write_tool_rejected_in_ask_mode(self):
        config.MODE_FILE.write_text("ask", encoding="utf-8")
        try:
            resp = self._rpc({"jsonrpc": "2.0", "id": 21, "method": "tools/call",
                              "params": {"name": "apply_patch",
                                         "arguments": {"operations": [{"op": "add", "path": "x.md", "content": "y"}]}}}, 21)
            self.assertTrue(resp["result"].get("isError"))
            self.assertIn("ask mode", resp["result"]["content"][0]["text"])
        finally:
            config.MODE_FILE.write_text("code", encoding="utf-8")

    def test_tool_call_is_recorded_in_the_event_log(self):
        try:
            config.EVENTS_FILE.unlink()
        except OSError:
            pass
        self._rpc({"jsonrpc": "2.0", "id": 22, "method": "tools/call",
                   "params": {"name": "read_files", "arguments": {"paths": ["欢迎.md"]}}}, 22)
        records = events.read_events(limit=1000)
        self.assertTrue(any(r.get("event") == "tool_call" and r.get("tool") == "read_files" for r in records))
        self.assertTrue(any(r.get("event") == "tool_result" and r.get("ok") for r in records))

import sys, time, unittest
from pathlib import Path

from _workspace import PYTHON

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from hub import hub
import proc


class ProcToolTests(unittest.TestCase):
    def test_send_input_is_echoed_by_the_pty(self):
        s = hub.start(["/bin/cat"])
        try:
            proc.send_command_input(s["id"], "ping-123")
            deadline = time.monotonic() + 2
            text = ""
            while time.monotonic() < deadline:
                text += hub.output(s["id"])["output"]
                if "ping-123" in text:
                    break
                time.sleep(.05)
            self.assertIn("ping-123", text)
        finally:
            hub.stop(s["id"])

    def test_send_input_rejects_exited_process(self):
        s = hub.start([PYTHON, "-c", "pass"])
        hub.wait(s["id"], 5)
        with self.assertRaises(ValueError):
            proc.send_command_input(s["id"], "too late")

    def test_send_input_rejects_unknown_session(self):
        with self.assertRaises(KeyError):
            proc.send_command_input("nope-not-a-session", "x")

    def test_list_processes_includes_live_session(self):
        s = hub.start([PYTHON, "-c", "import time; time.sleep(5)"])
        try:
            result = proc.list_processes()
            ids = {p["id"] for p in result["processes"]}
            self.assertIn(s["id"], ids)
            self.assertEqual(result["count"], len(result["processes"]))
        finally:
            hub.stop(s["id"])

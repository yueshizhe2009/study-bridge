import sys, unittest
from pathlib import Path

from _workspace import WORKSPACE  # noqa: F401

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import config
import mode


class ModeTests(unittest.TestCase):
    def setUp(self):
        config.MODE_FILE.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        config.MODE_FILE.write_text("ask", encoding="utf-8")

    def test_missing_file_defaults_to_ask_read_only(self):
        try:
            config.MODE_FILE.unlink()
        except OSError:
            pass
        self.assertEqual(mode.current(), "ask")
        self.assertTrue(mode.allowed("read_files"))
        self.assertFalse(mode.allowed("apply_patch"))
        self.assertFalse(mode.allowed("process_start"))

    def test_code_allows_write_and_exec(self):
        config.MODE_FILE.write_text("code", encoding="utf-8")
        for name in ("read_files", "apply_patch", "process_start", "send_command_input", "report_progress"):
            self.assertTrue(mode.allowed(name), name)

    def test_plan_is_read_only(self):
        config.MODE_FILE.write_text("plan", encoding="utf-8")
        self.assertTrue(mode.allowed("read_files"))
        self.assertFalse(mode.allowed("apply_patch"))
        self.assertFalse(mode.allowed("process_stop"))

    def test_require_raises_in_ask(self):
        config.MODE_FILE.write_text("ask", encoding="utf-8")
        with self.assertRaises(PermissionError):
            mode.require("write")
        mode.require("read")  # must not raise

    def test_unknown_value_falls_back_to_ask(self):
        config.MODE_FILE.write_text("root\n", encoding="utf-8")
        self.assertEqual(mode.current(), "ask")

import json, sys, unittest
from pathlib import Path

from _workspace import WORKSPACE

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import config
import files
import patch


class PatchTests(unittest.TestCase):
    def setUp(self):
        config.MODE_FILE.parent.mkdir(parents=True, exist_ok=True)
        config.MODE_FILE.write_text("code", encoding="utf-8")

    def tearDown(self):
        config.MODE_FILE.write_text("ask", encoding="utf-8")

    def _bytes(self, rel):
        return (WORKSPACE / rel).read_bytes()

    def test_add_update_move_delete_round_trip(self):
        (WORKSPACE / "学习").mkdir(exist_ok=True)
        r = patch.apply({"operations": [{"op": "add", "path": "学习/demo.md", "content": "line1\nline2\n"}]})
        self.assertEqual(r["files"][0]["op"], "add")
        self.assertEqual(r["files"][0]["added"], 2)
        self.assertTrue(self._bytes("学习/demo.md").startswith(b"line1"))

        r = patch.apply({"operations": [{"op": "update", "path": "学习/demo.md",
                                         "old_text": "line2", "new_text": "line2 changed"}]})
        self.assertEqual(r["files"][0]["op"], "update")
        self.assertIn(b"line2 changed", self._bytes("学习/demo.md"))

        r = patch.apply({"operations": [{"op": "move", "from": "学习/demo.md", "to": "学习/moved.md"}]})
        self.assertEqual(r["files"][0]["op"], "move")
        self.assertFalse((WORKSPACE / "学习/demo.md").exists())
        self.assertTrue((WORKSPACE / "学习/moved.md").exists())

        patch.apply({"operations": [{"op": "delete", "path": "学习/moved.md"}]})
        self.assertFalse((WORKSPACE / "学习/moved.md").exists())

    def test_version_conflict_aborts_with_zero_writes(self):
        (WORKSPACE / "conflict.md").write_text("v1\n", encoding="utf-8")
        stale = files.version_of(self._bytes("conflict.md"))
        (WORKSPACE / "conflict.md").write_text("v2 external\n", encoding="utf-8")  # concurrent edit
        with self.assertRaises(ValueError) as ctx:
            patch.apply({"operations": [{"op": "update", "path": "conflict.md", "content": "mine\n"}],
                         "expected_versions": {"conflict.md": stale}})
        self.assertIn("version_conflict", str(ctx.exception))
        self.assertEqual(self._bytes("conflict.md"), b"v2 external\n")

    def test_preflight_failure_leaves_earlier_ops_unwritten(self):
        (WORKSPACE / "zero.md").write_text("orig\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            patch.apply({"operations": [
                {"op": "update", "path": "zero.md", "content": "changed\n"},
                {"op": "update", "path": "does-not-exist.md", "content": "x"},
            ]})
        self.assertEqual(self._bytes("zero.md"), b"orig\n")

    def test_bom_and_crlf_are_preserved(self):
        (WORKSPACE / "win.md").write_bytes(b"\xef\xbb\xbfalpha\r\nbeta\r\n")
        patch.apply({"operations": [{"op": "update", "path": "win.md",
                                     "old_text": "beta", "new_text": "beta2"}]})
        data = self._bytes("win.md")
        self.assertTrue(data.startswith(b"\xef\xbb\xbf"), "BOM must survive")
        self.assertIn(b"alpha\r\n", data, "CRLF must survive")
        self.assertIn(b"beta2\r\n", data)

    def test_old_text_must_match_exactly_once(self):
        (WORKSPACE / "dup.md").write_text("x\nx\n", encoding="utf-8")
        with self.assertRaises(ValueError) as ctx:
            patch.apply({"operations": [{"op": "update", "path": "dup.md", "old_text": "x", "new_text": "y"}]})
        self.assertIn("matched 2 times", str(ctx.exception))

    def test_escape_and_duplicate_targets_rejected(self):
        with self.assertRaises(ValueError):
            patch.apply({"operations": [{"op": "add", "path": "../escape.md", "content": "x"}]})
        with self.assertRaises(ValueError):
            patch.apply({"operations": [
                {"op": "add", "path": "dup-target.md", "content": "a"},
                {"op": "update", "path": "dup-target.md", "content": "b"},
            ]})

    def test_add_refuses_existing_file(self):
        (WORKSPACE / "exists.md").write_text("here\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            patch.apply({"operations": [{"op": "add", "path": "exists.md", "content": "new"}]})

    def test_full_diffs_are_persisted_for_the_ui(self):
        (WORKSPACE / "learned.md").write_text("a\nb\n", encoding="utf-8")
        r = patch.apply({"operations": [{"op": "update", "path": "learned.md",
                                         "old_text": "b", "new_text": "b2"}]})
        stored = config.STATE_DIR / "patches" / f"{r['patch_id']}.json"
        self.assertTrue(stored.exists())
        payload = json.loads(stored.read_text(encoding="utf-8"))
        self.assertIn("@@", payload["files"][0]["diff"])

    def test_write_gate_blocks_in_ask_mode(self):
        config.MODE_FILE.write_text("ask", encoding="utf-8")
        with self.assertRaises(PermissionError):
            patch.apply({"operations": [{"op": "add", "path": "nope.md", "content": "x"}]})
        self.assertFalse((WORKSPACE / "nope.md").exists())

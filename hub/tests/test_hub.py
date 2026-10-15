import os, sys, time, unittest
from pathlib import Path

from _workspace import PYTHON  # sets STUDY_BRIDGE_* before config/hub import

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import files
import hub as hubmod
from hub import MAX_OUTPUT, ProcessHub


def group_alive(pgid):
    try: os.killpg(pgid, 0); return True
    except ProcessLookupError: return False
    except PermissionError: return True


class HubTests(unittest.TestCase):
    def test_lifecycle_and_incremental_output(self):
        h = ProcessHub(); s = h.start([PYTHON, "-c", "import time; print('hello',flush=True); time.sleep(.15); print('world',flush=True)"])
        self.assertTrue(s["running"])
        deadline = time.monotonic() + 1
        first = h.output(s["id"])
        while "hello" not in first["output"] and time.monotonic() < deadline:
            time.sleep(.02); first = h.output(s["id"])
        self.assertIn("hello", first["output"])
        final = h.wait(s["id"], 2); self.assertFalse(final["running"]); self.assertEqual(final["returncode"], 0)
        self.assertIn("world", h.output(s["id"], first["offset"])["output"])

    def test_stop(self):
        h = ProcessHub(); s = h.start([PYTHON, "-c", "import time; time.sleep(30)"]); final = h.stop(s["id"])
        self.assertFalse(final["running"]); self.assertIsNotNone(final["returncode"])

    def test_workspace_escape_rejected(self):
        h = ProcessHub()
        with self.assertRaises(ValueError): h.start(["pwd"], "../../")

    def test_stop_kills_whole_process_group(self):
        """A shell that backgrounds a grandchild must not survive stop()."""
        h = ProcessHub()
        s = h.start(["/bin/sh", "-c", "sleep 300 & wait"])
        time.sleep(.4)
        self.assertTrue(group_alive(s["pid"]), "grandchild should be running before stop")
        h.stop(s["id"]); time.sleep(.4)
        self.assertFalse(group_alive(s["pid"]), "process group should be gone after stop")

    def test_offset_is_monotonic_and_reports_loss(self):
        """The bounded buffer drops old bytes. Offsets must stay absolute, and reading an
        evicted offset must be flagged rather than silently returning wrong-position data."""
        h = ProcessHub()
        total = MAX_OUTPUT + 50_000
        s = h.start([PYTHON, "-c", f"print('x'*{total})"])
        h.wait(s["id"], 10)
        r0 = h.output(s["id"], 0)
        self.assertTrue(r0["truncated"], "offset 0 is evicted once output exceeds the buffer")
        self.assertEqual(r0["offset"], total + 2, "PTY line discipline emits CRLF for the final newline")
        r_end = h.output(s["id"], r0["offset"])
        self.assertFalse(r_end["truncated"])
        self.assertEqual(r_end["output"], "", "resuming from the returned offset yields no replay")

    def test_finished_sessions_are_evicted(self):
        original = hubmod.MAX_SESSIONS
        hubmod.MAX_SESSIONS = 3
        try:
            h = ProcessHub()
            for _ in range(5):
                s = h.start([PYTHON, "-c", "pass"]); h.wait(s["id"], 5)
            self.assertLessEqual(len(h._sessions), 3, "finished sessions must not accumulate")
        finally:
            hubmod.MAX_SESSIONS = original


class FileToolTests(unittest.TestCase):
    def test_list_directory_and_read_version(self):
        d = files.list_directory("", 1)
        self.assertGreater(d["count"], 0)
        r = files.read_files(["欢迎.md"], max_lines=2)
        self.assertEqual(r["count"], 1)
        self.assertEqual(len(r["files"][0]["version"]), 16, "version is the write-concurrency token")

    def test_version_changes_with_content(self):
        a = files.version_of(b"one"); b = files.version_of(b"two")
        self.assertNotEqual(a, b); self.assertEqual(a, files.version_of(b"one"))

    def test_read_and_list_reject_escape(self):
        for bad in ["../../etc/passwd", "/etc/passwd", "../memory/INDEX.md"]:
            with self.assertRaises(ValueError): files.read_files([bad])
        with self.assertRaises(ValueError): files.read_files(["/etc"])

    def test_missing_path_rejected(self):
        with self.assertRaises(ValueError): files.read_files(["definitely-not-here.md"])  # must_exist

    def test_search_reports_invalid_regex(self):
        with self.assertRaises(ValueError): files.search_files("[")

    def test_find_files_globs_and_escape(self):
        r = files.find_files("*.md")
        names = {m["path"] for m in r["matches"]}
        self.assertIn("欢迎.md", names)
        self.assertIn("sub/note.md", names)  # _walk recurses
        with self.assertRaises(ValueError): files.find_files("*", path="../../")

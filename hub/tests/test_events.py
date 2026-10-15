import json, sys, unittest
from pathlib import Path

from _workspace import WORKSPACE  # noqa: F401  (sets STUDY_BRIDGE_* env)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import config
import events


def _rotated(path: Path) -> Path:
    return Path(str(path) + ".1")


class EventTests(unittest.TestCase):
    def setUp(self):
        for p in (config.EVENTS_FILE, _rotated(config.EVENTS_FILE),
                  events.session_log_path("evt-test")):
            try:
                p.unlink()
            except OSError:
                pass

    def test_emit_writes_valid_json_with_monotonic_seq(self):
        a = events.emit("unit", note="one")
        b = events.emit("unit", note="two")
        self.assertLess(a["seq"], b["seq"])
        records = events.read_events()
        self.assertTrue(all(isinstance(r, dict) for r in records))
        self.assertEqual(records[-1]["note"], "two")

    def test_oversized_field_is_shrunk_but_line_stays_valid_json(self):
        events.emit("unit", blob="x" * 100_000)
        raw = config.EVENTS_FILE.read_text(encoding="utf-8").strip().splitlines()[-1]
        record = json.loads(raw)  # must not raise: never truncate mid-scalar
        self.assertLess(len(record["blob"]), 3_000)
        self.assertTrue(record["blob"].endswith("[truncated]"))

    def test_rotation_keeps_one_previous_generation(self):
        original = events.MAX_EVENTS_BYTES
        events.MAX_EVENTS_BYTES = 300
        try:
            for _ in range(10):
                events.emit("unit", pad="y" * 100)
        finally:
            events.MAX_EVENTS_BYTES = original
        self.assertTrue(_rotated(config.EVENTS_FILE).exists())

    def test_append_session_writes_a_tailable_log(self):
        events.append_session("evt-test", b"hello\nworld\n")
        self.assertEqual(events.session_log_path("evt-test").read_text(encoding="utf-8"),
                         "hello\nworld\n")

"""Model catalog probe: normalisation, and the caching/degradation contract.

No network here -- _fetch is replaced in every test, so these run offline and never touch the
real cache or event log.
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import models

SAMPLE = [
    {"arena": "text", "models": [
        {"id": "a1", "publicName": "alpha", "organization": "org1", "provider": "p1",
         "capabilities": {"inputCapabilities": {"text": True, "image": True}}},
        {"id": "a2", "publicName": "beta", "organization": "org2", "provider": "p2",
         "capabilities": {"inputCapabilities": {"text": True}}},
    ]},
    {"arena": "code", "models": [{"id": "c1", "publicName": "gamma"}]},
]


def _boom():
    raise OSError("boom")


class ModelCatalogTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_path, self._orig_fetch = models.CACHE_PATH, models._fetch
        models.CACHE_PATH = Path(self._tmp.name) / "model_catalog.json"

    def tearDown(self):
        models.CACHE_PATH, models._fetch = self._orig_path, self._orig_fetch
        self._tmp.cleanup()

    def test_normalize_uses_array_order_as_rank(self):
        arenas, digest = models._normalize(SAMPLE)
        self.assertEqual([m["public_name"] for m in arenas["text"]], ["alpha", "beta"])
        self.assertEqual([m["rank"] for m in arenas["text"]], [0, 1])
        self.assertEqual(arenas["code"][0]["public_name"], "gamma")
        self.assertEqual(len(digest), 16)

    def test_malformed_groups_are_skipped_not_fatal(self):
        arenas, _ = models._normalize([{"arena": "x"}, {"models": []}, "junk", None, 7])
        self.assertEqual(arenas, {})
        self.assertEqual(models._normalize(None)[0], {})

    def test_failure_without_cache_reports_instead_of_raising(self):
        models._fetch = _boom
        result = models.catalog()
        self.assertFalse(result["ok"])
        self.assertIn("boom", result["error"])

    def test_failure_with_cache_degrades_to_stale(self):
        models._fetch = lambda: SAMPLE
        models.catalog(refresh=True)
        models._fetch = _boom
        result = models.catalog(refresh=True)
        self.assertTrue(result["ok"])
        self.assertTrue(result["stale"])
        self.assertEqual(result["counts"]["text"], 2)

    def test_cache_is_reused_without_refetching(self):
        calls = []

        def counting_fetch():
            calls.append(1)
            return SAMPLE

        models._fetch = counting_fetch
        models.catalog(refresh=True)
        models.catalog()  # fresh cache, must not hit the network
        self.assertEqual(len(calls), 1)

    def test_arena_and_top_filters(self):
        models._fetch = lambda: SAMPLE
        result = models.catalog(arena="text", top=1, refresh=True)
        self.assertEqual(list(result["arenas"]), ["text"])
        self.assertEqual(len(result["arenas"]["text"]), 1)


class ModelToolGatingTests(unittest.TestCase):
    def test_list_models_is_read_only(self):
        # A tool missing from CAP defaults to 'exec' and would vanish in ask/plan mode.
        import mode
        self.assertEqual(mode.CAP.get("list_models"), "read")
        self.assertTrue(mode.allows("read", "ask"))


if __name__ == "__main__":
    unittest.main()

"""PlaceholderFileStore round-trip + the build_store() env factory.

The placeholder must satisfy the same FileStore contract as SQLite so the GUI
behaves identically on the builder; the factory must default to it and flip to
SQLite when asked.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

from app.db import SqliteFileStore
from app.store import FileNotFound, PlaceholderFileStore, build_store


class TestPlaceholderStore(unittest.TestCase):
    def setUp(self) -> None:
        self.store = PlaceholderFileStore()

    def test_panel_head_marks_it_a_placeholder(self) -> None:
        snap = self.store.list()
        self.assertIn("placeholder", snap.root.lower())
        self.assertTrue(snap.bind.startswith("wg0"))

    def test_add_get_delete_roundtrip(self) -> None:
        rec = self.store.add("a.txt", b"island", node="polaris", content_type="text/plain")
        name, ctype, content = self.store.get(rec.id)
        self.assertEqual((name, ctype, content), ("a.txt", "text/plain", b"island"))
        self.store.delete(rec.id)
        with self.assertRaises(FileNotFound):
            self.store.get(rec.id)

    def test_list_newest_first_and_unique_ids(self) -> None:
        a = self.store.add("a", b"a", node="polaris")
        b = self.store.add("b", b"b", node="vega")
        self.assertNotEqual(a.id, b.id)
        rows = self.store.list().files
        mods = [f.modified for f in rows]
        self.assertEqual(mods, sorted(mods, reverse=True))

    def test_seed_idempotent(self) -> None:
        self.store.seed_if_empty()
        n = len(self.store.list().files)
        self.assertGreater(n, 0)
        self.store.seed_if_empty()
        self.assertEqual(len(self.store.list().files), n)


class TestBuildStore(unittest.TestCase):
    def test_defaults_to_placeholder(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsInstance(build_store(), PlaceholderFileStore)

    def test_sqlite_when_selected(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            env = {"GUI_FILES": "sqlite", "GUI_DB_PATH": os.path.join(d, "island.db")}
            with mock.patch.dict(os.environ, env, clear=True):
                store = build_store()
            self.assertIsInstance(store, SqliteFileStore)
            self.assertIn("polaris", store.list().root)  # real-store label


if __name__ == "__main__":
    unittest.main()

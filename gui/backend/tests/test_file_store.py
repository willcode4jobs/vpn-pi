"""SqliteFileStore round-trip — add / list / get / delete on a temp DB.

Uses a throwaway DB file per test so nothing touches the real island store.
"""

from __future__ import annotations

import os
import tempfile
import unittest

from app.db import SqliteFileStore
from app.store import FileNotFound


class TestFileStore(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.store = SqliteFileStore(os.path.join(self._dir.name, "test.db"))

    def tearDown(self) -> None:
        self._dir.cleanup()

    def test_starts_empty(self) -> None:
        self.assertTrue(self.store.is_empty())
        snap = self.store.list()
        self.assertEqual(snap.files, [])
        self.assertTrue(snap.bind.startswith("wg0"))  # island-bound, never public

    def test_add_then_get_roundtrips_content(self) -> None:
        rec = self.store.add("notes.txt", b"hello island", node="polaris",
                             content_type="text/plain")
        self.assertEqual(rec.size, len(b"hello island"))
        name, ctype, content = self.store.get(rec.id)
        self.assertEqual(name, "notes.txt")
        self.assertEqual(ctype, "text/plain")
        self.assertEqual(content, b"hello island")

    def test_list_is_newest_first(self) -> None:
        self.store.add("a", b"a", node="polaris")
        self.store.add("b", b"b", node="vega")
        rows = self.store.list().files
        self.assertEqual(len(rows), 2)
        mods = [f.modified for f in rows]
        self.assertEqual(mods, sorted(mods, reverse=True))

    def test_delete_removes_and_404s_after(self) -> None:
        rec = self.store.add("gone.txt", b"x", node="polaris")
        self.store.delete(rec.id)
        self.assertTrue(self.store.is_empty())
        with self.assertRaises(FileNotFound):
            self.store.get(rec.id)
        with self.assertRaises(FileNotFound):
            self.store.delete(rec.id)

    def test_seed_only_when_empty(self) -> None:
        self.store.seed_if_empty()
        n = len(self.store.list().files)
        self.assertGreater(n, 0)
        self.store.seed_if_empty()  # idempotent — no duplicate seeding
        self.assertEqual(len(self.store.list().files), n)


if __name__ == "__main__":
    unittest.main()

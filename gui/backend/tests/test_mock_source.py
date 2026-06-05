"""MockDataSource shape checks — the contract the real per-node source must meet.

No live node/wg/file-server needed. Locks the wire shape the frontend decodes:
node identity, files newest-first, IDS events newest-first and limited.
"""

from __future__ import annotations

import unittest

from app.models import IdsSource
from app.sources import MockDataSource


class TestMockSource(unittest.TestCase):
    def setUp(self) -> None:
        self.src = MockDataSource()

    def test_node_identity(self) -> None:
        node = self.src.node()
        self.assertEqual(node.name, "polaris")
        self.assertEqual(node.wg_interface, "wg0")

    def test_files_listed_newest_first(self) -> None:
        snap = self.src.files()
        self.assertTrue(snap.bind.startswith("wg0"))  # island-bound, never public
        self.assertTrue(snap.files)
        mods = [f.modified for f in snap.files]
        self.assertEqual(mods, sorted(mods, reverse=True))

    def test_ids_newest_first_and_limited(self) -> None:
        events = self.src.ids(limit=3)
        self.assertEqual(len(events), 3)
        ats = [e.at for e in events]
        self.assertEqual(ats, sorted(ats, reverse=True))
        # all sources are host sensors — no mesh/daemon source survives
        self.assertTrue(all(isinstance(e.source, IdsSource) for e in events))


if __name__ == "__main__":
    unittest.main()

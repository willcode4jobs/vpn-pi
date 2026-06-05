"""MockDataSource shape checks — node identity + IDS feed.

No live node/sensors needed. Locks the wire shape the frontend decodes. Files
are no longer here (they're the SQLite store — see test_file_store.py).
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

from app.models import IdsSource
from app.sources import MockDataSource


class TestMockSource(unittest.TestCase):
    def setUp(self) -> None:
        self.src = MockDataSource()

    def test_node_identity_defaults_to_polaris(self) -> None:
        node = self.src.node()
        self.assertEqual(node.name, "polaris")
        self.assertEqual(node.wg_interface, "wg0")

    def test_node_identity_is_per_node_via_env(self) -> None:
        with mock.patch.dict(os.environ, {"GUI_NODE_NAME": "sirius"}, clear=False):
            node = MockDataSource().node()
        self.assertEqual(node.name, "sirius")  # uploads will be attributed to sirius

    def test_ids_newest_first_and_limited(self) -> None:
        events = self.src.ids(limit=3)
        self.assertEqual(len(events), 3)
        ats = [e.at for e in events]
        self.assertEqual(ats, sorted(ats, reverse=True))
        # all sources are host sensors — no mesh/daemon source survives
        self.assertTrue(all(isinstance(e.source, IdsSource) for e in events))


if __name__ == "__main__":
    unittest.main()

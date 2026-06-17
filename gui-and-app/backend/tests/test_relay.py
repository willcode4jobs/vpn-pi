"""Hub relay buffer checks — deposit/drain cursor, bounded eviction, opacity.

A temp sqlite file; no crypto and no network. The relay must behave as a dumb,
bounded, opaque drop box — these lock that.
"""

from __future__ import annotations

import os
import tempfile
import unittest

from app.relay import RelayBuffer


class TestRelayBuffer(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.buf = RelayBuffer(os.path.join(self._dir.name, "relay.db"), cap=5)

    def tearDown(self) -> None:
        self._dir.cleanup()

    def test_deposit_then_drain_from_zero(self) -> None:
        self.buf.deposit("10.42.0.5", 1, "ct-a")
        self.buf.deposit("10.42.0.4", 2, "ct-b")
        batch = self.buf.drain(since=0)
        self.assertEqual([b.ct for b in batch.blobs], ["ct-a", "ct-b"])  # oldest-first
        self.assertEqual(batch.cursor, 2)

    def test_drain_is_incremental_by_cursor(self) -> None:
        self.buf.deposit("10.42.0.5", 1, "ct-a")
        first = self.buf.drain(since=0)
        self.buf.deposit("10.42.0.5", 2, "ct-b")
        second = self.buf.drain(since=first.cursor)
        self.assertEqual([b.ct for b in second.blobs], ["ct-b"])  # only the new one
        self.assertEqual(second.cursor, 2)

    def test_drain_past_end_is_empty_and_holds_cursor(self) -> None:
        self.buf.deposit("10.42.0.5", 1, "ct-a")
        batch = self.buf.drain(since=99)
        self.assertEqual(batch.blobs, [])
        self.assertEqual(batch.cursor, 99)

    def test_bounded_eviction_keeps_newest_cap(self) -> None:
        for i in range(8):  # cap is 5
            self.buf.deposit("10.42.0.5", i, f"ct-{i}")
        all_blobs = self.buf.drain(since=0, limit=100).blobs
        self.assertEqual(len(all_blobs), 5)
        self.assertEqual([b.ct for b in all_blobs], [f"ct-{i}" for i in range(3, 8)])

    def test_ciphertext_stored_verbatim(self) -> None:
        opaque = "Zm9vYmFy/+=="  # arbitrary base64-ish string
        self.buf.deposit("10.42.0.5", 1, opaque)
        self.assertEqual(self.buf.drain(since=0).blobs[0].ct, opaque)


if __name__ == "__main__":
    unittest.main()

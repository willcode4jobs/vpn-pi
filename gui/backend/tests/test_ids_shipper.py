"""Shipper checks — ships unsent, monotonic seq, retry-without-consuming, state.

Injected source + poster + temp state file; no journal, no hub. Locks the
node-side contract: every unsent event ships once with a contiguous per-node
sequence, a failed POST doesn't burn a seq, and restarts don't re-ship.
"""

from __future__ import annotations

import base64
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from nacl.public import PrivateKey
from nacl.signing import SigningKey

from app.ids_crypto import open_verify
from app.ids_shipper import Shipper
from app.models import IdsEvent, IdsSeverity, IdsSource

_T0 = datetime(2026, 6, 6, 12, 0, 0, tzinfo=timezone.utc)


def _ev(eid: str, secs: int) -> IdsEvent:
    return IdsEvent(
        id=eid,
        at=_T0 + timedelta(seconds=secs),
        source=IdsSource.LOGIN,
        severity=IdsSeverity.INFO,
        subject="billy",
        message=f"event {eid}",
    )


class _FakeSource:
    def __init__(self, events):
        self._events = events

    def ids(self, limit: int = 100):
        return list(self._events)[:limit]


class _Poster:
    """Records (node, seq, ct); returns True unless seq is in `fail_on`."""

    def __init__(self, fail_on=()):
        self.calls = []
        self.fail_on = set(fail_on)

    def __call__(self, node, seq, ct):
        if seq in self.fail_on:
            return False
        self.calls.append((node, seq, ct))
        return True


class TestShipper(unittest.TestCase):
    def setUp(self) -> None:
        self.master = PrivateKey.generate()
        self.node_key = SigningKey.generate()
        self._dir = tempfile.TemporaryDirectory()
        self.state = os.path.join(self._dir.name, "state.json")

    def tearDown(self) -> None:
        self._dir.cleanup()

    def _shipper(self, source, poster):
        return Shipper(
            source=source,
            node_addr="10.42.0.5",
            signing_key=self.node_key,
            master_public=self.master.public_key,
            relay_url="http://hub",
            state_path=self.state,
            poster=poster,
            interval=0,
            window=50,
        )

    def test_ships_all_unsent_with_monotonic_seq(self) -> None:
        poster = _Poster()
        n = self._shipper(_FakeSource([_ev("a", 1), _ev("b", 2), _ev("c", 3)]), poster).ship_once()
        self.assertEqual(n, 3)
        self.assertEqual([seq for _, seq, _ in poster.calls], [1, 2, 3])

    def test_does_not_reship_seen(self) -> None:
        src, poster = _FakeSource([_ev("a", 1)]), _Poster()
        ship = self._shipper(src, poster)
        ship.ship_once()
        self.assertEqual(ship.ship_once(), 0)  # nothing new
        self.assertEqual(len(poster.calls), 1)

    def test_failed_post_does_not_consume_seq(self) -> None:
        src = _FakeSource([_ev("a", 1), _ev("b", 2), _ev("c", 3)])
        poster = _Poster(fail_on={2})  # 'b' fails
        ship = self._shipper(src, poster)
        self.assertEqual(ship.ship_once(), 1)  # only 'a' got through, then stop
        poster.fail_on.clear()
        # next cycle retries b and c as seq 2,3 — contiguous, nothing skipped
        self.assertEqual(ship.ship_once(), 2)
        self.assertEqual([seq for _, seq, _ in poster.calls], [1, 2, 3])

    def test_state_persists_across_restart(self) -> None:
        src = _FakeSource([_ev("a", 1), _ev("b", 2)])
        self._shipper(src, _Poster()).ship_once()
        # a fresh shipper on the same state file must resume, not re-ship
        poster2 = _Poster()
        self.assertEqual(self._shipper(src, poster2).ship_once(), 0)
        self.assertEqual(poster2.calls, [])

    def test_shipped_blob_decrypts_to_signed_payload(self) -> None:
        poster = _Poster()
        self._shipper(_FakeSource([_ev("a", 1)]), poster).ship_once()
        _, seq, ct = poster.calls[0]
        payload = open_verify(base64.b64decode(ct), self.master, lambda n: self.node_key.verify_key)
        self.assertEqual(payload["node"], "10.42.0.5")
        self.assertEqual(payload["seq"], seq)
        self.assertEqual(payload["event"]["subject"], "billy")


if __name__ == "__main__":
    unittest.main()

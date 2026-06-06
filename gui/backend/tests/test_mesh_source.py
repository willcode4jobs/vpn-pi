"""MeshDataSource checks — pull, decrypt+verify, dedupe, merge, fail-closed.

Ephemeral keys; the relay pull is injected (no hub). Locks the master-side
contract: only verified blobs become events, attribution is the verified node,
(node, seq) dedupes, and the master's own local feed is merged in.
"""

from __future__ import annotations

import base64
import unittest
from datetime import datetime, timedelta, timezone

from nacl.public import PrivateKey
from nacl.signing import SigningKey

from app.ids_crypto import seal_sign
from app.models import IdsEvent, IdsSeverity, IdsSource, NodeIdentity
from app.relay import RelayBatch, RelayDeposit
from app.sources.mesh import MeshDataSource

_T0 = datetime(2026, 6, 6, 12, 0, 0, tzinfo=timezone.utc)


def _ev(eid: str, secs: int, subject: str) -> IdsEvent:
    return IdsEvent(
        id=eid,
        at=_T0 + timedelta(seconds=secs),
        source=IdsSource.AUTH,
        severity=IdsSeverity.CRIT,
        subject=subject,
        message=f"event {eid}",
    )


class _FakeLocal:
    def node(self) -> NodeIdentity:
        return NodeIdentity(name="polaris", role="master", wg_interface="wg0")

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        return [_ev("local-1", 500, "billy@tty1")]  # the master's own feed


class TestMeshSource(unittest.TestCase):
    def setUp(self) -> None:
        self.master = PrivateKey.generate()
        self.node_key = SigningKey.generate()
        self.node = "10.42.0.5"
        self.registry = {self.node: self.node_key.verify_key}

    def _verify_for(self, node):
        return self.registry.get(node)

    def _blob(self, seq: int, ev: IdsEvent, *, node=None, signer=None) -> RelayDeposit:
        node = node or self.node
        signer = signer or self.node_key
        payload = {"node": node, "seq": seq, "event": ev.model_dump(mode="json")}
        ct = base64.b64encode(seal_sign(payload, signer, self.master.public_key)).decode()
        return RelayDeposit(node=node, seq=seq, ct=ct)

    def _mesh(self, blobs, cursor=10, local=None):
        return MeshDataSource(
            master_private=self.master,
            verify_key_for=self._verify_for,
            relay_url="http://hub",
            local=local,
            puller=lambda since: RelayBatch(cursor=cursor, blobs=blobs),
        )

    def test_decrypts_and_attributes_from_verified_identity(self) -> None:
        mesh = self._mesh([self._blob(1, _ev("a", 10, "1.2.3.4"))])
        events = mesh.ids()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].node, self.node)  # from the signature, not self-report
        self.assertEqual(events[0].subject, "1.2.3.4")

    def test_merges_local_feed_newest_first(self) -> None:
        mesh = self._mesh([self._blob(1, _ev("a", 10, "x"))], local=_FakeLocal())
        events = mesh.ids()
        self.assertEqual(len(events), 2)  # mesh event + local event
        ats = [e.at for e in events]
        self.assertEqual(ats, sorted(ats, reverse=True))

    def test_dedupes_by_node_seq(self) -> None:
        b = self._blob(1, _ev("a", 10, "x"))
        mesh = self._mesh([b, b])  # same (node, seq) twice
        self.assertEqual(len(mesh.ids()), 1)

    def test_unknown_node_dropped(self) -> None:
        stranger = SigningKey.generate()  # not in the registry
        mesh = self._mesh([self._blob(1, _ev("a", 10, "x"), node="10.42.0.9", signer=stranger)])
        self.assertEqual(mesh.ids(), [])

    def test_tampered_blob_dropped(self) -> None:
        b = self._blob(1, _ev("a", 10, "x"))
        raw = bytearray(base64.b64decode(b.ct))
        raw[-1] ^= 0x01
        b = RelayDeposit(node=b.node, seq=b.seq, ct=base64.b64encode(bytes(raw)).decode())
        self.assertEqual(self._mesh([b]).ids(), [])

    def test_outer_inner_mismatch_dropped(self) -> None:
        # signed payload says node=self.node, but the hub-visible routing says else
        good = self._blob(1, _ev("a", 10, "x"))
        spoof = RelayDeposit(node="10.42.0.4", seq=1, ct=good.ct)
        self.assertEqual(self._mesh([spoof]).ids(), [])


if __name__ == "__main__":
    unittest.main()

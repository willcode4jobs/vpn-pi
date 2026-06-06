"""IDS envelope checks — sign-then-seal round-trip and the rejection paths.

Ephemeral keys, no files or network. Locks the security contract: only the
master decrypts; only a registered node's signature verifies; tamper, wrong
signer, and unknown node all fail closed.
"""

from __future__ import annotations

import unittest

from nacl.public import PrivateKey
from nacl.signing import SigningKey

from app.ids_crypto import VerificationError, open_verify, seal_sign

_PAYLOAD = {
    "node": "10.42.0.5",
    "seq": 47,
    "at": "2026-06-06T12:00:00Z",
    "event": {"source": "auth", "severity": "crit", "subject": "203.0.113.77", "message": "ban"},
}


class TestIdsCrypto(unittest.TestCase):
    def setUp(self) -> None:
        self.master = PrivateKey.generate()
        self.node = SigningKey.generate()
        self.registry = {"10.42.0.5": self.node.verify_key}

    def _lookup(self, node):
        return self.registry.get(node)

    def test_round_trip_returns_payload(self) -> None:
        blob = seal_sign(_PAYLOAD, self.node, self.master.public_key)
        out = open_verify(blob, self.master, self._lookup)
        self.assertEqual(out, _PAYLOAD)

    def test_hub_cannot_read_blob(self) -> None:
        # the blob a hub stores must not contain the cleartext message
        blob = seal_sign(_PAYLOAD, self.node, self.master.public_key)
        self.assertNotIn(b"203.0.113.77", blob)
        self.assertNotIn(b"ban", blob)

    def test_tampered_blob_rejected(self) -> None:
        blob = bytearray(seal_sign(_PAYLOAD, self.node, self.master.public_key))
        blob[-1] ^= 0x01  # flip a bit in the ciphertext
        with self.assertRaises(VerificationError):
            open_verify(bytes(blob), self.master, self._lookup)

    def test_wrong_signer_rejected(self) -> None:
        # signed by a different key than the registry holds for this node
        impostor = SigningKey.generate()
        blob = seal_sign(_PAYLOAD, impostor, self.master.public_key)
        with self.assertRaises(VerificationError):
            open_verify(blob, self.master, self._lookup)

    def test_unknown_node_rejected(self) -> None:
        blob = seal_sign(_PAYLOAD, self.node, self.master.public_key)
        with self.assertRaises(VerificationError):
            open_verify(blob, self.master, lambda node: None)  # empty registry

    def test_wrong_master_key_cannot_open(self) -> None:
        other_master = PrivateKey.generate()
        blob = seal_sign(_PAYLOAD, self.node, self.master.public_key)
        with self.assertRaises(VerificationError):
            open_verify(blob, other_master, self._lookup)


if __name__ == "__main__":
    unittest.main()

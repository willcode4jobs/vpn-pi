"""The IDS alert envelope — sign-then-seal, so the hub stays blind.

Each alert leaves its origin node as an opaque blob the hub can buffer but never
read or forge. Two guarantees, applied in this order:

  1. SIGN  the canonical payload with the node's Ed25519 key  -> authenticity.
  2. SEAL  (payload + signature) to the master's X25519 public key (libsodium
           crypto_box_seal / nacl SealedBox) -> confidentiality.

Sign-*then*-seal means the signature lives INSIDE the sealed box: the hub sees
neither the alert nor a node-attributable signature, only ciphertext (plus the
outer {node, seq} it needs to route — those are repeated, authenticated, inside).

Only nodes (seal+sign) and the master (open+verify) import this. The hub does
not — keep it that way so the relay path has no crypto dependency.

Canonicalisation: json with sorted keys and no whitespace, so the bytes the node
signs are exactly the bytes the master re-derives and verifies. Keep payloads to
JSON scalars (str/int/bool) and ISO strings — no floats — so the round-trip is
byte-identical.
"""

from __future__ import annotations

import base64
import json
from typing import Callable

from nacl.exceptions import BadSignatureError, CryptoError
from nacl.public import PrivateKey, PublicKey, SealedBox
from nacl.signing import SigningKey, VerifyKey

# Resolve a node identity (the payload's "node") to its trusted Ed25519 verify
# key, or None if the node is unknown. Injected so this module doesn't depend on
# the registry (app/ids_registry.py) — and so tests can pass a dict.
VerifyKeyFor = Callable[[str], "VerifyKey | None"]


class VerificationError(Exception):
    """Raised when a blob cannot be opened or its signature/origin is not
    trusted. The caller drops the blob (and should count it — a failed verify is
    itself a security signal)."""


def _canonical(payload: dict) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def seal_sign(
    payload: dict, signing_key: SigningKey, master_public_key: PublicKey
) -> bytes:
    """Node side: sign `payload`, then seal (payload + signature) to the master.
    Returns the opaque ciphertext to hand to the hub."""
    canonical = _canonical(payload)
    signature = signing_key.sign(canonical).signature  # 64-byte detached sig
    inner = json.dumps(
        {"payload": payload, "sig": base64.b64encode(signature).decode("ascii")},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return SealedBox(master_public_key).encrypt(inner)


def open_verify(
    blob: bytes, master_private_key: PrivateKey, verify_key_for: VerifyKeyFor
) -> dict:
    """Master side: decrypt, then verify the signature against the registered key
    for the payload's `node`. Returns the trusted payload, or raises
    VerificationError. Fail-closed: any decrypt/parse/trust/signature problem is
    a rejection, never a pass-through."""
    try:
        inner = SealedBox(master_private_key).decrypt(blob)
    except (CryptoError, ValueError) as e:
        raise VerificationError("cannot decrypt blob") from e

    try:
        obj = json.loads(inner)
        payload = obj["payload"]
        signature = base64.b64decode(obj["sig"])
        node = payload["node"]
    except (ValueError, KeyError, TypeError) as e:
        raise VerificationError("malformed sealed contents") from e

    verify_key = verify_key_for(node)
    if verify_key is None:
        raise VerificationError(f"unknown node, not in registry: {node!r}")

    try:
        verify_key.verify(_canonical(payload), signature)
    except BadSignatureError as e:
        raise VerificationError(f"bad signature for node {node!r}") from e

    return payload


# --- key (de)serialisation: base64 of the raw key bytes, for env-file storage ---

def load_master_private(b64: str) -> PrivateKey:
    return PrivateKey(base64.b64decode(b64))


def load_master_public(b64: str) -> PublicKey:
    return PublicKey(base64.b64decode(b64))


def load_signing(b64: str) -> SigningKey:
    return SigningKey(base64.b64decode(b64))


def load_verify(b64: str) -> VerifyKey:
    return VerifyKey(base64.b64decode(b64))


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")

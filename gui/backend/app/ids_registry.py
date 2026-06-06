"""Node verify-key registry — who the master trusts to sign alerts.

The master's counterpart to the wg0 peer allowlist (app/peers.py): a map from a
node identity (its wg0 address, the same identity used everywhere else) to that
node's Ed25519 **public** verify key. open_verify() (app/ids_crypto.py) consults
this; a node with no entry is untrusted and its blobs are dropped (fail-closed).

These are public keys — committing/auditing the registry is safe and gives a
record of who is trusted. Revocation = delete the line and restart the master.

Source: a file at GUI_IDS_REGISTRY, one `node=base64-verify-key` per line
(blank lines and `#` comments allowed). No default entries — an empty registry
trusts no one, which is the correct closed default for a security feature.
"""

from __future__ import annotations

import os

from nacl.signing import VerifyKey

from app.ids_crypto import load_verify


def _load() -> dict[str, VerifyKey]:
    path = os.environ.get("GUI_IDS_REGISTRY")
    if not path or not os.path.exists(path):
        return {}
    out: dict[str, VerifyKey] = {}
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            node, sep, key_b64 = line.partition("=")
            node, key_b64 = node.strip(), key_b64.strip()
            if not sep or not node or not key_b64:
                raise RuntimeError(f"registry entry must be 'node=base64key', got: {line!r}")
            out[node] = load_verify(key_b64)
    return out


_REGISTRY = _load()


def verify_key_for(node: str) -> VerifyKey | None:
    """The trusted verify key for a node, or None if it is not registered."""
    return _REGISTRY.get(node)

#!/usr/bin/env python3
"""ids-keygen.py — mint IDS keypairs for the blind-relay alert layer.

Run on the relevant host; private keys are written 0600 (owner-only), public
keys are printed for distribution/registration. Uses the backend's venv so
PyNaCl is available:

    # on the master (polaris) — the X25519 keypair that seals/opens alerts
    ./.venv/bin/python ../deploy/ids-keygen.py master --out /var/lib/vpn-pi/ids

    # on each sensor node (sirius, altair, vega, polaris-local) — Ed25519 signer
    ./.venv/bin/python ../deploy/ids-keygen.py node --out /var/lib/vpn-pi/ids

What lands where (see docs/ids-planning/03-crypto-and-keys.md):
  - master: writes master.key (X25519 private, SECRET) and prints master.pub
            (X25519 public) — copy master.pub to every node.
  - node:   writes node.key (Ed25519 private, SECRET) and prints the verify key
            — add it to the master's registry as `<this node's wg0 addr>=<key>`.

Nothing here touches the network or the registry; distribution is manual/by
runbook so a secret never transits the hub.
"""

from __future__ import annotations

import argparse
import base64
import os
import sys

from nacl.public import PrivateKey
from nacl.signing import SigningKey


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _write_private(path: str, raw: bytes) -> None:
    # Create 0600 from the start — never widen later.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(base64.b64encode(raw))
    print(f"wrote private key (0600): {path}")


def gen_master(out_dir: str) -> None:
    priv = PrivateKey.generate()
    _write_private(os.path.join(out_dir, "master.key"), priv.encode())
    pub_b64 = _b64(priv.public_key.encode())
    pub_path = os.path.join(out_dir, "master.pub")
    with open(pub_path, "w", encoding="utf-8") as fh:
        fh.write(pub_b64 + "\n")
    print(f"wrote public key:        {pub_path}")
    print(f"\nmaster public key (copy to every node's master.pub):\n{pub_b64}")


def gen_node(out_dir: str) -> None:
    signing = SigningKey.generate()
    _write_private(os.path.join(out_dir, "node.key"), signing.encode())
    verify_b64 = _b64(signing.verify_key.encode())
    print(f"\nverify key — register on the master as  <node-wg0-addr>={verify_b64}")


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description="mint IDS keypairs")
    p.add_argument("role", choices=["master", "node"])
    p.add_argument("--out", default=".", help="directory for key files (default: cwd)")
    args = p.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    if args.role == "master":
        gen_master(args.out)
    else:
        gen_node(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

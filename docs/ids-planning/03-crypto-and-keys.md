# 03 — Crypto and keys

The envelope that makes the hub blind, the library to do it with, and how keys
are generated, distributed, and registered. Goal: a vetted, misuse-resistant
construction — not a hand-rolled one.

## 1. Primitives

Two operations per alert, in this order — **sign, then seal**:

1. **Sign** the canonical payload with the originating node's **Ed25519** key
   → authenticity + integrity. The master verifies against a known pubkey.
2. **Seal** `(payload ‖ signature)` to the **master's X25519** public key
   → confidentiality. Only the master's private key opens it.

Sign-then-seal (vs seal-then-sign) so the signature is itself hidden from the
hub — the hub sees one opaque blob, no node-attributable signature in the clear
beyond the routing `node` field it needs anyway.

## 2. Library choice — PyNaCl (decided)

**PyNaCl** (libsodium bindings). One pre-pin check remains: confirm the wheel
installs cleanly on a Pi (aarch64) and on sirius (py3.12 venv) before pinning the
version — not a design question, just a packaging smoke test.
- `nacl.public.SealedBox(master_pub)` is exactly crypto_box_seal — anonymous,
  ephemeral-key sealing to a recipient public key. Purpose-built; nothing to
  assemble.
- `nacl.signing.SigningKey` / `VerifyKey` for Ed25519.
- Hard to misuse — no nonce/IV/AEAD wiring to get wrong. For a security course
  deliverable, "can't be misused" matters more than raw flexibility.

**Alternative: `cryptography`.** More mature wheel coverage on arm64 (the Pis)
and broad Python versions, but you assemble X25519 + HKDF + ChaCha20-Poly1305
yourself — more surface to get wrong. Choose this only if PyNaCl wheels prove
painful on a node.

**Wheel caveat (both):** sirius runs Python 3.14, which already lacks wheels for
the pinned pydantic-core (`RUNBOOK-sirius.md` §2). Same fix applies — build the
venv with `python3.12`. With a 3.12 venv, both PyNaCl and `cryptography` have
prebuilt aarch64 + x86_64 wheels; no cargo/gcc build. Pin the version in
`gui/backend/requirements.txt` and test `pip install` on a Pi and on sirius
before committing.

> Only the **nodes** (sign+seal) and the **master** (open+verify) need the
> library. The **hub** needs nothing — it never touches the crypto. Keep that
> true: do not import the crypto lib on the relay path.

## 3. The blob (on-wire + at-rest format)

What a node POSTs to the hub and what the hub stores verbatim:

```jsonc
{
  "node": "10.42.0.5",     // routing + dedupe key; the hub needs this, it's not secret
  "seq": 47,                // per-node monotonic; gap + replay detection
  "ct":  "<base64>"          // SealedBox( sign_payload ‖ Ed25519 signature )
}
```

The signed-and-sealed **payload** (inside `ct`, only the master ever sees it):

```jsonc
{
  "node": "10.42.0.5",     // repeated INSIDE, so it's authenticated (outer is not)
  "seq":  47,
  "at":   "2026-06-06T12:00:00Z",
  "event": { "source": "...", "severity": "...", "subject": "...", "message": "..." }
}
```

`node` and `seq` appear both outside (hub routing) and inside (authenticated).
The master trusts only the inner copies; the outer ones are conveniences the hub
could lie about, and the master cross-checks them against the verified inner
values.

## 4. Keys: what exists where

| Key | Type | Lives on | Secret? | Distributed to |
|---|---|---|---|---|
| Master encryption key | X25519 priv | master only, 0600 root | **yes — crown jewel** | nobody |
| Master encryption pubkey | X25519 pub | every node | no | shipped to all nodes (safe over the hub) |
| Node signing key | Ed25519 priv | that node only, 0600 | yes (per-node) | nobody |
| Node verify key | Ed25519 pub | master registry | no | registered on the master |

## 5. Key generation, storage, distribution

- **Generate** with a small helper script (`gui/deploy/ids-keygen.py`, new): one
  command on the master mints its X25519 pair; one command per node mints that
  node's Ed25519 pair. Private keys written 0600, owned by the service user;
  public keys printed for registration.
- **Storage** — private keys in a dir like `/var/lib/vpn-pi/ids/` (the service
  already has `ReadWritePaths=/var/lib/vpn-pi`, see `su495-gui.service`). Path via
  env (§04): `GUI_IDS_NODE_KEY`, `GUI_IDS_MASTER_KEY`, `GUI_IDS_MASTER_PUBKEY`.
- **Distribution** — the master pubkey is non-secret; ship it to nodes in the
  repo/deploy or by hand. Node pubkeys are non-secret; collect them onto the
  master registry. No secret ever transits the hub.

## 6. The node registry on the master

Mirror the wg0 allowlist we already built (`gui/backend/app/peers.py`): a small
map the master trusts.

```
# app/ids_registry.py (new) — node identity → Ed25519 verify key
#   "10.42.0.5": "<sirius verify key, base64>",
#   "10.42.0.4": "<altair verify key, base64>",
#   ...  override via GUI_IDS_REGISTRY (path to a file) for deployment
```

- The master verifies a blob's inner signature with the key registered for that
  `node`. No registry entry → no trust → dropped (fail-closed).
- **Revocation** = delete the line and restart the master. Same "named island
  members" model as `peers.py`, so it stays consistent and auditable.
- Keys here are public — committing the registry is safe and gives an audit
  trail of who's trusted.

## 7. Rotation (policy, light for now)

- **Node key rotation** — mint a new pair, register the new pubkey, drop the old
  line. Brief overlap is fine (register both during cutover).
- **Master key rotation** — heavier (every node needs the new pubkey + a re-seal
  window). Out of scope for v1; document as a known cost. Treat the master key
  as long-lived and protect it accordingly.

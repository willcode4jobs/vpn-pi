# Refactor: TypeScript/Bun rewrite — gated island internet

This directory is the planning skeleton for the **Phase Two refactor**. It is
*planning only* — no code is moved or deleted by reading these files. The source
of intent is [`../../newContextFile.md`](../../newContextFile.md); these docs turn
that into a reviewable design.

## What changes (one paragraph)

The Python/React IDS GUI is retired. In its place: a single end-user **App** and a
near-identical **Admin** surface, both written in **TypeScript (run on Bun)**, running on a
**peer-to-peer WireGuard mesh with no hub relay**. Trust between nodes is no longer
a static wg0-IP allowlist — it is **mutual friending** (token give → accept). The
island is **gated**: by default there is no internet egress ("island mode"); a
cryptographically signed **canary** command, interpreted by a **local LLM
(Llama)**, is what opens the gate to internet access.

## Read in this order

| # | File | What it answers |
|---|---|---|
| 01 | [scope-and-goals.md](01-scope-and-goals.md) | What Phase Two is, what carries over, requirements traceability |
| 02 | [topology.md](02-topology.md) | The new P2P mesh, addressing, where the gate lives |
| 03 | [architecture.md](03-architecture.md) | TS/Bun component layout, the two "seamless" backends, module map |
| 04 | [friending-protocol.md](04-friending-protocol.md) | Token give/accept handshake, the crypto, revocation |
| 05 | [api-and-data.md](05-api-and-data.md) | HTTP surface (user + /admin), on-disk state |
| 06 | [canary-gate.md](06-canary-gate.md) | Canary keyword → LLM → egress gate, sign/seal |
| 07 | [migration-and-build.md](07-migration-and-build.md) | Archive branch, file deletion, Bun toolchain, tests |
| 08 | [open-questions.md](08-open-questions.md) | Decisions that are yours to make before build |

## What carries over from Phase One (don't reinvent)

- **The crypto model**: Ed25519 *sign* then X25519 *seal* (libsodium). Phase One's
  `ids_crypto.py` already proves this design; the Bun build uses `libsodium-wrappers`
  — the same libsodium PyNaCl wrapped, so envelopes stay byte-compatible. See
  [04](04-friending-protocol.md).
- **wg0 as the cryptographic boundary**: every app byte still travels inside
  WireGuard. Friending is the *application* trust layer on top, not a replacement
  for the tunnel.
- **The file share is vega's existing DB, reused** — one universal island share,
  same `files` schema. polaris's Phase One DB server is deprecated. See
  [02](02-topology.md) / [05](05-api-and-data.md).
- **Least privilege as the default**: gate closed unless explicitly opened; admin
  can revoke but never forge friendships. (Matches the project's standing posture.)

## Status

Skeleton drafted for review. Nothing in git has moved. See
[08-open-questions.md](08-open-questions.md) for what I need from you before the
first line of TypeScript gets written.

# Friend codes & the polaris registry (spec)

Status: **spec / not built.** Slots in as **Phase I** (post‑G; independent of the
Phase H migration). Replaces the raw‑JSON friend token with clean codes.

## Problem

Today a friend invite is a ~400‑byte JSON blob:

```json
{"v":1,"from":{"ed25519":"crZIru…","x25519":"Q6dV…","label":"demo","wg0":"127.0.0.1"},
 "nonce":"24cY…","issued":"…","expires":"…","sig":"BJCA…"}
```

That's a terrible thing to hand a person. We want a **friend code** — one clean
variable, ideally short (Switch‑style `ISL‑4827‑9931`).

## The constraint (and how polaris removes it)

A short code is only possible with a **directory**: Nintendo's `SW‑…` is short
because a server maps it to your account + keys. We're peer‑to‑peer with no
directory, so a self‑contained code must *carry* the keys (two 32‑byte Curve25519
keys + a 64‑byte signature) — that can't fit in 12 digits; physics, not laziness.

**polaris is orphaned** (its DB‑server role moved to vega — see
[02](02-topology.md)). We revive it as the **friend‑code registry**: a control‑plane
*directory*, never in the data path — consistent with keeping the master out of the
data path. That makes genuinely short codes possible.

## Design overview

Three layers, build in order; each is useful on its own:

1. **Compact code (offline, always works).** Replace JSON with one opaque string,
   `island-invite1…` — the current signed offer, binary‑packed and encoded. Paste
   flow unchanged, but it's a key variable, not a struct. This is the fallback when
   the registry is down or for an air‑gapped pair.
2. **Registry short codes (the nice path).** Each node announces its identity to
   polaris and gets a short **verifiable** code. Friending = paste the short code;
   your node resolves it via polaris.
3. **Mesh handshake (no blob pasting).** Once resolved, the signed request/accept
   travel node‑to‑node over the mesh instead of being copy‑pasted.

## Code formats (recommended — open to change)

| Code | What it is | Encoding | Length |
|---|---|---|---|
| **Friend code** (short, shareable) | a *fingerprint* of your identity key | Crockford base32 of ~50 bits, grouped: `ISL‑XXXXX‑XXXXX` | ~13 chars |
| **Invite** (offline, self‑contained) | the full signed offer | `island-invite1` + base64url(binary token) | ~200 chars |
| **Reply** (offline accept) | the signed accept | `island-accept1` + base64url | ~150 chars |

- **Friend code = `ISL-` + Crockford‑base32(first 50 bits of `SHA256(ed25519_pub)`).**
  Crockford base32 drops ambiguous chars (no I/L/O/U), good for typing. 50 bits →
  birthday collision near ~33M identities (registry rejects collisions on announce).
- **Shrink the invite by deriving x25519 from ed25519** (both are Curve25519;
  `crypto_sign_ed25519_pk_to_curve25519`) so we ship one key, not two. *Verify this
  is exposed by our libsodium build; if not, include x25519 in the packing.*

## The registry (on polaris)

polaris runs `islandd` with a registry role enabled
(`ISLAND_REGISTRY=1`, mirroring how vega enables the file share). Persistent SQLite
(`registry.db`) — reusing polaris's DB heritage for a control‑plane job.

```
POST /registry/announce
  body: { ed25519, x25519?, wg0, label, sig }   // sig = self-signature over the record
  → polaris verifies the SELF-signature (proves key ownership — no squatting),
    computes code = fingerprint(ed25519), upserts {code → record}, returns { code }.

GET  /registry/resolve/{code}
  → { ed25519, x25519?, wg0, label } or 404.
    Caller MUST recompute fingerprint(ed25519) and check it equals {code}.
```

Schema: `registry(code TEXT PRIMARY KEY, ed25519, x25519, wg0, label, sig, announced)`.

## Friending flow (registry path)

```
Alice                          polaris (registry)                 Bob's node
  │ enter Bob's code ISL-…           │                                │
  │ GET /registry/resolve/ISL-… ───►│                                │
  │ ◄── {ed25519,wg0,label}          │                                │
  │ verify fingerprint == code  (polaris CANNOT lie — see Security)   │
  │ signed friend request ─────────────────────────────────────────► │ POST /api/friends/request
  │                                                          (verify Alice's sig)
  │                                                          → PENDING (Home/Friends)
  │                                                          Bob taps Approve
  │ ◄──────────────── signed accept ──────────────────────────────── │ POST /api/friends/accept-inbound
  │ verify, record Bob as friend                              record Alice as friend
  └─ mutual.  No JSON, no signature copy-paste.
```

The signed request/accept are the **existing** `friends.ts` token/accept objects —
only the *transport* changes (mesh HTTP instead of paste) and *discovery* (code
instead of blob). The crypto is unchanged.

## Security analysis

- **polaris cannot MITM.** The code commits to the key (it's its fingerprint); the
  resolver re‑derives and checks. A substituted key fails the check. (Same idea as
  PGP fingerprints / Signal safety numbers.)
- **polaris cannot forge friendships.** It holds no private keys; the handshake is
  still signed by both parties. Compromised polaris ⇒ at worst denial/failed lookups.
- **No squatting.** `announce` requires a self‑signature over the record, proving you
  hold the ed25519 private key — you can only register *your own* key's code.
- **Discovery‑only / availability.** polaris is needed *only to find a new friend by
  code*. Existing friendships live locally and are unaffected if polaris is down; new
  friends can still be added via the offline `island-invite1…` string.
- **Privacy tradeoff.** polaris sees the directory (code → pubkey → wg0/label) — public
  metadata within the island. Announcing is **optional**: a node can friend purely by
  compact invite and never register.
- **Replay/expiry.** Unchanged from `friends.ts` (single‑use nonce + expiry); the
  inbound `/api/friends/request` is operator‑approved before it becomes a friendship.

## Code changes (new + touched)

| Module | Role |
|---|---|
| `core/friendcode.ts` *(new)* | `encodeInvite/decodeInvite`, `encodeAccept/decodeAccept` (compact), `fingerprint(ed25519)→code`, `codeMatches(ed25519,code)` |
| `core/registry.ts` *(new)* | client `announce()/resolve()` + `RegistryStore` (polaris SQLite) |
| `core/friends.ts` | unchanged crypto; add helpers to build a request from a resolved identity |
| `main.ts` | registry routes (polaris, gated by `ISLAND_REGISTRY`); `POST /api/friends/add {code|invite}`, inbound `POST /api/friends/request`, `POST /api/friends/accept-inbound`; approve→deliver |
| `web/index.html` | "Your friend code" (with Copy + QR); "Add a friend" = paste a code/invite + Approve; drop the JSON textareas |
| `deploy/RUNBOOK-registry.md` *(new)* | polaris: `ISLAND_REGISTRY=1`, `registry.db`, announce on boot |

## Build sub‑phases (each ships green)

- **I‑1 Compact codes** — ✅ DONE. `core/friendcode.ts` (+ tests) binary‑packs the
  token → `island-invite1…` (~249 chars vs ~540 JSON) / `island-reply1…`; routes, UI,
  and CLI emit/accept codes (legacy fields still accepted). Round‑trip preserves the
  signature. 68 tests pass.
- **I‑2 Your friend code + QR** — ✅ **I‑2a DONE**: `fingerprint()`/`codeMatches()` in
  `core/friendcode.ts` (`ISL‑…`, BLAKE2b, Crockford base32), exposed via `/api/identity`,
  shown as "your friend code" in the UI. ◻ **I‑2b**: a scannable **QR** of the invite,
  rendered by a vendored offline QR generator (no CDN — don't hand‑roll Reed‑Solomon).
- **I‑3 Registry** — ✅ DONE. `core/registry.ts`: `RegistryStore` (bun:sqlite),
  self-signed `announce` (anti-squat), `resolve` that re-derives the fingerprint
  (anti-MITM). Served at `POST /registry/announce` + `GET /registry/resolve/{code}`,
  gated by `ISLAND_REGISTRY=1` (polaris) — also on in `--mock`. 77 tests; live
  announce→resolve verified.
- **I‑4 Mesh handshake** — ✅ DONE. Nodes **auto-announce** on boot
  (`ISLAND_REGISTRY_URL`). `POST /api/friends/add {code}` resolves → sends a signed
  request to the peer's wg0 (`/api/friends/request` inbound) → operator approves →
  accept auto-delivers (`/api/friends/accept-inbound`). UI: an "Add a friend" by-code
  card (paste invite kept as the offline fallback). Verified live across 3 nodes +
  registry — no blob pasting.
- **I‑5 Deploy** — ✅ DONE. Folded into `island/deploy/RUNBOOK-deploy.md` §4 (polaris:
  `ISLAND_REGISTRY=1`; every node: `ISLAND_REGISTRY_URL`). **Phase I complete.**

## Open decisions for William

1. **Encodings** — Crockford base32 for the short code, base64url for the invite blob
   (my pick). You started "we could shift to a …" — name it and I'll switch (bech32
   `island1…`? base58? numeric‑only?).
2. **Friend‑code length** — ~50 bits (`ISL‑XXXXX‑XXXXX`) vs shorter/longer.
3. **Mandatory vs optional registry** — recommend optional (announce is opt‑in; offline
   invite always works).

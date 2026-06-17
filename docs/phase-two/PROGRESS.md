# Phase Two — Build Log (Phases A–F)

A record of what's actually been built and verified in [`island/`](../../island/).
Forward-looking plan: [BUILD-PLAN.md](BUILD-PLAN.md). Design rationale: `00`–`08`.

- **Stack:** TypeScript on Bun (1.3.x), one binary (`islandd`), `libsodium-wrappers`.
- **Status:** Phases A–G done (the whole app). **58 tests pass**, `tsc --noEmit` clean.
- **Git:** nothing moved/deleted/pushed — migration is Phase H. All work is new files
  under `island/`.

| Phase | Delivered | Tests (cumulative) |
|---|---|---|
| A | scaffold + crypto core | 11 |
| B | friending (token give/accept/confirm) | 24 |
| C | universal file share (vega SQLite, Phase One API) | 35 |
| D | direct P2P sealed messaging | 41 |
| E | home / sysinfo (fail2ban + wg status) | 46 |
| F | canary internet gate (GREEN18, Llama, 45-min) | 58 |
| G | admin surface + web UI + compile targets | 58 |

---

## Phase A — scaffold + crypto core

**Files:** `package.json`, `tsconfig.json`, `.gitignore`, `README.md`,
`src/main.ts`, `src/core/{sodium,codec,canonical,envelope,identity}.ts`,
`test/{canonical,envelope,identity}.test.ts`, `web/` + `deploy/` placeholders.

**What it does**
- `canonical.ts` — canonical JSON that is **byte-identical to Phase One's Python**
  (`json.dumps(sort_keys=True, separators=(",",":"))` with `ensure_ascii`). This is
  what gets signed, so it must match exactly; verified against real CPython golden
  vectors, including the escaping boundary (`é`→`é`, DEL `0x7f`→``).
- `envelope.ts` — **sign-then-seal / open-then-verify**, ported verbatim from
  `ids_crypto.py`: Ed25519 detached signature (authenticity) sealed inside a
  `crypto_box_seal` to the recipient's X25519 key (confidentiality). Fail-closed.
- `identity.ts` — load Ed25519 + X25519 keypairs from a directory (base64 of raw
  bytes, same as Phase One `b64()`); `generate`/`save` helpers are **dev/mock/test
  only** (real keys are made by William and only loaded).
- `main.ts` — arg parse (`--mock/--host/--port`), boot crypto, `Bun.serve()`,
  `GET /api/health`.

**Decisions / gotchas**
- **libsodium load:** the ESM build of `libsodium-wrappers` has a broken relative
  import, so it's loaded with a literal `require("libsodium-wrappers")` (CJS). This
  works under `bun run` *and* lets `bun build --compile` embed it into a
  self-contained binary.

**Verified:** 11 tests; mock run serves `/api/health`; `bun build --compile`
produces a working standalone binary (the "singular file" deliverable).

---

## Phase B — friending

**Files:** `src/core/friends.ts`, `test/friends.test.ts`; `main.ts` gains identity +
persisted `FriendBook` and the friend routes.

**What it does** — friending is the island's *only* authorization primitive. The
handshake (giver Alice, receiver Bob):

1. `POST /api/friends/token` — Alice mints a **signed, expiring, single-use** token
   (recorded OFFERED), handed to Bob out-of-band.
2. `POST /api/friends/receive` — Bob verifies it; it becomes a PENDING request.
3. `POST /api/friends/accept` — Bob → FRIENDS, returns an **accept blob** (signed by
   Bob, **sealed to Alice**).
4. `POST /api/friends/confirm` — Alice opens+verifies → FRIENDS. Mutual.

`GET /api/friends` lists friends + pending + offered count. State persists to
`friends.json` (`FriendBook.toJSON/fromJSON`), including consumed nonces.

**The security property:** the verified handshake is the **only** path that writes to
`friends` — there is no `addFriend`/`forceFriend`/`setFriend` (asserted in tests). So
an admin can later *delete* a friendship but can never *forge* one.

**Decisions / deviations**
- The plan sketched 2 routes; the real handshake needs **4** — the giver must also
  consume the accept (`/receive`, `/confirm` added).

**Verified:** 24 tests (give→receive→accept→confirm = mutual; expiry; tamper; replay;
one-time confirm; self-friend block; third-party can't open accept; opaque blob;
revoke; serialize/restore; no-force-API). **Live HTTP handshake** between two daemons
→ mutual friends, replayed `confirm` → 400.

---

## Phase C — universal file share

**Files:** `src/core/share.ts`, `test/share.test.ts`; `main.ts` gains the file routes
+ a friendship guard.

**What it does** — mirrors the Phase One file-store convention exactly: one
`FileShare` interface with three implementations selected by `ISLAND_SHARE`:
- `MemoryFileShare` (mock/dev, ≈ PlaceholderFileStore)
- `SqliteFileShare` (**vega**, durable, **reuses the Phase One `files` schema** via
  `bun:sqlite`) — polaris's old DB server is retired
- `RemoteFileShare` (a node forwarding to vega, ≈ RemoteFileStore)

**API (Phase One convention verbatim):**
`GET /api/files` → `FilesSnapshot {root,bind,files}`,
`POST /api/files` (multipart `file`) → `SharedFile` **201**,
`GET /api/files/{id}/download` (Content-Disposition),
`DELETE /api/files/{id}` → **204**.

**Phase Two adaptations (per locked decisions)**
- Access is gated by **friendship**, not the wg0-IP allowlist: a request's wg0 source
  IP → friend lookup (WireGuard pins IP↔key); loopback = the local operator; `--mock`
  is open for the laptop demo.
- The adder `node` is the caller's **verified Ed25519 identity** (Q3b), set by the
  upstream (vega) — a forwarding node can't spoof it. Fully shared among members.

**Verified:** 35 tests (add/list/get/remove + FileNotFound across Memory & SQLite;
SQLite persists across reopen). Full HTTP lifecycle (201/list/download/204/404) and
the `RemoteFileShare` proxy both verified live.

**Note:** the planned `core/store.ts` proved unnecessary — `RemoteFileShare` is the
node→vega client and local friend state already lives in `friends.json`.

---

## Phase D — direct P2P messaging

**Files:** `src/core/messages.ts`, `test/messages.test.ts`;
`FriendBook.verifyKeyResolver()`; `main.ts` gains the message routes + dual
persistence.

**What it does** — messages are envelopes: signed by the sender, sealed to the
recipient. The sender delivers the blob **straight to the friend's wg0** (no hub);
the recipient opens it, verifies against **friends-only** keys, and appends to an
append-only per-peer log (`messages.json`). A thread is the merge of out + in.

- `GET /api/messages?peer=` / `POST /api/messages` — **operator-only** (loopback/mock).
- `POST /api/messages/inbound` — peer delivery, **crypto-gated** (sender must be a
  verified friend; non-friend / garbage → 403).
- Delivery target: `peerInbound(wg0, ISLAND_PEER_PORT)`.

**Verified:** 41 tests (seal/open round-trip; non-friend rejected; third party can't
open; opaque blob; resolver resolves only friends; thread order + serialize). **Live
two-node conversation** over HTTP both directions; garbage inbound → 403.

---

## Phase E — home / sysinfo

**Files:** `src/core/sysinfo.ts`, `test/sysinfo.test.ts`; `main.ts` gains `ctx.gate`
(default-island stub), the `/api/home` and `/api/gate` routes.

**What it does** — the node's own dashboard, no privilege elevation:
- `readFail2ban()` reconstructs jail state from the **journal** (Ban − Unban replay,
  ported from `sources/fail2ban.py`, `JailStatus` shape) — needs `systemd-journal`,
  no sudo.
- `readWg(iface)` parses `wg show <iface> dump` → peers with handshake age + up flag.
- Both degrade to empty on failure; runners are injected for tests; `--mock` returns
  synthetic data so Home demos on a laptop.
- `GET /api/home` (operator-only) → `{gate, wg, fail2ban, requests}`, wg peers enriched
  with the friend label via `friendByWg0`. `GET /api/gate` → island/internet (the
  default-island `ctx.gate`, replaced by the real gate in Phase F).

**Verified:** 46 tests (Ban−Unban replay incl. the "Unban-isn't-a-Ban" case; degrade
to []; wg parse with handshake-age/up + never-handshaked; degrade to no peers). Live
`/api/home` shows gate + synthetic wg/fail2ban + a real pending friend request.

**Note:** the Home **frontend** is deferred to Phase G (the web bundle); Phase E is
the data/API.

## Phase F — canary internet gate (vega)

**Files:** `src/core/canary.ts`, `src/core/gate.ts`, `test/canary.test.ts`,
`test/gate.test.ts`, `deploy/island-gate` + `deploy/island-gate.sudoers` +
`deploy/RUNBOOK-gate.md`; `main.ts` gains the real `Gate` + canary routes.

**What it does** — the only way to open internet egress:
- `canary.ts` — `makeCanary`/`verifyCanary`: admin-signed, sealed to vega (envelope
  reuse). Hard checks: seal opens, signer ∈ admin allowlist, `GREEN18` is the first
  token, freshness window. Fail-closed.
- `gate.ts` — `Gate` (default island) + `LlamaClient` (`MockLlama`; `LlamaHttp`
  fail-safe deny on unreachable) + `GateExec` (`NoopGateExec`; `ShellGateExec` spawns
  a fixed `open`/`close` verb). Approve → exec.open → state internet + **45-min**
  auto-reclose → log; deny and close paths logged; nonce single-use (replay rejected).
- **Privilege model: pinned-helper** (William's decision). `deploy/island-gate` is a
  root-owned script holding the real nft rules; `islandd` only spawns `open`/`close`;
  a pinned sudoers line (no wildcards) grants exactly those two. The 5 hard
  constraints are in `RUNBOOK-gate.md`. The web process never touches nftables.
- Routes: `POST /admin/canary` (crypto-gated — admin app can call remotely),
  `GET /admin/gate/log`, `POST /admin/gate/close` (operator), and the real
  `GET /api/gate`. `--mock`: `POST /admin/canary/mint` drives the full flow on a laptop.

**Security posture:** the canary's signature + seal + single-use nonce + freshness is
the gate; **Llama is a subordinate refusal layer** (and fail-safe deny); default and
post-reclose state is island.

**Verified:** 58 tests (canary valid/non-admin/no-keyword/stale/wrong-recipient/
opaque; gate open-on-approve, deny-doesn't-open, replay rejected, manual close, **TTL
auto-reclose**). Live HTTP: mint → open (internet, +45m) → replay 403 → no-keyword 403
→ manual close → island; helper syntax-checked and rejects bad args.

## Phase G — admin surface + web UI + compile

**Files:** `web/index.html` (the SPA); `main.ts` gains the admin-token guard, the
admin friend routes, and SPA serving.

**What it does**
- Admin friendship management: `GET /admin/friends`, `DELETE /admin/friends/{id}`
  (revoke). **No create route exists** — admin can delete but never forge a
  friendship (POST 404s). The whole `/admin/*` surface (friends + gate routes) is
  gated by `requireAdmin` — an admin token compared constant-time (`x-admin-token`);
  open in `--mock`, fail-closed in prod if no token is set.
- `web/index.html` — one self-contained vanilla-JS SPA (no build step, no external
  assets): Home, Friends, Files, Messages, and an Admin console shown when the URL is
  `/admin`. Embedded into the binary via `import … with { type: "text" }` and served
  for any non-API GET, so `/admin` is just a URL and the compiled binary stays a
  single file.
- `bun build --compile --target=` emits all three: **bun-linux-arm64** (Pi),
  **bun-linux-x64** (sirius), **bun-darwin-arm64** (macs).

**Verified:** 58 tests; over HTTP — admin delete → 204, friends drop to 0, force
(`POST /admin/friends`) → 404; UI served at `/` and `/admin`; embedded UI served by
the **compiled standalone binary** (13 KB page); all three cross-targets build.

## Consolidated API surface (built so far)

```
GET    /api/health
GET    /api/friends
POST   /api/friends/token            giver: mint a token
POST   /api/friends/receive          receiver: record a pending request
POST   /api/friends/accept           receiver: accept -> accept blob
POST   /api/friends/confirm          giver: finalize
GET    /api/files                    FilesSnapshot
POST   /api/files                    multipart upload -> SharedFile (201)
GET    /api/files/{id}/download
DELETE /api/files/{id}               204
GET    /api/messages?peer=           thread (operator-only)
POST   /api/messages                 send (operator-only, delivers P2P)
POST   /api/messages/inbound         peer delivery (crypto-gated)
GET    /api/home                     dashboard (operator-only)
GET    /api/gate                     island-mode indicator
POST   /admin/canary                 open the gate (crypto-gated canary)
GET    /admin/gate/log               gate audit trail (operator)
POST   /admin/gate/close             early reclose (operator)
POST   /admin/canary/mint            --mock only: mint a canary for the demo
GET    /admin/friends                full friendship view (admin token)
DELETE /admin/friends/{id}           revoke a friendship (admin token; no create)
GET    /  /admin  (any non-API GET)  the embedded web UI
```

The app is feature-complete. Remaining: **Phase H** (migration + deploy) — git/ops,
not new app code.

## On-disk state

- **every node** (`ISLAND_DATA_DIR`, default `/var/lib/islandd`): `identity/`,
  `friends.json`, `messages.json` (+ `admin.token` later).
- **vega only:** `island.db` (the reused universal share) (+ `gate.log` later).

## Configuration (env)

`ISLAND_DATA_DIR`, `ISLAND_IDENTITY_DIR`, `ISLAND_LABEL`, `ISLAND_WG0`,
`ISLAND_PEER_PORT`, `ISLAND_SHARE` (`memory|sqlite|remote`), `ISLAND_DB_PATH`,
`ISLAND_SHARE_URL`. See [`island/README.md`](../../island/README.md).

## Run / test / demo

```bash
cd island
bun install
bun test                 # 41 pass
bun run typecheck        # tsc --noEmit, clean
bun run dev              # mock mode, http://127.0.0.1:8787  (no mesh needed)
bun run build            # -> self-contained ./islandd
```

## Deviations from the original plan (all intentional)

1. Friending needed **4 routes**, not 2 (giver must consume the accept).
2. `core/store.ts` folded into `RemoteFileShare` (`share.ts`).
3. Local state is two JSON files (`friends.json`, `messages.json`), not separate
   per-concern DBs / a message directory.

## Next

**Phase H — Migration & deploy** (git/ops, no new app code): snapshot the Phase One
app to `archive/phase-one-gui`, cut `feat/island-ts` off main, `git rm` the old
`gui/`/`gui-and-app/`, refresh the top-level README, and follow the deploy runbooks
(vega keeps `island.db`; polaris DB decommissioned; `island-gate` + llama-server on
vega). See [BUILD-PLAN.md](BUILD-PLAN.md) §2 Phase H and `island/deploy/`.

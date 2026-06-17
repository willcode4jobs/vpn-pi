# Phase Two — Build Plan (execution source of truth)

This is the **consolidated, actionable** plan: every decision from
[`08-open-questions.md`](08-open-questions.md) is now locked, and the work is broken
into ordered, shippable phases. Design rationale lives in `00`–`07`; this file is
the *what-to-build-next*. When a decision changes, update this file.

> Status: **Phase A complete** (in `island/`, verified). Phase B next. Build still
> on the working branch; `feat/island-ts` cut happens at migration (Phase H).
>
> **Build gotcha (carries to all phases):** `libsodium-wrappers`' ESM build has a
> broken relative import, so load it with a literal `require("libsodium-wrappers")`
> (see `src/core/sodium.ts`) — that works under `bun run` *and* lets
> `bun build --compile` embed it into a self-contained binary.

---

## 0. Locked decisions (answers from `08`)

| # | Decision | Impact |
|---|---|---|
| 1 | **One `islandd` process**, `/admin` = gated route superset | Single binary, shared `src/core/` |
| 2 | **"Singular file" = `bun build --compile`** self-contained exe w/ web UI bundled | No separate frontend deploy |
| 3 | **Universal file share = vega's existing SQLite DB, reused**; polaris DB deprecated | `core/share.ts` on vega keeps Phase One `files` schema |
| 3b | Share is **fully shared** among friended members; `node` column → **adder pubkey/label** | Read = any friend; write = any friend; attribution by identity |
| 4 | **Cross-compile** linux-arm64 / linux-x64 / darwin-arm64; **build-on-node fallback** OK | One `bun build --compile --target=…` per arch |
| 5 | **Go `daemon/` deferred** — will reintegrate after it's completed; leave as-is | Out of Phase Two scope |
| 6 | **Llama runs on vega** (16 GB Pi) | Canary LLM call is **local on vega** — no extra mesh hop |
| 7 | **Endpoint-anchored mesh** (vega bootstraps reachability, no app-layer relay) | wg `PersistentKeepalive`; no relay code |
| 8 | **Admin = a dedicated Ed25519 keypair** William will generate | Daemon loads admin **pubkey**; verifies canary signer ∈ {admin} |
| 9 | **Canary keyword = `GREEN18`** | First-token match in `core/canary.ts` |
| 10 | **Llama policy = approve open internet access** | Simple approve-on-valid-canary; the signed+sealed canary is the real gate (LLM is the UX/refusal layer) |
| 11 | **Gate open duration = 45 minutes** (fixed; also the hard cap) | `island-gate` arms a 45-min reclose timer |
| 12 | **Archive source ref = `feat/ids-mesh`** | Snapshot its `gui/` before deletion (verify it's present first) |

**vega's combined role (consequence of #3, #6, gate):** vega is the gate node *and*
file authority *and* Llama host. Everything privileged is co-located on the one
public 16 GB Pi; the canary path never leaves vega once received.

---

## 1. Target shape

```
islandd  (one Bun process, bound to wg0, on every node)
  /        user App   : friends, messages, files, home
  /admin   admin      : manage(delete) friends, canary gate   [admin-token guard]
  src/core : identity envelope friends store share gate canary sysinfo
  web/     : one static bundle (4 user views + admin), compiled into the binary
```

Per-node vs vega-only state — see [`05`](05-api-and-data.md#on-disk-state):
- every node: `identity/`, `admin.token`, `friends/pending/offered` db, `messages/`
- **vega only**: `island.db` (the reused universal share), `gate.log`

---

## 2. Build phases (ordered; each ends green: `bun test` + `tsc --noEmit`)

### Phase A — Scaffold + crypto core  ✅ DONE
*Verified: 11 `bun test` pass, `tsc --noEmit` clean, mock run serves `/api/health`,
`bun build --compile` produces a working self-contained binary.*
- `island/` tree: `package.json`, `tsconfig.json`, `src/`, `web/`, `test/`, `deploy/`.
- `core/identity.ts` — load Ed25519 + X25519 keypairs from `identity/` (never generate; William makes them). Ephemeral keys in tests.
- `core/envelope.ts` — sign-then-seal / open-then-verify via `libsodium-wrappers`.
  **Must** reproduce Phase One canonicalisation byte-for-byte (sorted keys, `,`/`:`,
  no whitespace, no floats) — port + verify against a Python-made fixture.
- `src/main.ts` — arg parse, `--mock`, bind wg0, `Bun.serve()` skeleton, route table.
- Tests: envelope round-trip, tamper reject, cross-language fixture verify.

### Phase B — Friending  ✅ DONE
*Verified: 24 `bun test` pass, `tsc` clean, and a live HTTP handshake between two
daemons yields mutual friends with replay rejected (400).*
- `core/friends.ts` — token give/accept, state machine (`offered/pending/friends`),
  one-sided revoke, expiry + single-use nonce, JSON persistence. **No create/force path exists.**
- Routes (the handshake needed 4, not 2 — the giver must also consume the accept):
  `GET /api/friends`, `POST /api/friends/token` (give), `POST /api/friends/receive`
  (record pending), `POST /api/friends/accept` (→ accept blob), `POST /api/friends/confirm`
  (giver finalizes). `main.ts` now boots an identity + persisted `FriendBook`.
- Tests: give→receive→accept→confirm = mutual; expiry; tamper; replay; one-time
  confirm; self-friend block; third-party can't open accept; opaque blob; revoke;
  serialize/restore; **assert no force API**.

### Phase C — Universal file share  ✅ DONE
*Verified: 35 `bun test` pass, `tsc` clean, full HTTP file API works (201/list/
download/204/404), and the RemoteFileShare proxy forwards correctly with vega
attributing the adder.*
- `core/share.ts` — `FileShare` interface + 3 impls mirroring Phase One exactly:
  `MemoryFileShare` (mock), `SqliteFileShare` (vega, **reuses the `files` schema** via
  `bun:sqlite`), `RemoteFileShare` (node→vega proxy). `buildShare()` selects by
  `ISLAND_SHARE` (memory|sqlite|remote), same as Phase One's `GUI_FILES`.
- API uses the **Phase One convention**: `GET /api/files` → `FilesSnapshot`,
  `POST /api/files` (multipart `file`) → `SharedFile` 201, `GET /api/files/{id}/download`,
  `DELETE /api/files/{id}` → 204.
- Access gated by friendship: caller's wg0 source IP → friend lookup (WireGuard pins
  IP↔key); loopback = local operator; `--mock` is open for the laptop demo. Adder
  `node` = the verified friend's Ed25519 pubkey (not the IP).
- Note: `core/store.ts` (a node's local-state wrapper) wasn't needed as a separate
  module — `RemoteFileShare` is the node→vega client, and local friend state already
  lives in `friends.json`. Folded in.
- Tests: add/list/get/remove + FileNotFound across Memory & SQLite; SQLite persists
  across reopen (vega's DB survives restart).

### Phase D — Messaging (P2P)  ✅ DONE
*Verified: 41 `bun test` pass, `tsc` clean, and a two-node HTTP conversation
delivers sealed both ways with garbage/non-friend inbound rejected (403).*
- `core/messages.ts` — `sealMessage`/`openMessage` (reuse the envelope) + `MessageBook`
  (append-only per-peer log, oldest-first thread, JSON persistence as `messages.json`).
- `FriendBook.verifyKeyResolver()` — sync verify-key lookup that resolves **friends only**,
  so a non-friend message fails closed.
- Routes: `GET /api/messages?peer=` (read thread), `POST /api/messages` (seal→store→
  deliver), both **operator-only** (loopback/mock); `POST /api/messages/inbound`
  (peer delivery, **crypto-gated** — sender must be a verified friend). Sender delivers
  straight to the friend's wg0 (`peerInbound`, `ISLAND_PEER_PORT`) — no hub.
- Tests: seal/open round-trip; non-friend rejected; third party can't open; opaque
  blob; resolver resolves only friends; MessageBook thread order + serialize.

### Phase E — Home / sysinfo  ✅ DONE (frontend deferred to G)
*Verified: 46 `bun test` pass, `tsc` clean, `/api/home` assembles gate + wg +
fail2ban + live pending requests over HTTP; `/api/gate` returns island.*
- `core/sysinfo.ts` — `readFail2ban` (journal Ban−Unban replay, **no sudo**, ported
  from `sources/fail2ban.py`, `JailStatus` shape) + `readWg` (`wg show <iface> dump`
  → peers, handshake age, up flag). Both degrade to empty; runners injected for tests;
  `--mock` returns synthetic data so Home demos on a laptop.
- Routes: `GET /api/home` (operator-only) → `{gate, wg, fail2ban, requests}` with wg
  peers enriched by friend label (via `friendByWg0`); `GET /api/gate` → island/internet
  (a default-island stub `ctx.gate`, replaced by the real gate in Phase F).
- Home view in `web/` deferred to Phase G (frontend bundle).

### Phase F — Gate + canary (vega)  ✅ DONE
*Verified: 58 `bun test` pass, `tsc` clean, full HTTP flow (mint→open→internet→
replay 403→no-keyword 403→close), helper syntax-checked + rejects bad args.*
- `core/canary.ts` — `makeCanary`/`verifyCanary`: `sign(admin Ed25519)` then
  `seal(→ vega X25519)` (envelope reuse); checks signer ∈ admin allowlist, `GREEN18`
  is the first token, freshness window. Replay (nonce) enforced by the gate.
- `core/gate.ts` — `Gate` state machine (default island) + `LlamaClient`
  (`MockLlama`/`LlamaHttp`, fail-safe deny) + `GateExec` (`NoopGateExec`/`ShellGateExec`).
  Approve → exec.open → **45-min** auto-reclose timer → log; deny/close paths logged.
- `deploy/island-gate` (root-owned helper, only `open`/`close`, real nft rules),
  `deploy/island-gate.sudoers` (pinned, no wildcards), `deploy/RUNBOOK-gate.md`
  (install + the 5 hard constraints). **Privilege model: pinned-helper** (William's call).
- Routes: `POST /admin/canary` (crypto-gated), `GET /admin/gate/log`,
  `POST /admin/gate/close` (early close), `GET /api/gate` (real state). `--mock`:
  `POST /admin/canary/mint` drives the whole flow on a laptop (MockLlama + NoopGateExec).
- Tests: canary valid/non-admin/no-keyword/stale/wrong-recipient/opaque; gate
  open-on-approve, deny-doesn't-open, replay, manual close, **TTL auto-reclose**.

### Phase G — Admin surface + frontend + compile  ✅ DONE
*Verified: 58 `bun test` pass, `tsc` clean, admin delete→204 + no-create→404 over
HTTP, UI served at `/` and `/admin`, embedded in the compiled binary, all three
cross-targets emit.*
- `/admin` routes: `GET /admin/friends`, `DELETE /admin/friends/{id}` (revoke; **no
  create** — POST 404s). `/admin/*` gated by an admin token (`requireAdmin`,
  constant-time; open in `--mock`, fail-closed in prod). Gate routes moved onto it.
- `web/index.html` — a single self-contained vanilla-JS SPA (Home, Friends, Files,
  Messages, + Admin when at `/admin`). Embedded into the binary via
  `import … with { type: "text" }`, served for any non-API GET — so `/admin` is just
  a URL, and `bun build --compile` stays one self-contained file.
- `bun build --compile --target=` **bun-linux-arm64 / bun-linux-x64 / bun-darwin-arm64**
  all emit (~99M/99M/62M). Laptop `--mock` runs the whole UI with no mesh (rubric).

### Phase H — Migration & deploy (git steps are yours to push)
1. Archive: snapshot `feat/ids-mesh`'s working `gui/` → branch `archive/phase-one-gui`
   (verify `gui/` is present in that ref first; `gui-and-app/` is the untracked backup).
2. `git switch -c feat/island-ts` off main; `git rm -r gui gui-and-app archive`; commit.
3. **Deploy (not git):** keep vega's running `island.db` (share reads same schema);
   **stop/decommission polaris's DB service**; install `islandd` + `island-gate` on vega.
4. Refresh top-level `README` + `island/README` so the SU495 rubric stays green.

---

## 3. Deferred / out of scope
- **Go `daemon/` reintegration** (Q5) — after the daemon itself is finished.
- Cross-node IDS aggregation (Phase One blind-relay) — Home shows *local* fail2ban only.

## 4. Needs William at build time
- The **admin Ed25519 keypair** (Q8) — hand over the **public** key; daemon loads it.
- Per-node identity keypairs generated on each host (project rule).
- Confirm `feat/ids-mesh` HEAD still contains a runnable `gui/` before the archive snapshot.

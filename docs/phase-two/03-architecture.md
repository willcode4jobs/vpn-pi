# 03 — Architecture: the TypeScript/Bun build

## One executable, two surfaces ("very similar and seamless")

The cleanest way to make the user backend and admin backend "very similar… and
seamless" is to make them **the same Bun process and the same data store**, with
the admin surface as a gated superset of routes:

```
  islandd  (single Bun process, bound to wg0 only — same boundary as Phase One)
  ├─ Bun.serve()  → one HTTP/1.1 server, route table
  ├─ /            → user App routes      (friends, messages, files, home)
  ├─ /admin       → admin routes         (manage friends, canary gate)
  │                 guarded by an admin token; identical code, extra scope
  ├─ src/core/    → shared modules (imported by both route groups)
  │   ├─ identity.ts   (Ed25519 + X25519 keypair, libsodium-wrappers)
  │   ├─ friends.ts    (token give/accept, store, revoke)        → [04]
  │   ├─ envelope.ts   (sign-then-seal / open-then-verify)       → [04]
  │   ├─ store.ts      (local node state; client to vega's share) → [05]
  │   ├─ share.ts      (vega only: the universal file-share DB)   → [05]
  │   ├─ gate.ts       (read gate state; on vega, request toggle)→ [06]
  │   ├─ canary.ts     (build/verify signed+sealed canary)       → [06]
  │   └─ sysinfo.ts    (fail2ban + wg status readers)            → [05]
  └─ web/         → one static HTML/JS/CSS bundle, served by the process
```

Why one process, not two: it makes "the two backends are very similar" true *by
construction* (they share every line of `src/core/`), removes a whole class of
drift/version-skew bugs, and means a node runs one service. The admin/user split
becomes an **authorization** concern (does this request carry a valid admin
token?) rather than a deployment concern. If you'd rather ship two physical
binaries from the same source, `bun build --compile` can emit a user build and an
admin build from one tree — a one-line change, noted in [08](08-open-questions.md).

## Runtime / dependency choices (for review)

| Concern | Recommendation | Why |
|---|---|---|
| Runtime | **Bun** | Single-binary `--compile`, built-in HTTP server + test runner + SQLite, fast. Removes the "ship a Node runtime to a Pi" problem. |
| Crypto | **libsodium-wrappers** | Same libsodium PyNaCl wrapped; gives Ed25519 sign + `crypto_box_seal` directly. Carries the Phase One model over byte-for-byte. |
| HTTP server | **`Bun.serve()` (built in)** | No framework, no vendoring. wg0-bound means no TLS needed (the tunnel is the crypto boundary) — just routing + static files. |
| JSON | **built-in `JSON`** | Wire format identical to Phase One; canonicalisation handled in `envelope.ts` (sorted keys, no whitespace) to match the Python bytes. |
| Universal file share | **reuse vega's existing SQLite DB** via `bun:sqlite` | One island-wide share, hosted on vega (file authority). polaris's Phase One DB server is deprecated. Keep the existing `files` schema so the data carries over. → [05] |
| Local node state | **`bun:sqlite`** (built in) or flat files | Per-node: friends/pending/offered + message logs. Separate from the shared file DB. |
| LLM | **llama.cpp** (separate process) reached over a local socket/HTTP | The daemon calls a local Llama; it does not embed inference. Keeps `islandd` small. |
| Lang/types | **TypeScript**, `bun test`, `tsc --noEmit` in CI | Type safety on the wire structs; Bun runs `.ts` directly, no build step in dev. |

> These are the **defaults I'd pick** with Bun, not decisions made for you. The ones
> that change the shape of the code are flagged in [08](08-open-questions.md).

## Process & privilege model

- `islandd` runs **unprivileged**, bound to `wg0` only (same as the Phase One GUI —
  the tunnel is the auth layer for the management plane).
- The one privileged action is the **egress toggle on vega** (editing nftables).
  That is *not* done by the Bun process. The gate module writes a verified, signed
  request to a tiny **`island-gate` helper** (a separate, audited unit with the
  narrow capability to flip exactly the egress ruleset, nothing else). The web
  process stays unprivileged; privilege is one small, reviewable hop. (A small
  shell/systemd helper is fine here — it doesn't need to be Bun.)
- Keys: per the project rule, **William generates real keypairs on each host**; the
  daemon only ever loads existing private keys and ships/consumes **public** keys.
  Tests use ephemeral throwaway keys.

## Mapping Phase One modules → Phase Two

| Phase One (Python) | Phase Two (TypeScript) | Change |
|---|---|---|
| `ids_crypto.py` (sign-then-seal) | `core/envelope.ts` | Same algorithm, libsodium via `libsodium-wrappers` |
| `peers.py` (wg0-IP allowlist) | `core/friends.ts` | Replaced: IP allowlist → friend graph |
| `relay.py` (hub blind relay) | — | Removed: no hub in a flat mesh |
| `db.py` `SqliteFileStore` (central share) | `core/share.ts` (vega) | **Reused** — same `files` schema, now authoritative on vega (was polaris) |
| `store.py` / `remote.py` (node's view) | `core/store.ts` | Node-side client to vega's share + local friend/message state |
| `sources/fail2ban.py`, host status | `core/sysinfo.ts` | Ported; local-only, shown on Home |
| `viewauth.py` | admin-token check | Folded into the `/admin` route guard |
| React frontend | `web/` static bundle | Slimmed to the four user views + admin |

> Note on "byte-compatibility": because envelopes carry signatures, the TS
> canonicalisation in `envelope.ts` must serialize JSON exactly like Phase One
> (sorted keys, `,`/`:` separators, no whitespace, no floats) so a signature made
> by the Python reference verifies in TS and vice-versa during migration.

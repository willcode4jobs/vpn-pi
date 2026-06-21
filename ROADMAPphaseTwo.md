# ROADMAP — start here

Orientation for any new session. This file is a **map to the sources of truth**,
not the truth itself — follow the links.

## Where the project is right now

**Phase Two refactor — build in progress (Phases A–G done — the whole app).** The Phase One
Python/React IDS GUI is being retired and rebuilt as a **TypeScript-on-Bun** app
in [`island/`](island/): a peer-to-peer WireGuard mesh "gated island internet" with
friending-based auth and an LLM-mediated internet gate.

- Working branch: `feat/ids-mesh` (Phase One `gui/` already staged for deletion).
- Target branch for the rebuild: `feat/island-ts` (created at migration, Phase H).
- Archive target for the old app: `archive/phase-one-gui` (created at Phase H).

### Build progress (see [`docs/phase-two/BUILD-PLAN.md`](docs/phase-two/BUILD-PLAN.md))

| Phase | What | Status |
|---|---|---|
| A | scaffold + crypto core (canonical, envelope, identity) | ✅ done |
| B | friending (token give/accept/confirm, state machine) | ✅ done |
| C | universal file share (vega SQLite, Phase One API) | ✅ done |
| D | messaging (P2P sealed) | ✅ done |
| E | home / sysinfo (fail2ban + wg status) | ✅ done |
| F | gate + canary (`GREEN18`, Llama, 45-min egress) | ✅ done |
| G | admin surface + frontend + compile | ✅ done |
| H | migration (archive → delete → branch) + deploy | ◻ |
| I | friend codes + polaris registry — [spec](docs/phase-two/FRIEND-CODES.md) | ✅ done |
| J | IDS / security — admin-only mesh feed (polaris collector) | ✅ done |

All built code lives in `island/`; **84 tests pass**, `tsc` clean. Nothing in git
has been moved, deleted, or pushed yet. (Headless add-ons since G: op-token + friend
CLI; user friend-remove + full-key view.) Friend codes: I-1 (compact codes), I-2 (ISL-… friend code), I-3 (registry), I-4 (friend-by-code), I-5 (deploy) done — Phase I complete.

## Sources of truth (in priority order)

| Source | What it is | Authority |
|---|---|---|
| [`newContextFile.md`](newContextFile.md) | The user's original Phase Two intent (raw) | **Intent** — the "why" |
| [`docs/phase-two/BUILD-PLAN.md`](docs/phase-two/BUILD-PLAN.md) | Locked decisions + ordered build phases | **Build truth** — the "what next" |
| [`docs/phase-two/PROGRESS.md`](docs/phase-two/PROGRESS.md) | Build log of what's actually been built (Phases A–G) | **Built truth** — the "what's done" |
| [`docs/phase-two/`](docs/phase-two/) | The Phase Two design skeleton, files `00`–`08` | **The plan** — the "what/how" |
| [`docs/phase-two/08-open-questions.md`](docs/phase-two/08-open-questions.md) | The 12 questions + William's answers (all resolved) | Decisions log |
| [`README.md`](README.md) | Phase One overview + how to run it | Phase One (being superseded) |
| [`CODE-MAP.md`](CODE-MAP.md) | Per-file map of the Phase One codebase | Phase One reference to port from |
| `gui-and-app/`, `gui/` | Phase One Python/React implementation | **Reference only** — to be archived |
| agent memory (`MEMORY.md` index) | Cross-session facts about nodes, prefs, decisions | Background context |

### The plan, file by file ([`docs/phase-two/`](docs/phase-two/))

Read [`00-README.md`](docs/phase-two/00-README.md) first; it indexes the rest:
`01` scope/goals · `02` topology · `03` architecture · `04` friending protocol ·
`05` API & data · `06` canary gate · `07` migration & build · `08` open questions.

## Decisions already locked (don't relitigate without the user)

- **Language: TypeScript on Bun.** (C and Go were considered and set aside.) → `03`
- **Mesh: flat peer-to-peer, no hub *relay*.** → `02`
- **Auth: mutual friending** (token give→accept); admin can delete but never forge. → `04`
- **Universal file share = vega's existing SQLite DB, reused.** polaris's DB server
  is **deprecated**. (A hosted service on vega, not a traffic relay.) → `02`, `05`
- **Gate: default closed (island mode);** a signed+sealed **`GREEN18`** canary,
  interpreted by **Llama on vega**, opens vega's egress for **45 min** then auto-recloses. → `06`
- **Crypto carried over: Ed25519 sign + X25519 seal** via `libsodium-wrappers`,
  byte-compatible with Phase One's `ids_crypto.py`. → `04`
- **vega = gate + file authority + Llama host** (the 16 GB Pi); canary stays local on vega.
- **File share: fully shared** among friended members; `node` column = adder pubkey/label.
- **Mesh bootstrap: endpoint-anchored** (vega anchors reachability; no app-layer relay). → `02`
- **Admin = a dedicated Ed25519 key** William generates; daemon loads its pubkey.
- **Single binary** via `bun build --compile`; cross-compile per arch, build-on-node fallback.

## All open questions answered

The 12 questions in [`08-open-questions.md`](docs/phase-two/08-open-questions.md) are
**resolved** (answers inline there). They're consolidated into the execution plan:

> 👉 **[`docs/phase-two/BUILD-PLAN.md`](docs/phase-two/BUILD-PLAN.md) — the build source of truth.**

Cross-node IDS is DONE (Phase J), including the **wg-selfheal daemon**: it logs JSON to
journald and islandd reads `journalctl -u wg-selfheal` → self-heal events in the feed.
The daemon runs as its own per-node service (`daemon/RUNBOOK.md`); its interface-bounce
remediation is still unwired (privilege gap, per the daemon). Build branch
`feat/island-ts` not yet created.

## Conventions for working here

- Don't `git push` — William does that ([memory: william-handles-git-push]).
- Don't generate real keypairs/secrets — William makes them on hosts; use ephemeral
  keys in tests ([memory: william-owns-key-generation]).
- Prefer runbooks over SSHing into nodes ([memory: prefers-runbooks-over-remote-exec]).
- Project must keep satisfying the SU495 rubric (separate-machine run, clear README,
  folders, comments, public repo).

> **Maintenance:** when a decision in `docs/phase-two/` changes or an open question
> is resolved, update both that doc **and** the "locked / open" lists above so this
> file stays an accurate map.

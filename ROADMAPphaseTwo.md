# ROADMAP — start here

Orientation for any new session. This file is a **map to the sources of truth**,
not the truth itself — follow the links.

## Where the project is right now

**Phase Two refactor — planning stage, nothing executed.** The Phase One
Python/React IDS GUI is being retired and rebuilt as a **TypeScript-on-Bun** app:
a peer-to-peer WireGuard mesh "gated island internet" with friending-based auth and
an LLM-mediated internet gate. The plan is written and under review; no files have
been moved, deleted, or pushed yet.

- Working branch: `feat/ids-mesh` (Phase One `gui/` already staged for deletion).
- Target branch for the rebuild: `feat/island-ts` (not yet created).
- Archive target for the old app: `archive/phase-one-gui` (not yet created).

## Sources of truth (in priority order)

| Source | What it is | Authority |
|---|---|---|
| [`newContextFile.md`](newContextFile.md) | The user's original Phase Two intent (raw) | **Intent** — the "why" |
| [`docs/phase-two/`](docs/phase-two/) | The Phase Two design skeleton, files `00`–`08` | **The plan** — the "what/how" |
| [`docs/phase-two/08-open-questions.md`](docs/phase-two/08-open-questions.md) | Decisions still owned by William | **Open items** |
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
- **Gate: default closed (island mode);** a signed+sealed **canary** keyword,
  interpreted by a local **Llama**, opens vega's egress time-boxed. → `06`
- **Crypto carried over: Ed25519 sign + X25519 seal** via `libsodium-wrappers`,
  byte-compatible with Phase One's `ids_crypto.py`. → `04`

## Still open (need the user) — see [`08`](docs/phase-two/08-open-questions.md)

- **Q12 (blocks archive):** which ref holds the last-good Python app to snapshot.
- **Q3b:** is the file share fully-shared or per-friend-pair; `node` column identity.
- Canary specifics: keyword, Llama approval policy, max open duration.
- NAT-traversal stance; which node runs Llama; admin-key identity.

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

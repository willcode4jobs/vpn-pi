# islandd — Phase Two node daemon

One TypeScript/Bun binary per node. It serves the **user app** (`/`) and the
**admin** surface (`/admin`) from the same process, over the WireGuard mesh. See
the design in [`../docs/phase-two/`](../docs/phase-two/) and the build sequence in
[`../docs/phase-two/BUILD-PLAN.md`](../docs/phase-two/BUILD-PLAN.md).

> **Status: feature-complete (Phases A–G).** Crypto core, friending
> (token give/accept/confirm), the universal file share (vega's reused SQLite DB,
> Phase One API), direct P2P sealed messaging, the Home/sysinfo API, the canary
> internet gate (`GREEN18` → Llama → 45-min egress), and the admin surface + embedded
> web UI. Open it at `/` (user app) or `/admin` (admin console). What's left is
> migration + deploy (Phase H), which is git/ops, not app code.

## Run it

```bash
cd island
bun install
bun run dev        # mock mode on http://127.0.0.1:8787  (no mesh needed)
curl 127.0.0.1:8787/api/health
```

In mock mode you can exercise the whole API on one machine: issue a friend token
(`POST /api/friends/token`), and upload/list/download files (`/api/files`).

## Develop

```bash
bun test           # unit tests
bun run typecheck  # tsc --noEmit
bun run build      # -> single self-contained executable ./islandd
```

## Layout

| Path | What |
|---|---|
| `src/main.ts` | daemon entry — arg parse, bind, route table (api + /admin + serves the web UI) |
| `src/core/` | `sodium`, `codec`, `canonical`, `envelope`, `identity`, `friends`, `share`, `messages`, `sysinfo`, `canary`, `gate` (more per phase) |
| `test/` | `bun test` suites — canonical, envelope, identity, friends, share, messages, sysinfo, canary, gate |
| `web/index.html` | single-file vanilla-JS SPA (Home/Friends/Files/Messages/Admin), embedded into the binary |
| `deploy/` | `island-gate` helper + sudoers + `RUNBOOK-gate.md` (the gate privilege model) |

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `ISLAND_DATA_DIR` | `/var/lib/islandd` | identity + `friends.json` location |
| `ISLAND_IDENTITY_DIR` | `<data>/identity` | where the node's keypairs are loaded from |
| `ISLAND_LABEL` / `ISLAND_WG0` | — | this node's display label / wg0 address |
| `ISLAND_PEER_PORT` | server port | port used to reach friends' `/api/messages/inbound` over wg0 |
| `ISLAND_WG_IFACE` | `wg0` | WireGuard interface read for Home connectivity |
| `ISLAND_SHARE` | `memory` | file share: `memory` \| `sqlite` (vega) \| `remote` |
| `ISLAND_DB_PATH` | `<data>/island.db` | SQLite share path (when `sqlite`) |
| `ISLAND_SHARE_URL` | — | vega's base URL (when `remote`) |
| `ISLAND_ADMIN_PUBKEY` | — | allowlisted admin Ed25519 pubkey(s), comma-sep (gate) |
| `ISLAND_LLAMA_URL` | `127.0.0.1:8080` | llama.cpp server for the gate decision |
| `ISLAND_GATE_CMD` | `sudo /usr/local/sbin/island-gate` | the pinned egress helper |
| `ISLAND_GATE_TTL` | `2700` | gate open duration (seconds; 45 min) |
| `ISLAND_CANARY_KEYWORD` | `GREEN18` | the canary keyword (first token) |
| `ISLAND_ADMIN_TOKEN` | — | gates the /admin surface (required in prod; open in --mock) |

## Notes

- **Keys are loaded, never generated** by the daemon in production: William creates
  each host's keypairs; `loadIdentity()` reads them. The `generate`/`save` helpers
  are for `--mock` and tests only.
- The envelope wire format is byte-compatible with Phase One's Python
  `ids_crypto.py`, so signatures verify across the migration.

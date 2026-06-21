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
| `src/cli.ts` | friend CLI for headless/SSH nodes (talks to the daemon) |
| `src/core/` | `auth`, `sodium`, `codec`, `canonical`, `envelope`, `identity`, `friends`, `share`, `messages`, `sysinfo`, `canary`, `gate`, `registry`, `events` (more per phase) |
| `test/` | `bun test` suites — canonical, envelope, identity, friends, share, messages, sysinfo, canary, gate |
| `web/index.html` | single-file vanilla-JS SPA (Home/Friends/Files/Messages/Admin), embedded into the binary |
| `deploy/` | `install.sh` (one-command service install), `islandd.service` + `islandd.env.example`, `island-gate` + sudoers, `push.sh` (rsync deploy), `RUNBOOK-deploy.md` / `RUNBOOK-gate.md` |

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `ISLAND_DATA_DIR` | `~/.islandd` | identity + tokens + data (auto-created on first run) |
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
| `ISLAND_REGISTRY` / `ISLAND_EVENTS` | — | polaris: serve the friend-code directory / collect the IDS feed |
| `ISLAND_REGISTRY_URL` / `ISLAND_EVENTS_URL` | — | other nodes: where to announce codes / report security events (polaris) |
| `ISLAND_ADMIN_TOKEN` | auto | admin password (gates /admin + remote mgmt); auto-generated + printed if unset |
| `ISLAND_OP_TOKEN` | — | operator token -- lets a headless node be managed over the mesh / by the CLI |
| `ISLAND_ADDR` | `http://127.0.0.1:8787` | (CLI only) which daemon the `islandd friend` commands talk to |

## Headless nodes (a Pi over SSH)

A node needs no local display — the UI is served on wg0, so manage it two ways:

- **Remote browser:** open `http://<node-wg0>:8787/admin` from any device on the mesh,
  click the 🔒 lock, and enter the node's admin token (printed on first run) to manage it.
- **CLI over SSH** (no browser):

  ```bash
  islandd friend invite                 # prints an invite to hand to a friend
  islandd friend accept '<their token>' # connects; prints a reply to send back
  islandd friend confirm '<reply>'      # finishes a friendship you invited
  islandd friend list
  ```

  The CLI talks to the running daemon (`ISLAND_ADDR`, default loopback). For a
  wg0-bound daemon, point it at the node with the operator token:
  `ISLAND_ADDR=http://10.42.0.6:8787 ISLAND_OP_TOKEN=… islandd friend list`.

Friend management is **operator-only** (loopback, `--mock`, or a valid
`ISLAND_OP_TOKEN`) — a mesh peer can't touch your friend book.

## Notes

- **Zero-config first run:** a real node auto-creates its data dir (`~/.islandd`),
  its identity keypairs, and a strong **admin token** (printed + saved to
  `<data>/admin.token`). Pre-make keys with `islandd keygen`, or set
  `ISLAND_ADMIN_TOKEN`, only if you want known values.
- **Remote admin stays token-gated** (rate-limited); the embedded UI / client-side
  checks are cosmetic — every admin/operator action is enforced server-side.
- The envelope wire format is byte-compatible with Phase One's Python
  `ids_crypto.py`, so signatures verify across the migration.

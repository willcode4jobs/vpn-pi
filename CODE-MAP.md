# CODE-MAP.md — what each code file does

A reference map of the runnable/code files in the SU495 WireGuard mesh VPN project: the IDS GUI (FastAPI backend + React frontend), the deployment/hardening scripts, WireGuard templates, and the archived phase-2 prototype. The code catalogue is followed by an index of the **operational runbooks** (deploy/incident procedures). Pure design/planning prose (`docs/ids-planning/`, worklogs, `CLAUDE.md`) is out of scope here.

> Generated 2026-06-09. Descriptions reflect the files as read on `feat/ids-mesh`.

---

## Big picture

```
gui/
  backend/   FastAPI app — file-share API + host-security IDS feed + blind-relay alert mesh
  frontend/  React + Vite ops-console UI (file sharing + per-node IDS, master aggregate view)
  deploy/    build/ship script, systemd unit, key-generation, runbooks
pi-deployment/   node hardening + firewall scripts
docs/wg-templates/   WireGuard hub/spoke config templates + topology walkthrough
archive/phase2-vpn-exit-node/   superseded single-exit-node prototype (hardening + configs)
```

The IDS alert path is **sign-then-seal over a blind relay**: each node signs an alert (Ed25519) then seals it to the master's public key (X25519/SealedBox). Nodes ship sealed blobs to a hub relay buffer that never decrypts; the master drains the buffer, decrypts, verifies signatures, and aggregates. The file share is centralized on one SQLite authority; other nodes proxy to it over wg0. (The code/docstrings name **polaris** as the authority, but operationally the store was moved to **vega**, the wg hub — see the runbook index below.)

---

## Backend — `gui/backend/`

FastAPI service. Binds loopback/wg0 only (never `0.0.0.0`). stdlib + FastAPI + PyNaCl only.

### gui/backend/requirements.txt
Runtime deps: FastAPI 0.115.6, uvicorn (standard extras), python-multipart (form/upload parsing), PyNaCl 1.5.0 (Ed25519 sign + X25519 SealedBox for the IDS envelope).

### gui/backend/app/__init__.py
Empty package marker.

### gui/backend/app/main.py
The FastAPI application. Wires together the file store, data source, view-auth gate, and relay; serves the built frontend. HTTP endpoints:
- `POST /api/login` — exchange the view-password for a session bearer token
- `GET /api/node` — node identity (name, role, wg interface)
- `GET /api/files` — file-share listing
- `POST /api/files` — upload a file (201)
- `GET /api/files/{file_id}/download` — stream a file
- `DELETE /api/files/{file_id}` — remove a file
- `GET /api/ids` — host-security event feed
- `GET /api/jails` — fail2ban jail status
- `POST /api/ids/relay` — hub deposits sealed alert blobs
- `GET /api/ids/relay` — master drains queued blobs (`?since=<id>`)
- `GET /api/health` — liveness probe

### gui/backend/app/models.py
Pydantic wire models: `NodeIdentity`, `SharedFile`, `FilesSnapshot`, `IdsEvent`, `JailStatus`, plus enums `IdsSource` (USB/LOGIN/AUTH/REBOOT) and `IdsSeverity` (info/warn/crit).

### gui/backend/app/peers.py
wg0 peer allowlist. Authenticates requests by source IP and returns the caller's wg0 address as a stable cryptographic identity (used for file-adder attribution). Defaults to 10.42.0.1–10.42.0.7; overridable via `GUI_PEERS`.

### gui/backend/app/store.py
File-store seam. Defines the `FileStore` protocol and selects an implementation via `GUI_FILES`: `PlaceholderFileStore` (in-memory, builder PC), `SqliteFileStore` (durable, polaris), or `RemoteFileStore` (node's view of polaris). `build_store()` is the factory; default is placeholder.

### gui/backend/app/db.py
`SqliteFileStore` — the durable file authority that runs on polaris. Persists uploads (name, size, node, content_type, BLOB) in a `files` table, opening fresh per-call connections. Implements list/add/get/delete.

### gui/backend/app/remote.py
`RemoteFileStore` — forwards file ops to polaris's `/api/files` over HTTP/wg0 (multipart for upload). Used by every non-polaris node via `GUI_FILES=remote`. stdlib `urllib` only.

### gui/backend/app/ids_crypto.py
IDS envelope crypto: `seal_sign()` (node signs the payload Ed25519, then seals it to the master's X25519 key — opaque to the hub) and `open_verify()` (master decrypts, parses, verifies signature, fail-closed). The signature lives *inside* the sealed box so the relay stays blind.

### gui/backend/app/ids_registry.py
Master's Ed25519 verify-key registry. Loads `node=base64-key` lines from `GUI_IDS_REGISTRY`. Empty registry trusts nobody (secure by default); unknown signers rejected fail-closed; revocation = delete line + restart.

### gui/backend/app/ids_shipper.py
Node-side outbound shipper. Daemon thread that periodically reads the local data source, finds unsent events, seals+signs each, and POSTs to the hub relay. Per-node monotonic sequence numbers persisted across restarts; already-shipped events tracked by id. stdlib `urllib` only.

### gui/backend/app/relay.py
Hub relay buffer — the "blind drop box." Stores deposited base64 ciphertext verbatim in SQLite with an append-only monotonic id; master pulls with `?since=<id>` for at-least-once delivery. Bounded ring (~5000 rows, oldest evicted). Never decrypts — that is the point.

### gui/backend/app/viewauth.py
View-password gate for the master's browser-facing reads (human auth layered on top of node peer auth). In-memory tokens with TTL (default 12h), pruned on issue. `POST /api/login` mints a bearer token; `require_view` dependency enforces it. No-op when no password configured; otherwise fail-closed (401).

### Backend data sources — `gui/backend/app/sources/`

### gui/backend/app/sources/__init__.py
Subpackage exports: `DataSource` protocol, `MockDataSource`, `build_data_source()`.

### gui/backend/app/sources/base.py
`DataSource` protocol — the small interface every source satisfies: `node()` → `NodeIdentity`, `ids(limit)` → newest-first `IdsEvent` list.

### gui/backend/app/sources/factory.py
`build_data_source()` selects from `GUI_IDS`: `mock` (default, synthetic), `host` (real per-node journald feed), `mesh` (master aggregator). Local imports keep non-default backends off the placeholder path.

### gui/backend/app/sources/mock.py
`MockDataSource` — synthetic, time-advancing feed for dev. Fixed seed events (USB insert, auth ban, login, reboot, login), real per-node identity via `GUI_NODE_NAME`.

### gui/backend/app/sources/host.py
`HostDataSource` — real per-node IDS feed from `journalctl -o json`. Maps fail2ban bans, sshd logins/bruteforce, udev USB inserts, and kernel reboots to `IdsEvent`s. Degrades to empty on any read failure (never crashes the API).

### gui/backend/app/sources/journal.py
Shared journald access: `run()` shells `journalctl --no-pager`, `parse()` decodes line-delimited `-o json`, `message()` normalizes the string-or-list MESSAGE field. Degrades to empty on missing binary / permission / timeout. Used by host + fail2ban sources.

### gui/backend/app/sources/fail2ban.py
`Fail2banSource` — live jail status reconstructed from journal Ban/Unban events (reads journalctl, no `fail2ban-client`, no privilege elevation). Derives current state per (jail, ip); cached ~3s to avoid spawning journalctl on every UI poll.

### gui/backend/app/sources/mesh.py
`MeshDataSource` — master-side aggregator. Pulls sealed blobs from the hub relay, decrypts/verifies each, dedupes by (node, seq), merges with the master's local feed, returns newest-first. Attribution comes from the verified signature; bad/unknown/tampered blobs dropped fail-closed. In-memory cache (~3000 rows), cursor advanced per pull.

### gui/backend/app/sources/cache.py
`TTLCache` — thread-safe one-slot memoization for expensive reads (journalctl polls), shared across the FastAPI threadpool and the shipper thread. Stamp taken at completion so blocking callers get a fresh result.

### Backend tests — `gui/backend/tests/`

### gui/backend/tests/test_store.py
`PlaceholderFileStore` + `build_store()` factory: both stores honor the same `FileStore` contract; factory defaults to placeholder, switches to sqlite/remote via env.

### gui/backend/tests/test_file_store.py
`SqliteFileStore` against temp DBs: add/list/get/delete, newest-first ordering, seeding, not-found handling.

### gui/backend/tests/test_host_source.py
`HostDataSource` journald → IDS event mapping: locks sensor→severity/subject mapping, bruteforce dedup per IP, graceful empty-on-failure.

### gui/backend/tests/test_fail2ban.py
`Fail2banSource`: derives jail state from ban/unban journal events (last action wins), splits by jail, empty on read failure.

### gui/backend/tests/test_mock_source.py
`MockDataSource`: identity defaults to "polaris", respects `GUI_NODE_NAME`, events newest-first.

### gui/backend/tests/test_ids_crypto.py
Sign-then-seal envelope: only the master key decrypts; registered signer verifies; tamper / wrong signer / unknown node all reject closed.

### gui/backend/tests/test_ids_shipper.py
`Shipper`: failed POSTs don't consume sequence numbers, state persists across restarts, shipped blobs decrypt+verify.

### gui/backend/tests/test_relay.py
`RelayBuffer`: deposit/drain with cursor, incremental pulls, bounded eviction (newest kept), ciphertext stored verbatim (never decrypted).

### gui/backend/tests/test_mesh_source.py
`MeshDataSource`: pull→decrypt→verify→dedup by (node, seq)→merge with local; unknown/tampered dropped; cache bounded.

### gui/backend/tests/test_viewauth.py
View-auth: no-op when `GUI_VIEW_PASSWORD` unset; fail-closed when set — bearer tokens issued, expire, and are evicted; wrong/expired → 401.

---

## Frontend — `gui/frontend/`

React 18 + TypeScript + Vite. Built to a static bundle that the backend serves. Ops-console aesthetic (monospace, near-black, severity color rails).

### gui/frontend/index.html
Entry HTML. `<div id="root">`, loads IBM Plex Mono, references `main.tsx`. Title "polaris · island".

### gui/frontend/package.json
`su495-island-gui` v0.2.0-skeleton. React 18 + Vite; dev/build/preview scripts; TS + React DOM types.

### gui/frontend/tsconfig.json
TS config: ES2022 target, strict null checks, JSX react mode, no-unused warnings; includes `src` + `vite.config.ts`.

### gui/frontend/vite.config.ts
Vite config: builds to `../backend/static` (so FastAPI serves it); dev-time `/api` proxy to local FastAPI at :8787 for single-origin in the browser.

### gui/frontend/src/main.tsx
React entry — renders `App` in StrictMode into `#root`, imports `styles.css`.

### gui/frontend/src/App.tsx
Root component. Polls four endpoints (node, files, IDS, jails); shows the login gate on 401, an alarm banner on signal loss, and the three panels (Files, JailsPanel, IdsFeed) plus StatusBar + footer. Scope is file sharing + host-security IDS only (no mesh health).

### gui/frontend/src/api.ts
API client. Polling hooks (`useNode`, `useFiles`, `useIds`, `useJails`) and mutations (`login`, `uploadFile`, `deleteFile`) with bearer-token management in sessionStorage. `Poll<T>` interface tracks staleness, auth failure, last-success time.

### gui/frontend/src/format.ts
Formatting helpers: `age()` (compact relative time "3m04s"), `clock()` (HH:MM:SS), `bytes()` (compact units "18.4M").

### gui/frontend/src/types.ts
TS interfaces mirroring backend models: `NodeIdentity`, `SharedFile`, `FilesSnapshot`, `IdsEvent`, `JailStatus`.

### gui/frontend/src/styles.css
Ops-console stylesheet — warm near-black palette, IBM Plex Mono, dense grid, severity color rails (green/orange/red), subtle scanlines. Covers status bar, panels, tables, login gate, upload, IDS feed (expandable rows), jails.

### gui/frontend/src/components/Files.tsx
Island file-share panel (polaris SQLite store). Header shows root path + wg bind addr; upload control with error messaging; table of files with download/delete per row; `refetch()` immediately after upload/delete.

### gui/frontend/src/components/IdsFeed.tsx
IDS event table with severity coloring. Shows 5 newest by default + "SHOW ALL" toggle; rows expand to full message; header tally chips count crit/warn.

### gui/frontend/src/components/JailsPanel.tsx
Live fail2ban jail state for **this node** (not mesh-aggregated). Compact table of banned IPs / total bans / jail name; red when any banned, green when clear.

### gui/frontend/src/components/LoginGate.tsx
Full-screen password overlay shown on 401. Password form → on success stores bearer token in sessionStorage and triggers refetch via `onAuthed`.

### gui/frontend/src/components/Readout.tsx
Reusable "awaiting first read → empty → render" wrapper. Takes a `Poll<T[]>` + render fn; used by Files/Jails/IdsFeed.

### gui/frontend/src/components/StatusBar.tsx
Masthead — node name, wg interface, role (spoke/relay), link state (LIVE pulse vs SIGNAL LOST), last-success timestamp. First visual cue when the backend goes silent.

### gui/frontend/src/package-lock.json
npm lockfile (not catalogued).

---

## Deployment — `gui/deploy/`

### gui/deploy/push-gui.sh
Build-and-ship. Compiles the frontend on the Mac (tsc + vite), rsyncs the static bundle to nodes over ssh/wg0. Keeps npm/node off the hardened Pis; each node runs its own Python backend (deployed via git pull), SQLite mode on polaris / remote mode elsewhere.

### gui/deploy/su495-gui.service
systemd unit for the polaris backend (SQLite authority). uvicorn on 127.0.0.1:8787 (loopback only until app auth exists); hardened (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only`), `/var/lib/vpn-pi` mounted rw for the DB; restart-on-failure.

### gui/deploy/ids-keygen.py
Key-gen for the blind-relay layer (PyNaCl). On master (polaris): generates the X25519 keypair, writes private 0600, prints public for distribution. On a sensor node: generates the Ed25519 signing key, prints the verify key for the master's registry. No network, no auto-registration — distribution is manual via runbook.

---

## Node provisioning — `pi-deployment/`

### pi-deployment/harden-base.sh
The baseline hardening bootstrap for every mesh node (idempotent). Installs nftables/fail2ban/unattended-upgrades/wireguard; SSH key-only + no root; default-deny nftables (loopback, established, SSH, ICMP only); fail2ban sshd jail (maxretry 5, bantime 1h). Defers WG port + tunnel config to per-node steps.

### pi-deployment/open-gui-port.sh
Follow-on script that opens tcp/8787 in nftables, scoped to 10.42.0.0/24 (wg subnet). Creates `nft-gui-port.service` (systemd oneshot) to re-assert the rule on boot after nftables loads, and an idempotent apply helper that survives `harden-base.sh` reruns (which flush the rule). The firewall source scope is the only access control until app-level auth lands.

> WireGuard templates moved out of `pi-deployment/` to `docs/wg-templates/` — they're illustrative reference, not run by any script. See the next section.

---

## WireGuard config templates — `docs/wg-templates/`

Reference `wg0.conf` configs for the hub-and-spoke island, dual-stack (IPv4 `10.42.0.0/24` + IPv6 ULA `fd49:2977:3d2f::/64`). Keys are `KEY`/`<placeholder>` — generated on-host, never committed (`.gitignore` blocks real `*.conf`/private keys). Replaced the original empty `control-plane`/`data-plane`/`mesh-p2p` `.conf.tmpl` stubs (a full-mesh framing that didn't match the hub-and-spoke reality).

### docs/wg-templates/wireguard-topology.md
The annotated walkthrough: ASCII topology, the key-distribution table (hub knows every spoke's pubkey; each spoke knows only vega's), and why polaris (master) is a spoke not the hub. The teaching doc behind the two templates.

### docs/wg-templates/hub-wireguard.md
vega's config — dual-stack `[Interface]`, `PostUp = nft -f /etc/wireguard/mesh.nft` (rules in a separate nft file), and one `[Peer]` per node: polaris (static LAN endpoint `192.168.1.72`), cellphone (.3), altair (.4), sirius (.5), builder (.6).

### docs/wg-templates/spoke-wireguard.md
A spoke's config (polaris's side shown) — dual-stack `[Interface]` and a single `[Peer]` for vega (LAN endpoint `192.168.1.73` + `PersistentKeepalive=25`).

### docs/wg-templates/wireguardREADME.md
Short rationale note (William's voice) on hub-and-spoke vs peer-to-peer — tighter security at the cost of modularity, and the "if I could do it again, p2p" reflection.

---

## Archive — `archive/phase2-vpn-exit-node/` (superseded single-exit-node prototype)

### archive/phase2-vpn-exit-node/scripts/harden-base.sh
Earlier hardening bootstrap (Ubuntu 24.04 / Pi OS Lite). Updates packages, installs nftables/fail2ban/unattended-upgrades/curl/vim, deploys hardened sshd_config + nftables baseline + fail2ban config **from separate files** (vs. the current embedded version), enables auto security upgrades, runs a lynis audit.

### archive/phase2-vpn-exit-node/configs/fail2ban/jail.local
fail2ban overrides: sshd jail on, maxretry 3, findtime 10m, bantime 1h, systemd backend, nftables ban action (not iptables), trusts host's own addresses.

### archive/phase2-vpn-exit-node/configs/nftables/baseline.nft
Default-deny nftables ruleset: drop inbound except loopback / established-related / ICMP (incl. IPv6 ND) / SSH; forward chain drop-by-default with comments noting phase-3 WG UDP + NAT egress. Has a placeholder to scope SSH to a LAN subnet.

### archive/phase2-vpn-exit-node/configs/nftables/nftables.conf
Minimal table/chain stubs, no filter rules — placeholder before `baseline.nft` is loaded.

### archive/phase2-vpn-exit-node/configs/sshd/sshd_config.hardened
Hardened sshd: key-only (no passwords, no root), single user `billyuser`, MaxAuthTries 3, LoginGraceTime 30, idle timeout (ClientAliveInterval 300 / CountMax 2), no X11/agent/TCP forwarding. Self-contained (no distro drop-ins).

---

## Runbooks & operational docs

Procedures, not code — how the system is deployed, onboarded, and recovered. The
file authority lives on **vega** (the wg hub, `10.42.0.2`); polaris is the
control-plane **master** and stays out of the data path. Read order for a fresh
deploy: **implementation → onboard → (ids-nodes | sirius)**.

Three migration-era runbooks were removed on 2026-06-09 as superseded: the
polaris-as-file-authority deploy (`RUNBOOK.md`), the one-time polaris→vega store
move (`RUNBOOK-vega-migrate.md`), and the first-light spine proof
(`RUNBOOK-ids-live-test.md` — its completion is recorded in
`docs/ids-planning/BUILD-STATUS.md`).

### gui/deploy/RUNBOOK-implementation.md
**The orchestration layer.** Takes you from `feat/ids-mesh` committed on the Mac to the full IDS GUI live on vega (hub+sensor+relay) and polaris (master), with the endpoint path. Covers the two deploy channels (backend via git, frontend via `push-gui.sh`), roles/addresses table, key exchange, env blocks, the view-password, and the "gotchas in one place." Start here.

### gui/deploy/RUNBOOK-onboard.md
**One-screen quickstart** to bring any node into the IDS GUI — pick role (hub/master/sensor), run the blocks. Condenses `RUNBOOK-implementation.md` to the happy path: code + journal access, keys, env, UI bundle, restart/verify, plus the five things that bite.

### gui/deploy/RUNBOOK-ids-nodes.md
**Canonical per-node IDS reference.** Deep detail for the blind-relay layer: role→config matrix, venv (py3.12 on sirius), deploy location, journal-group access, keys, the per-role systemd env block, firewall note, and the full **SELinux** section (§8: relabel + audit2allow policy module) for enforcing nodes.

### gui/deploy/RUNBOOK-sirius.md
**Ground-up sirius** (x86 Linux, SELinux enforcing). Self-contained: read-only deploy key, clone to `/opt` (the SELinux fix — services can't exec from `/home`), py3.12 venv, the SELinux labeling/port/policy steps, the endpoint systemd unit (file-forward + IDS sensor, loopback bind), sensor prereqs, frontend bundle to `/opt`, verify, troubleshooting. The actively-worked endpoint deploy.

### gui/deploy/RUNBOOK-endpoints.md
**sirius + altair onboarding.** Part A points at the sirius sensor path; Part B is the unique bit — **altair is a macOS *viewer*, not a sensor** (no journalctl/fail2ban on macOS), so it just joins wg via the WireGuard app and browses the GUI other nodes serve.

### gui/deploy/NFTABLES-gui-port.md
**Why/how the GUI port (8787) is opened**, and the access-control model: the upload/delete API is unauthenticated, so the nftables *source scope* (`iifname "wg0"` ≫ explicit IPs ≫ subnet) is the only control. Explains runtime-vs-persistent rules and the `harden-base.sh` flush trap that `open-gui-port.sh` / `nft-gui-port.service` work around.

### gui/deploy/sirius-selinux-blackscreen.md
**Incident post-mortem** (2026-06-07): global `setenforce 0` → enforcing black-screened sirius's desktop. Root cause, how to confirm it's SELinux (GRUB `enforcing=0` boot), the permanent fix (`fixfiles -F onboot && reboot`), and the lesson now baked into `RUNBOOK-sirius.md §3c` — scope permissive to the service domain, never global.

### docs/runbooks/external-reachability.md
**Command reference** for diagnosing external WireGuard reachability through Fios port forwarding (wg state, nftables inspection, tcpdump, test listeners, and probes from a cellular Surface / LAN). A diagnostic cookbook, not a step-by-step procedure.

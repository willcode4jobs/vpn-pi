# RUNBOOK — deploying islandd

The single front door for deployment: **try it → run one node → roll out the whole
mesh.** vega's internet gate has its own deep doc: [RUNBOOK-gate.md](RUNBOOK-gate.md).

Every node runs the **same `islandd` binary**; roles are just environment variables.

---

## 1. Try it (no install, no mesh)

On any machine with [Bun](https://bun.sh):

```bash
cd island
bun install
bun run dev            # mock mode → http://127.0.0.1:8787
```

Open `http://127.0.0.1:8787` (the app) or `…/admin` (admin console). Mock is in‑memory
and `/admin` is open — a safe throwaway demo.

---

## 2. Run one node

**Easiest (personal node, no root).** Build or copy the binary, then:

```bash
./islandd
```

It auto‑detects its wg0 bind address and, on first run, **auto‑creates** `~/.islandd`,
its identity keys, and a strong **admin token** (printed + saved to
`~/.islandd/admin.token`). Easiest way to get it: just **open `…/admin`** — on the
first visit the token is shown once for you to save and you're signed in on that
browser automatically (it's then removed from the server). It's also in the console
log / `admin.token` if you miss it.

**As a service (always‑on).** With the binary present in `island/`:

```bash
sudo deploy/install.sh                 # creates the islandd user + service, starts it, prints the token
journalctl -u islandd -f
```

Idempotent — re‑running won't clobber identity, token, or `/etc/islandd/islandd.env`.
(The installer **installs the binary you give it; it does not build** — see §4.)

---

## 3. The admin token (the admin password)

Unlocks `/admin` and remote/headless management. Resolution order:
`ISLAND_ADMIN_TOKEN` env → `<data>/admin.token` → **auto‑generated + printed** on first
run. Wrong guesses are rate‑limited (10 / 5 min per IP → 429). To set your own:
`ISLAND_ADMIN_TOKEN=$(openssl rand -base64 24)`.

**First‑run reveal.** When the token is auto‑generated (not env‑set), the **first**
GET of `/admin` returns it once via `GET /admin/firstrun`, which then deletes a marker
so it's never shown again; the UI displays it to save and signs that browser in. This
is deliberately unauthenticated — *first‑viewer‑wins* — on the assumption the sysadmin
opens `/admin` first. The node already sits behind the wg mesh, the reveal is
consume‑once, and an env‑set token is **never** echoed (no marker). If that race
matters in your threat model, set `ISLAND_ADMIN_TOKEN` yourself and the reveal is off.
Later sign‑ins use the 🔒 lock with the saved token.

> `ISLAND_ADMIN_TOKEN` (admin password) ≠ `ISLAND_ADMIN_PUBKEY` (the gate's canary
> signer key, §6).

---

## 4. Deploy across the mesh

Assumes the WireGuard mesh is up (each node has its `10.42.0.x` wg0 address) and you can
`ssh`/`rsync` to each over it.

### Roles — who runs what

| Node | wg0 | Arch (binary) | Role | Key env |
|---|---|---|---|---|
| **polaris** | 10.42.0.1 | Pi `arm64` | **Friend‑code registry + IDS collector** | `ISLAND_REGISTRY=1`, `ISLAND_EVENTS=1` |
| **vega** | 10.42.0.2 | Pi `arm64` (16 GB) | **File authority + internet gate + Llama** | `ISLAND_SHARE=sqlite` + gate vars |
| **sirius** | 10.42.0.5 | x86 `linux-x64` | member (spoke) | `ISLAND_SHARE=remote`, `ISLAND_REGISTRY_URL` |
| **altair** | 10.42.0.4 | macOS (`build:mac` arm64 / `build:mac-intel`) | member / viewer | spoke env; run via launchd (§4d) |
| **builder** | 10.42.0.6 | macOS | **build host** (+ optional spoke) | — |
| arcturus / phone | 10.42.0.3 | — | **client only** (browser over wg, not a daemon) | — |

- **polaris = registry**: control plane only, resolves codes — never in the data path,
  can't MITM (codes commit to keys) or forge friendships.
- **vega = file authority + gate**: hosts the shared files (`island.db`) and the only
  internet egress (the `GREEN18` canary). Everyone else is a plain spoke.
- **A phone is not a node** — it can't run the daemon; it's a browser client to a node.

### 4a. Build the binaries (on builder)

```bash
cd island && bun install
bun run build:arm64      # Linux arm64 (Pi) — polaris, vega -> dist/islandd-arm64
bun run build:x64        # Linux x86_64     — sirius        -> dist/islandd-x64
bun run build:mac        # macOS Apple Silicon              -> dist/islandd-mac
bun run build:mac-intel  # macOS old Intel (baseline)       -> dist/islandd-mac-intel
# or the three common ones:  bun run build:all
```

These are `package.json` scripts (short, so nothing breaks on copy‑paste). The raw form
is `bun build --compile --target=bun-darwin-arm64 --outfile dist/islandd-mac src/main.ts`,
which **must be a single line**.

> Match the target's CPU: **Apple Silicon → `build:mac`** (arm64), **old Intel Mac →
> `build:mac-intel`**. The x86 builds (`x64`, `mac-intel`) use Bun's **baseline** runtime
> so they run on old CPUs without AVX; arm64 needs none. *"CPU lacks AVX support"* means
> you ran an x86 build on a no‑AVX CPU — or grabbed the x64 build for an Apple Silicon
> Mac (use `build:mac`). It also shows spuriously for an x64 binary under Rosetta.

### 4b. Push with rsync + install (Linux nodes)

`deploy/push.sh` rsyncs the binary + `deploy/` over wg0 and runs the installer:

```bash
deploy/push.sh pi@10.42.0.1   dist/islandd-arm64    # polaris
deploy/push.sh pi@10.42.0.2   dist/islandd-arm64    # vega
deploy/push.sh user@10.42.0.5 dist/islandd-x64      # sirius
```

By hand (build §4a first — the binary must exist; a node with no Bun can't build):

```bash
ssh user@10.42.0.5 mkdir -p island
rsync -avz dist/islandd-x64 user@10.42.0.5:island/islandd
rsync -avz deploy/          user@10.42.0.5:island/deploy/
ssh user@10.42.0.5 'cd island && chmod +x islandd && sudo deploy/install.sh ./islandd'
```

> Pass the binary path explicitly to `install.sh` — `sudo` strips env vars, so
> `ISLAND_BIN=…` won't reach it.

### 4c. Set each node's role (`/etc/islandd/islandd.env`, then `systemctl restart islandd`)

```ini
# polaris  (registry + IDS collector — both control-plane)
ISLAND_LABEL=polaris
ISLAND_REGISTRY=1
ISLAND_EVENTS=1

# vega  (also install the gate — §6)
ISLAND_LABEL=vega
ISLAND_SHARE=sqlite

# every spoke (sirius, altair, …)
ISLAND_LABEL=sirius
ISLAND_SHARE=remote
ISLAND_SHARE_URL=http://10.42.0.2:8787       # vega
ISLAND_REGISTRY_URL=http://10.42.0.1:8787    # polaris (announce + friend by code)
ISLAND_EVENTS_URL=http://10.42.0.1:8787      # polaris (report security events)
```

> Admins view the **mesh‑wide security feed** at polaris's `/admin` → **Security** tab
> (fail2ban blocks + degraded links + wg‑selfheal events across all nodes). End users
> never see it; everyone still sees their *own* node's local readout on Home.
>
> Each node also runs the **wg‑selfheal daemon** as its own service (build/deploy per
> `../../daemon/RUNBOOK.md`). It logs JSON to journald; islandd reads
> `journalctl -u wg-selfheal` and folds its `stale`/`degraded` events into the feed.
> Rebuild the daemon after pulling — it now logs JSON.

### 4d. macOS nodes (altair, builder)

No systemd, so the installer doesn't apply — run the darwin binary directly (defaults
still auto‑provision):

```bash
rsync -avz dist/islandd-mac user@10.42.0.4:islandd
ISLAND_LABEL=altair ISLAND_SHARE=remote ISLAND_SHARE_URL=http://10.42.0.2:8787 \
ISLAND_REGISTRY_URL=http://10.42.0.1:8787 ./islandd
```

For always‑on, wrap that in a `~/Library/LaunchAgents/island.islandd.plist` and
`launchctl load` it.

---

## 5. Connecting nodes (friending)

**By code (primary).** Each node auto‑announces to the registry; share your `ISL‑…`
code (Friends tab, top). To add someone: Friends → **Add a friend** → paste their code →
they approve. Or over SSH:

```bash
islandd friend invite                 # offline fallback: prints an invite to hand over
islandd friend accept '<their token>' # → prints a reply to send back
islandd friend confirm '<reply>'
islandd friend list
```

For a remote/headless node, point the CLI at it with the admin token:
`ISLAND_ADDR=http://10.42.0.5:8787 ISLAND_ADMIN_TOKEN=… islandd friend list`. Manage it
in a browser the same way: `http://<node-wg0>:8787/admin`, unlock, use normally.

---

## 6. vega's internet gate

vega is the only node with egress. Install the `island-gate` helper + sudoers + local
Llama and set `ISLAND_ADMIN_PUBKEY` / `ISLAND_GATE_CMD` per **[RUNBOOK-gate.md](RUNBOOK-gate.md)**.
Don't set `NoNewPrivileges=true` on vega — the gate needs `sudo island-gate`.

---

## 7. The data paths — who talks to whom

```
   add a friend ──► polaris (10.42.0.1)        resolve ISL-… code  (control plane only)
                        │ then the SIGNED handshake goes node → node, not through polaris
   sirius ──friend request──► altair's wg0 ──approve──► back to sirius      (friending)

   sirius ──upload/list/download──► vega (10.42.0.2)      universal file share (island.db)
   admin  ──GREEN18 canary──► vega ──► local Llama ──► nftables egress       (internet gate)

   sirius ──message──► altair          DIRECT, sealed, peer-to-peer          (no hub relay)

   every node ──signed security events──► polaris       admin-only IDS feed   (control plane)
```

---

## 8. Verify + update

```bash
for n in 1 2 5 4; do echo "10.42.0.$n:"; curl -s http://10.42.0.$n:8787/api/health; echo; done
# files: upload on sirius (Files) -> appears on altair (both read vega)
# gate:  admin on vega -> Open gate -> /api/gate shows "internet" ~45 min
# update a node:  deploy/push.sh user@10.42.0.5 dist/islandd-x64   (identity/token/env preserved)
```

## Notes

- **Zero‑config first run:** identity, admin token, and data dir auto‑create.
- **Remote admin stays token‑gated + rate‑limited**; client‑side checks are cosmetic —
  every admin/operator action is enforced server‑side.
- **Not built yet:** the Phase H migration (archiving the old app). Phones are clients,
  not nodes.

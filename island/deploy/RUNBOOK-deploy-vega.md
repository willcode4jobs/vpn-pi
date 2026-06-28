# RUNBOOK — deploy islandd (the GUI) to vega

vega has the Llama model running but **not `islandd` itself** — and `islandd` is the
binary that serves the web UI *and* the API. The GUI isn't a separate thing to deploy;
it's bundled inside the `islandd` binary (`web/index.html` is compiled in). So this
runbook = build the arm64 `islandd` on builder, install it as a systemd service on vega,
and set vega's role.

> General multi-node version: [`RUNBOOK-deploy.md`](RUNBOOK-deploy.md). The internet gate
> (canary + helper) is separate: [`RUNBOOK-gate.md`](RUNBOOK-gate.md) /
> [`RUNBOOK-egress-finish.md`](RUNBOOK-egress-finish.md). This doc just gets the
> daemon + GUI live on vega so you can open it in a browser.

---

## What vega is

vega = **file authority + internet gate + Llama host** (arm64 Pi, 8 GB). For deploying the
daemon, the role boils down to two env settings now (`ISLAND_SHARE=sqlite` + pointing at
the local Llama); the full gate wiring is the egress runbook.

---

## Prerequisites

- **Mesh up**: from builder you can reach vega — `ping -c2 10.42.0.2` and `ssh <user>@10.42.0.2`.
- **Bun on builder** (the build host — vega has no Bun and can't build):
  ```bash
  bun --version || curl -fsSL https://bun.sh/install | bash   # then restart the shell
  ```
- Run everything below **from the `island/` directory** on builder (so `deploy/` is alongside).

---

## Step 1 — Build the arm64 binary (on builder)

```bash
cd island
bun install
bun run build:arm64        # → dist/islandd-arm64   (Linux arm64, for the Pi)
ls -lh dist/islandd-arm64  # sanity: the compiled binary exists
```

> vega is a **Raspberry Pi (arm64)** → `build:arm64`. (Don't ship a mac/x64 build to it.)

---

## Step 2 — Push + install on vega

`push.sh` rsyncs the binary + `deploy/` over wg0 and runs the installer (creates the
`islandd` service user, installs the binary to `/usr/local/bin/islandd`, writes the
systemd unit + env file, starts it, and prints the admin token):

```bash
deploy/push.sh <user>@10.42.0.2 dist/islandd-arm64
```

The installer is **idempotent** and preserves identity / admin token / env across reruns.
It also won't clobber the `islandd` user you already created for the Llama service —
it reuses it.

<details>
<summary>By hand instead of push.sh (same result)</summary>

```bash
ssh <user>@10.42.0.2 'mkdir -p island'
rsync -avz dist/islandd-arm64 <user>@10.42.0.2:island/islandd
rsync -avz deploy/            <user>@10.42.0.2:island/deploy/
ssh -t <user>@10.42.0.2 'cd island && chmod +x islandd && sudo deploy/install.sh ./islandd'
```
</details>

Watch it come up:

```bash
ssh <user>@10.42.0.2 'journalctl -u islandd -n 20 --no-pager'
```

---

## Step 3 — Set vega's role, then restart

Edit vega's env file and set the file-authority + Llama bits (the gate signer/helper vars
come from the egress runbook — add them in the same file when you do that step):

```bash
ssh <user>@10.42.0.2 'sudo nano /etc/islandd/islandd.env'
```

```ini
ISLAND_LABEL=vega
ISLAND_SHARE=sqlite                  # vega keeps the durable island file share (island.db)
ISLAND_LLAMA_URL=http://127.0.0.1:8080   # the local Llama service you already have running
# --- added later, per RUNBOOK-egress-finish.md ---
# ISLAND_ADMIN_PUBKEY=<canary signer ed25519 b64>
# ISLAND_GATE_CMD=sudo /usr/local/sbin/island-gate
# ISLAND_GATE_TTL=2700
# ISLAND_CANARY_KEYWORD=GREEN18
```

```bash
ssh <user>@10.42.0.2 'sudo systemctl restart islandd'
```

> ⚠️ **vega is special: do NOT add `NoNewPrivileges=true` to islandd's unit.** The gate
> calls `sudo island-gate`, which `NoNewPrivileges` would block. The shipped
> `islandd.service` already leaves it off — don't add it on vega.

---

## Step 4 — Verify + open the GUI

```bash
# health (run from builder, over the mesh):
curl -s http://10.42.0.2:8787/api/health      # {"ok":true,"service":"islandd",...}

# the admin token (printed by the installer; also saved on vega):
ssh <user>@10.42.0.2 'sudo cat /var/lib/islandd/admin.token'
```

Then from a browser **on builder**:
- `http://10.42.0.2:8787/`       — the user app
- `http://10.42.0.2:8787/admin`  — admin console (🔒 → paste the token)

(That browsing flow is its own little guide: [`VIEW-GUI-FROM-BUILDER.md`](VIEW-GUI-FROM-BUILDER.md).)

---

## Identity note (the keys)

On first start `islandd` **auto-creates** vega's identity keypairs in
`/var/lib/islandd/identity` if absent — so the daemon comes up with zero key setup. Per
project rule you can instead pre-generate them yourself before first start:

```bash
ssh <user>@10.42.0.2 'sudo -u islandd /usr/local/bin/islandd keygen /var/lib/islandd/identity'
```

Either way, the gate later needs **vega's X25519 public key** (the admin seals canaries to
it) — read it once islandd is up:

```bash
ssh <user>@10.42.0.2 'curl -s localhost:8787/api/identity'   # copy the "x25519" value
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `push.sh` / install: "no islandd binary" | you didn't build, or shipped the wrong arch — `bun run build:arm64` and pass `dist/islandd-arm64`. |
| Service won't start, `journalctl -u islandd` shows a bind error | wg0 has no address yet — ensure `wg-quick@wg0` is up (the unit waits on it, but the iface must exist). |
| `/api/health` works locally on vega but not from builder | islandd bound to loopback, not wg0 — set `ISLAND_HOST=10.42.0.2` in the env file and restart, or check wg connectivity. |
| `/admin` forbidden | wrong/blank admin token — re-read `/var/lib/islandd/admin.token`. |
| Gate "open" errors in the UI | expected for now — prod minting isn't built; see `RUNBOOK-egress-finish.md`. |

---

## After this

islandd + GUI are live on vega. Next, to make the **gate** actually openable:
finish [`RUNBOOK-egress-finish.md`](RUNBOOK-egress-finish.md) (helper + sudoers + admin
key + the `islandd canary` mint command). To roll out the rest of the mesh (polaris,
sirius, …), use [`RUNBOOK-deploy.md`](RUNBOOK-deploy.md) §4.

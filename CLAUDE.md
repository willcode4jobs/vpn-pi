# CLAUDE.md — SU495 island-internet mesh

Context + conventions for the coding agent. Project summary lives in `README.md`;
per-file code map in `CODE-MAP.md`.

## What this is
A WireGuard mesh "island internet" with IDS-style attack detection. Hub-and-spoke:
one hub (vega) + a master (polaris) + endpoint sensors/viewers. The mesh hosts its
own services rather than tunneling to the outside — the first of those services is
the per-node **IDS GUI**. Admin is over SSH/CLI.

## Status — Phase One (current)
- **Done:** node hardening (`harden-base.sh` on polaris + vega), the hub-and-spoke
  WireGuard design (dual-stack templates in `docs/wg-templates/`), and the IDS GUI
  (FastAPI backend + React frontend: wg0-bound file share + blind-relay IDS feed).
- **In progress:** sirius endpoint sensor deploy (x86 / SELinux), IPv6 rollout across
  the live configs, trimming leftover exit-node plumbing now that there's no egress point.
- **Later phases:** the `wg-selfheal` daemon (`daemon/`) and the rest of the
  island-internet cleanup.

## Architecture
- **WireGuard** (kernel-space, chosen over OpenVPN).
- **Hub-and-spoke.** Every node holds a tunnel to **one hub (vega)**; the hub relays
  traffic between spokes. No direct spoke-to-spoke tunnels.
- **vega = hub** — access/exit edge, the island **file authority** (SQLite
  `island.db`), and the **IDS relay**. The only public-facing node (home DDNS, UDP
  51820).
- **polaris = master** — control plane, and a **spoke on purpose**: a WireGuard hub
  decrypts everything it relays, so the master must *not* be the hub. Keeping polaris
  a spoke keeps it out of the data path (it sees control traffic only).
- **Dual-stack** — IPv4 `10.42.0.0/24` + IPv6 ULA `fd49:2977:3d2f::/64`, hosts
  numbered so `::N` matches `10.42.0.N`.
- **IDS scope:** network + tunnel level only, no application-layer. **Blind-relay
  alerts:** each node *sign-then-seals* an alert (Ed25519 sign, X25519 seal to the
  master), ships the opaque blob to the hub's relay buffer, and only the master
  decrypts + verifies + aggregates. The hub never sees plaintext.

## The fleet
| node | wg0 (v4 / v6) | host | role | state |
|---|---|---|---|---|
| **polaris** | 10.42.0.1 / `::1` | `billy@polaris`, Pi 5 8GB | master (control plane), GUI mesh aggregator | set up, hardened |
| **vega** | 10.42.0.2 / `::2` | `billy@vega` | hub — edge + file authority + IDS relay | set up, hardened, hub live |
| **sirius** | 10.42.0.5 / `::5` | `brichardt@thebigun`, x86 Linux (SELinux) | endpoint sensor (journald + fail2ban) | deploy in progress |
| **altair** | 10.42.0.4 / `::4` | old MacBook (macOS) | **viewer only** — no journald/fail2ban, so no sensor | joins via WireGuard.app |
| **arcturus** / cellphone | 10.42.0.3 / `::3` | TBD | endpoint | not built |
| **builder** | 10.42.0.6 / `::6` | Mac dev box | dev / push origin | n/a |

### Node specifics
- **polaris** — Pi OS 64-bit. Home LAN `192.168.1.72` (DHCP reservation, eth0 MAC
  pinned). SSH key-only (password auth disabled via the `sshd_config.d` drop-in).
  Repo at `~/projects/vpn-pi/`. Reach by IP — mDNS (`polaris.local`) is dead behind
  the firewall (see gotchas).
- **vega** — Home LAN `192.168.1.73` (DHCP reservation, same mechanism). Now the wg
  hub at `10.42.0.2` and the file authority (`/var/lib/vpn-pi/island.db`). Reach by IP.
- **sirius** — deploy under `/opt` (not `/home`) and use a **py3.12** venv; SELinux
  blocks a service exec'ing from `/home` and has no cp314 wheels. See
  `gui/deploy/RUNBOOK-sirius.md`.

## Repo structure
```
gui/                 IDS GUI — backend/ (FastAPI) + frontend/ (React/Vite) + deploy/
pi-deployment/       node hardening + firewall scripts (harden-base.sh, open-gui-port.sh)
docs/                planning, runbooks, flowcharts, wg-templates/ (mesh configs)
daemon/              wg-selfheal Go daemon (later phase)
archive/             superseded phase-2 single-exit-node prototype
CODE-MAP.md          per-file map of the whole codebase + a runbook index
phaseOneRunbook.md   how to run it + how it meets the submission requirements
```

## Git conventions
- **Branch prefixes:** `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`, `test/`.
- **Commit prefixes:** mostly match the branch prefix, with two exceptions —
  `refactor/` → `refax:`, `docs/` → `dox:`. Prefix is mandatory.
- Commit messages: lowercase, minimal punctuation, descriptive.
- **Never push to `main`** — only merge into main via PR.
- Specialty branches per node (polaris / vega) + a uniform-development line
  (`feat/ids-mesh`) where shared code lands before it fans out.
- Push from both Mac and Pi (single-user, private repo; Pi has write via deploy key).

## Keys & secrets
- **The operator generates all real keypairs on the host that owns them** — only
  public keys ever move. The agent never mints real private keys/secrets (test with
  ephemeral keys only). `.gitignore` blocks `*.conf`, `*.private`, `*_private_key`.
- **SSH topology:** Mac → Pi uses `~/.ssh/id_ed25519_master` (passphrase + Keychain),
  SSH alias `polaris`, `IdentitiesOnly yes`. Pi → GitHub uses a per-host deploy key
  (`~/.ssh/id_ed25519_github`, no passphrase).
- **IDS keys:** master X25519 keypair on polaris; an Ed25519 signer per sensor node;
  register each node's verify key in the master's registry. See
  `docs/ids-planning/03-crypto-and-keys.md` + `gui/deploy/ids-keygen.py`.

---

## Deployment script conventions (`pi-deployment/`)

### Required boilerplate
Every script starts with strict mode and self-logging:

```bash
#!/usr/bin/env bash
set -euo pipefail

# --- Logging setup ---
LOG_DIR="/var/log/vpn-pi"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(basename "$0" .sh)-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "[$(date +%H:%M:%S)] Logging to: $LOG_FILE"
```

This captures stdout, stderr, and `bash -x` trace into a persistent log under
`/var/log/vpn-pi/` (standard location; survives reboots and a repo re-clone, unlike
`/tmp/`). Filename pattern `<script>-YYYYMMDD-HHMMSS.log` accumulates runs.

### Other conventions
- Descriptive function names — one section of work per function.
- **Idempotent everywhere** — check current state before changing it.
- Echo a status header per section so the operator sees live progress.
- Verify-then-modify for configs — don't blindly overwrite working state.

### Running them
```bash
cd ~/projects/vpn-pi
sudo bash -x pi-deployment/<script-name>.sh
```
`bash -x` trace goes to stderr, which the script redirects into its own log — don't
add `| tee` on the command line.

### Pre-flight for hardening / firewall / SSH scripts (can lock you out)
1. Open a **second SSH session** as an idle safety net.
2. Run the script.
3. In a **third terminal**, test fresh `ssh polaris`. If it works, close the net.
4. Review the log if anything looked off.

**Recovery if locked out:** the safety-net session → edit the SD card from the Mac
via USB-C reader → last resort re-flash + `ssh-copy-id`.

---

## Key gotchas already learned
- **mDNS (`*.local`) breaks under the hardening firewall.** The nftables baseline
  drops inbound UDP/5353, so the Pi never answers mDNS even though `avahi-daemon` is
  running. `ssh polaris.local` just hangs. Fix: connect by IP + pin the node via DHCP
  reservation (not static-on-Pi).
- **"Service active" ≠ "service defending"** — trigger defenses to verify they work
  (fail2ban especially).
- **`IdentitiesOnly yes`** is required in the Mac SSH config when the agent holds
  multiple keys, else SSH hits `MaxAuthTries` before the right key.
- **fail2ban must log to the journal** (`logtarget = SYSTEMD-JOURNAL`) or its bans
  never reach the GUI's journal-derived JAILS panel.
- **SELinux (sirius):** never global `setenforce 0` to collect AVCs — it can
  black-screen the desktop; scope `semanage permissive` to the service domain. Deploy
  under `/opt`, not `/home`. Recover a mislabel with `fixfiles -F onboot && reboot`.
- **Pi Imager** can silently fail to write `authorized_keys` — recover by re-flashing
  with password auth, then `ssh-copy-id`.
- **`/tmp/` clears on reboot** — never put logs there.

---

## Open items
- sirius endpoint deploy (x86 / SELinux) — in progress.
- IPv6 dual-stack rollout across the live wg configs.
- Remove leftover exit-node plumbing (NAT / forwarding) — no egress point in the
  island model.
- Threat model + scope docs refresh to the island-internet framing.
- Flowchart rebuild (named nodes, hub-and-spoke) + eventual Mermaid migration.

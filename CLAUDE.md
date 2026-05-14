# CLAUDE.md — SU495 VPN Project

## What's being built
WireGuard mesh VPN with IDS-style attack detection. 5-node mesh: master + access/exit + 3 endpoints. Multi-site deployment. Master admin via SSH/CLI (web UI was cut).

## Architecture (current state, partially in flux)
- WireGuard (kernel-space) chosen over OpenVPN
- Full mesh: every node has direct WG tunnels to every other node
- Control plane is bidirectional (master ↔ all nodes for configs, logs, IDS alerts)
- Master is co-located with access/exit, NOT in the data path — sees only control traffic, no user payload
- IDS scope: network + tunnel level only, no application-layer
- Outbound data flow: endpoint → home router → internet (encrypted) → site router → access/exit Pi (decrypt + NAT) → site router → internet (cleartext) → destination
- Inbound data flow: external client → internet (encrypted) → site router → access/exit Pi (decrypt + re-encrypt for next tunnel) → destination endpoint. Two-stage encryption because home endpoints have no public IP and can't peer directly with external clients.

## Architecture pivot IN PROGRESS (not yet committed)
Original: business = public-facing, home = endpoints. Pivoting to: home = public-facing, business = endpoints.

Trigger: office firewall is heavy-duty; inbound port forwarding from office not practical.

Pending verifications:
- CGNAT at home (whatismyip.com vs home router WAN IP)
- Office outbound UDP works (test WG handshake from office machine)
- Endpoint machines/IT policy at office

If confirmed: threat model shifts (home now public-facing), DDNS required for residential dynamic IP, all flowcharts need site-label swap, exit IP becomes home IP.

## Naming (stars)
- **polaris** — master ✓ set up, hardening pending first run
- **vega** — edge (access/exit) — not yet built
- **sirius, altair, arcturus** — endpoints — not yet built

## Polaris current state
- Pi OS 64-bit on Pi 5 8GB
- User `billy`, hostname `polaris`
- Home LAN via Ethernet, mDNS works (`polaris.local`)
- SSH key auth only, password auth disabled in `/etc/ssh/sshd_config`
- VS Code Remote-SSH connected
- Git installed, repo cloned to `~/projects/vpn-pi/`
- `harden-base.sh` written on `feat/polaris-hardening`, NOT yet run

## Repo structure
```
~/projects/vpn-pi/
├── docs/
├── prototype/
├── pi-deployment/     ← deployment scripts
└── archive/
```

## Git conventions
- Branch prefixes: `feat/`, `fix/`, `chore/`, `refactor/`, `docs/`, `test/`
- Commit messages use the same prefixes
- Push from both Mac and Pi (single-user, private repo, Pi has write access via deploy key)

## SSH key topology
- **Mac → Pi:** `~/.ssh/id_ed25519_master` with passphrase + macOS Keychain. SSH config alias `polaris`, `IdentitiesOnly yes`.
- **Pi → GitHub:** `~/.ssh/id_ed25519_github` on Pi, no passphrase (deploy key, write enabled). SSH config block for `github.com`.

---

## Deployment script conventions (pi-deployment/)

### Required boilerplate

Every script in `pi-deployment/` starts with strict mode and self-logging:

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

This captures stdout, stderr, AND `bash -x` trace output into a persistent log that survives reboots. Logs go to `/var/log/vpn-pi/` because:
- Standard Linux location for system/service logs
- Survives if the repo is wiped or recloned
- Persists across reboots (unlike `/tmp/`)
- Already accessible since these scripts run with sudo

Filename pattern: `<script-name>-YYYYMMDD-HHMMSS.log` so multiple runs accumulate rather than overwrite. Manual pruning for now; add logrotate config later if logs grow.

### Other conventions

- Functions with descriptive names — one section of work per function
- Idempotent everywhere — check current state before changing it
- Echo a status header per section so the operator sees live progress
- Verify-then-modify pattern for configs (don't blindly overwrite working state)

---

## Running deployment scripts

### Standard invocation

```bash
cd ~/projects/vpn-pi
sudo bash -x pi-deployment/<script-name>.sh
```

`bash -x` traces each command as it runs. Don't add `| tee` on the command line — the script handles its own logging via `exec`. The `-x` trace goes to stderr, which the script redirects into the same log file, so the trace IS captured.

### Pre-flight checklist for hardening / firewall / SSH scripts

These can lock you out of the Pi. Before running:

1. **Open a second SSH session** in another terminal. Keep it idle as a safety net.
2. **Run the script** with the standard invocation above.
3. **After completion, open a third terminal and test fresh SSH:**
   ```bash
   ssh polaris
   ```
   If fresh SSH works, you're good — close the safety net and proceed.
   If it doesn't, troubleshoot from the safety-net session you kept open.
4. **Review the log** at the path printed by the script if anything looked off.

### Recovery if locked out
- Safety-net SSH session (if still alive)
- Edit SD card from the Mac via the USB-C reader
- Last resort: re-flash with `ssh-copy-id` recovery procedure

---

## Current task

`harden-base.sh` on `feat/polaris-hardening` — written, reviewed, **NOT yet run**.

Before running: **retrofit the logging block above into the script** if Claude Code didn't include it.

Script does:
1. Verify running as root
2. `apt update` + `apt upgrade -y`
3. Install `nftables`, `fail2ban`, `unattended-upgrades`, `wireguard`
4. Verify SSH lockdown: `PasswordAuthentication no`, `PermitRootLogin no`, `PubkeyAuthentication yes`
5. nftables baseline: default-deny inbound, allow loopback, allow established/related, allow SSH (port 22), allow ICMP echo. WG port NOT opened yet.
6. fail2ban sshd jail, maxretry 5, bantime 1h
7. unattended-upgrades for security patches only
8. Print summary of active services and firewall rules

Don't:
- Configure WG tunnels (pivot pending)
- Open WG port in firewall yet
- Modify SSH port
- Touch `/etc/hostname`

Commit message after first successful run:
`feat: initial harden-base.sh with SSH, nftables, fail2ban, unattended-upgrades`

---

## Key gotchas already learned

- **Pi Imager can silently fail to write `~/.ssh/authorized_keys`** — recover by re-flashing with password auth enabled as fallback, then `ssh-copy-id` from the Mac.
- **"Service active" ≠ "service defending"** — always trigger defenses to verify they actually work (fail2ban especially).
- **`IdentitiesOnly yes`** is required in Mac SSH config when the agent holds multiple keys, otherwise SSH hits `MaxAuthTries` before reaching the right one.
- **`/tmp/` clears on reboot** — never put logs there if you might want them after a kernel update reboot.

---

## William's preferences

- Wants pushback, not validation
- Wants honest hour estimates, no padding
- Wants engineering judgment, not corporate hedging
- Does NOT want unsolicited sleep/rest advice. If directly asked, advise honestly; otherwise stay out.
- Does NOT want copy-paste answers in deliverables — wants help structuring his own voice
- Casual tone fine; cursing sparingly OK
- Direct corrections welcome

---

## Open items

- Architecture pivot verifications (CGNAT, office UDP, endpoint definitions)
- Topology flowchart rebuild (site boundaries, named nodes, no traffic arrows)
- Dev workflow flowchart (not started)
- Threat model revision (depends on pivot outcome)
- IDS data flow diagram (Phase 8 prep)
- All current flowcharts need site-label swap if pivot confirmed
- Mermaid migration of flowcharts (eventually)
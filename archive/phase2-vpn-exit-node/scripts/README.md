# prototype/scripts

Reproducible setup helpers for VPN Pi nodes. Targets a fresh
**Ubuntu Server 24.04** (current prototype VM) or **Pi OS Lite 64-bit**
(eventual hardware target). Scripts are POSIX-bash, run with
`set -euo pipefail`, and are idempotent — re-running on an
already-configured host should be a no-op.

## harden-base.sh

The base hardening bootstrap. Applied to **every node** in the mesh
(prototype VM today; master + 3 endpoints once the Pi arrives).

### What it does

1. `apt update` and `apt upgrade -y` (non-interactive)
2. Installs the hardening package set:
   `nftables tcpdump git fail2ban lynis unattended-upgrades curl vim`
3. Enables `unattended-upgrades` via
   `dpkg-reconfigure -f noninteractive`
4. Validates and installs
   `prototype/configs/sshd/sshd_config.hardened` to
   `/etc/ssh/sshd_config` (runs `sshd -t` against the source
   *before* overwriting the live config), then `systemctl reload ssh`
5. Validates and installs
   `prototype/configs/nftables/baseline.nft` to
   `/etc/nftables.conf` (runs `nft -c -f` first), then
   `systemctl enable --now nftables`
6. Installs `prototype/configs/fail2ban/jail.local` to
   `/etc/fail2ban/jail.local`, then
   `systemctl enable --now fail2ban` and confirms the `sshd` jail came up
7. Runs `lynis audit system --quick` — informational only, exit code
   ignored. Findings live in `/var/log/lynis.log` and
   `/var/log/lynis-report.dat` for review.

### How to run

From the repo root:

```bash
sudo bash prototype/scripts/harden-base.sh
```

The script computes its own location and resolves config paths relative
to that, so the working directory does not matter — `sudo bash` from
anywhere works equally well.

### Prerequisites

- **Fresh OS install.** The script assumes stock Ubuntu Server / Pi OS
  Lite. Running it against a heavily customized host is fine but the
  config files will be overwritten.
- **SSH key already authorized.** The hardened sshd_config disables
  password authentication. If you have not put your public key in
  `~billyuser/.ssh/authorized_keys` *before* running this script,
  `systemctl reload ssh` will lock you out on the next reconnect.
  Verify with `ssh -i <key> billyuser@host` from a second terminal
  before disconnecting your existing session.
- **Network reachability for SSH.** `baseline.nft` allows TCP/22 from
  any source by default (fail2ban guards brute-force). To restrict to
  a LAN subnet, edit the `<LAN_SUBNET>` placeholder in `baseline.nft`
  before running the script.
- **Root.** The script aborts with a clear message if `EUID != 0`.

### What it explicitly does NOT do

- **No WireGuard.** Installing and configuring `wg0` is Phase 3 work.
  The nftables baseline keeps the `forward` chain at `policy drop`
  with commented-out reference rules for the WireGuard era.
- **No per-node specifics.** No hostname, no node IP, no peer keys, no
  DNS overrides. Everything node-specific is layered on top of this
  baseline by later scripts.
- **No lynis remediation.** `lynis` runs and reports; addressing
  findings is Phase 10 hardening polish.
- **No automated tests.** Manual verification only for now —
  reconnect over SSH in a second session, run `nft list ruleset` and
  `fail2ban-client status sshd`, and confirm the system is reachable.

### Idempotency

The script is safe to re-run. Concretely:

- `apt-get update / upgrade / install` are idempotent on already-current
  hosts.
- `dpkg-reconfigure unattended-upgrades` is a no-op when the package is
  already configured.
- `install` overwrites the destination with identical bytes; if the file
  is unchanged, it remains unchanged.
- `systemctl reload / restart` always succeed against a healthy unit.
- `lynis` is read-only.

If any step fails, `set -e` aborts immediately and leaves the system in
a known partial state — fix the cause and re-run.

# VPN Pi Project — Claude Code Context

## Project goal

Build a WireGuard-based VPN exit node on a Raspberry Pi. A user connects from
anywhere (Mac, phone, etc.) and their traffic appears to originate from the Pi's
home network. 250-hour academic project — PSU SU495 internship under
Dr. Raahemifar. ~12 hours spent as of project start.

## Environment

- **Prototype host**: Ubuntu Server 24.04 LTS, running as a VM in VMware Fusion
  on a macOS host. Reachable via SSH from the Mac. Username: `billyuser`.
- **Final target**: Raspberry Pi 5 (in shipping), will run Pi OS Lite 64-bit.
- **Workflow**: User edits via VS Code Remote-SSH from Mac into the VM. Claude
  Code runs on the VM. All commands assume VM context unless noted.
- **Git**: GitHub repo, SSH push via agent forwarding from Mac.

## Architecture decisions (do not relitigate)

- **WireGuard, not OpenVPN.** ~4,000 lines of in-kernel code vs. 100k+ userspace
  daemon. Better crypto defaults (Curve25519, ChaCha20-Poly1305, BLAKE2s).
  Don't suggest OpenVPN configurations.
- **Pi OS Lite, not Ubuntu Server, on the eventual Pi.** Lite is purpose-built
  for the Pi and has a smaller attack surface. Ubuntu Server is fine for the
  current VM prototype since they're both Debian-family.
- **Prototype-first, not sandbox-first.** Earlier plan included extensive Linux
  network namespace labs. Pivoted to building the actual VPN on the prototype
  VM, since the work transfers cleanly to the Pi and produces real artifacts
  rather than throwaway plumbing. Existing namespace work lives in
  `archive/phase1-netns/`.
- **Hand-written configs, not generators.** `wg0.conf` and `nftables.conf` are
  written manually so the user understands every line. Don't reach for
  `wg-easy`, `pivpn`, `wireguard-install`, or similar wrappers.
- **Hardened by default.** SSH password auth disabled, key-only login,
  default-deny nftables, fail2ban, unattended-upgrades. Same hardening will
  apply to the Pi.

## Repo layout

- `prototype/` — current active work; VM-based VPN build
- `prototype/configs/` — hand-written configs that will eventually deploy to Pi
- `prototype/scripts/` — setup, teardown, helpers (all `set -euo pipefail`)
- `docs/` — architecture, network fundamentals, runbook, work log
- `pi-deployment/` — placeholder, becomes active when Pi arrives
- `webui/` — placeholder, becomes active in Phase 6
- `archive/` — shelved work kept for reference

## Workflow conventions

- **Commits**: per logical chunk, push immediately. Format: `<area>: <verb> <thing>`.
  Example: `prototype: add wg0.conf with first peer`.
- **Scripts**: `#!/bin/bash` shebang, `set -euo pipefail` second line, idempotent
  teardown patterns (`2>/dev/null || true`).
- **Configs**: written by hand, validated before applying (`sshd -t`,
  `nft -c -f file`, `wg-quick strip wg0`).
- **Secrets**: never commit private keys. Add patterns to `.gitignore` for
  `*.private`, `*_key`, etc. WireGuard configs with private keys live outside
  the repo or are sanitized examples committed as `*.example`.
- **Verification**: every config or rule change tested before the next change.
  Especially for sshd and nftables — verify the change works in a second SSH
  session before disconnecting the first.

## What's deferred

- Pi-specific work (`pi-deployment/`) — hardware in shipping
- Web UI (`webui/`) — Phase 6, hours 120+
- Multi-user, billing, account management — out of scope
- DNS hosting, ad-blocking via Pi-hole — Phase 5 stretch goal

## Decision-making defaults

- The user has a 250-hour budget and a professor expecting demonstrable
  deliverables. Default toward shipping artifacts over pedagogical sandboxes.
- For Anthropic product specifics (Claude Code install commands, model
  versions, API details), check official docs — training data may be stale.
- For Linux/networking specifics, prefer the man pages and current Ubuntu
  documentation over assumed knowledge.
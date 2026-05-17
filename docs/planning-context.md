# SU495 VPN Project — Planning Handoff

Snapshot for transferring context to a fresh LLM planning conversation. Verify anything load-bearing against current repo state before acting on it — this file ages.

## Project
Senior capstone. WireGuard mesh VPN with network-layer IDS. 5 nodes across 2 sites (home + office). Single operator. Originally 250h budget; partway through.

## Architecture
- WireGuard kernel-space, full mesh (every node peers with every node)
- Master co-located with edge — sees control traffic only, not user payload
- IDS scope: network + tunnel layer, no application inspection
- Web UI was cut from the original 7-phase plan

## Node naming (stars)
- polaris — master (built + hardened, sits on home LAN at 192.168.1.72)
- vega — edge / access+exit (not built)
- sirius, altair, arcturus — endpoints (not built)

## Architecture pivot IN PROGRESS (not committed)
- Original: business site = public-facing, home site = endpoints
- Pivoting to: home = public-facing, business = endpoints
- Trigger: office firewall too heavy for inbound port forwarding
- Blocks until verified:
  1. CGNAT check at home (whatismyip vs router WAN IP)
  2. Office outbound UDP works (WG handshake test from office machine)
  3. Endpoint machine availability + office IT policy
- If confirmed: DDNS required for home, threat model shifts, all flowcharts need site-label swap, exit IP becomes home IP

## State of work (as of 2026-05-14)
- polaris hardened end-to-end via `harden-base.sh`: nftables default-deny (SSH+ICMP only), fail2ban sshd jail, unattended-upgrades, WG package installed (no tunnels yet)
- SSH key-only, password auth off, root login off, drop-in config under `sshd_config.d/`
- Repo + docs scaffolding in place
- Phase-2 single-exit-node prototype archived (superseded by mesh design)

## What's next (rough order)
1. Resolve pivot verifications above
2. Rebuild topology + threat model flowcharts post-pivot
3. Build vega — apply `harden-base.sh`, then layer WG + NAT
4. Build endpoints (sirius/altair/arcturus)
5. IDS design + implementation
6. Polish + runbook

## Conventions that affect planning
- Branch prefixes: `feat/ fix/ chore/ refactor/ docs/ test/`
- Commit prefixes match, except `refactor/` → `refax:` and `docs/` → `dox:`
- Never push to `main`; merge via PR only
- Deployment scripts: idempotent, self-logging to `/var/log/vpn-pi/`, run with `sudo bash -x script.sh`, always keep a safety-net SSH session open

## Collaboration preferences
- Pushback over validation
- Honest hour estimates, no padding
- Engineering judgment, not corporate hedging
- One step at a time on multi-step lists — verify step 1 before touching step 2
- No unsolicited sleep/rest advice
- Doesn't want copy-paste prose — help structure his own voice
- Casual tone fine, cursing sparingly OK

## Known risks / open decisions
- Pivot outcome (biggest unknown — blocks several downstream decisions)
- DDNS choice if home goes public-facing
- IDS architecture undecided
- Cross-site WG behavior under office firewall (outbound UDP only, likely NAT'd)
- Original 250h budget included 55h for the cut web UI — phase budget needs rebalancing

## Reference files in repo
- `CLAUDE.md` — fuller project context
- `docs/system-architecture.md` — pre-pivot architecture writeup
- `docs/development-workflow.md` — original 7-phase plan (Mermaid)
- `docs/CHANGELOG.md` — what's been done
- `pi-deployment/harden-base.sh` — base hardening script

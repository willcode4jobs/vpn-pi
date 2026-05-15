# Changelog

Reverse-chronological log of meaningful project changes. Phase-based; no semver — this is a single-user project, not a released package. Dates are when work landed on `main` (or when committed if not yet merged).

---

## 2026-05-14 — polaris hardening applied + repo cleanup

Branch: `feat/polaris-hardening` (not yet merged)

### Added
- **`harden-base.sh` self-logging boilerplate.** Every deployment script now writes stdout+stderr+`bash -x` trace to `/var/log/vpn-pi/<script>-YYYYMMDD-HHMMSS.log` via `exec > >(tee -a ...) 2>&1`. Logs survive reboots and repo re-clones. Convention documented in `CLAUDE.md`.
- **mDNS/DHCP gotcha** captured in `CLAUDE.md`. nftables baseline drops UDP/5353, so `polaris.local` resolution silently fails under the firewall even with `avahi-daemon` running. Resolution: connect by IP, pin via DHCP reservation on the home router (not static-on-Pi).
- **polaris first-run notes** in `CLAUDE.md`: pre-run sshd was `PasswordAuthentication=yes` despite Imager intent; initial fail2ban verification hit a control-socket race.

### Fixed
- **fail2ban race in `harden-base.sh`.** Verification step fired before the fail2ban control socket finished binding, causing a false failure on first run. Added a `fail2ban-client ping` poll loop. Script is now cleanly idempotent end-to-end.
- **Git convention typo** in `CLAUDE.md` — `refactor/` branch maps to `refax:` commit prefix (was previously inconsistent).

### Changed
- **Archived `phase2-vpn-exit-node/` prototype** into `archive/`. Superseded by the 5-node mesh design. Kept in-tree as reference, not active code.

### Applied (state changes on hardware, not just code)
- `harden-base.sh` run end-to-end on polaris. Now active: nftables default-deny baseline (SSH + ICMP only), fail2ban sshd jail (maxretry 5, bantime 1h), unattended-upgrades for security patches, WireGuard package installed (no tunnels configured yet).
- SSH locked down via `/etc/ssh/sshd_config.d/00-vpn-pi-hardening.conf` drop-in: `PasswordAuthentication no`, `PermitRootLogin no`, `PubkeyAuthentication yes`.

---

## 2026-05-10 — base hardening scripts merged (PR #4)

Branch: `feat/hardening-scripts` → merged into `main`

### Added
- **`harden-base.sh`** initial version. Idempotent bootstrap covering: apt update/upgrade, install of `nftables`/`fail2ban`/`unattended-upgrades`/`wireguard`, SSH lockdown drop-in, nftables default-deny baseline (SSH + ICMP), fail2ban sshd jail, unattended security upgrades.
- **Tracked reference configs** from the earlier exit-node prototype: hardened `sshd_config`, nftables baseline ruleset, fail2ban jail config.
- **Scripts README** documenting deployment-script conventions.
- **`.gitignore`** entry for `.current` evidence files (run-time artifacts, not source).

### Deferred (explicitly NOT done by this script)
- WireGuard tunnel configuration (architecture pivot pending)
- Opening WG port in firewall (per-node, later)
- SSH port change
- `/etc/hostname` modification

---

## 2026-05-06 / 2026-05-07 — documentation pass (PRs #1–#3)

### Added
- **`CLAUDE.md`** — project instructions for AI-assisted work.
- **`docs/system-architecture.md`** — 5-node mesh architecture writeup.
- **`docs/development-workflow.md`** — 7-phase plan (250h budget) as Mermaid flowchart.
- **`docs/workingtree.md`** — repo structure reference.
- **`docs/gitpractice.md`** — branch/commit prefix conventions, "never push to main" rule.
- **Architecture flowcharts** (prototype) — initial topology diagrams.

### Fixed
- Multiple doc passes correcting broken Mermaid renders and blank flowcharts.

---

## 2026-05-06 — repo created

- `First commit`. Project scaffolding.

---

## Open / not yet changelog'd

These are tracked in `CLAUDE.md` under "Open items" but haven't produced commits yet:

- Architecture pivot verifications (CGNAT at home, office outbound UDP, endpoint definitions)
- Topology flowchart rebuild with named-star nodes
- Threat model revision (depends on pivot)
- IDS data flow diagram (Phase 8 prep)
- Site-label swap across all flowcharts if pivot confirmed
- Mermaid migration of remaining flowcharts

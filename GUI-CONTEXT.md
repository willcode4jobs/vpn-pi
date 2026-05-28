# SU495 — GUI Build Context (peer-facing web tool, polaris)

> Lean working context for a GUI build session. Scope: peer-facing GUI + log-collection on
> polaris. Holds *current* state only.

---

## What's being built

A **peer-facing web GUI** on polaris (master) for self-serve mesh control over the tunnel.
Phase E in the v4 plan — wraps Phase C. C-independent pieces are in scope first (layout,
live mesh status, handshake display, log viewer); exit-node switching is scaffold-only
until the business node exists (currently the only path to a genuinely distinct second
exit IP — gaming shares vega's home WAN).

---

## Host facts

- **polaris** = master, SPOF, log-collection point, central config, host of this GUI.
- **polaris is a Pi / Debian node** (NOT Fedora). Floor ruleset path is
  **`/etc/nftables.conf`** (not `/etc/sysconfig/`). **No SELinux** (Debian).
- Reached remotely via `ssh -J vega polaris` (ProxyJump through vega, the sole public node).
  polaris is bastioned.

---

## Networking / binding

- GUI binds **wg0 only** — reachable only over the tunnel. Never bound to a public or LAN
  interface; no port opens through the floor for it.
- Floor is default-deny input; SSH, lo, established/related, icmp accept; forward drop;
  output accept. Mesh forward / MASQUERADE live in a tunnel-gated `mesh.nft` loaded by
  wg-quick PostUp.
- Dev-time visibility is via SSH local forwarding over the existing jump
  (`ssh -J vega -L 8000:localhost:8000 polaris`) — service binds loopback on polaris, port
  rides the encrypted tunnel back to the dev machine. Nothing exposed.
- Depends on vega's `AllowTcpForwarding` being on (same setting that gates `-J`).

---

## Workflow shape

- **Local-first frontend.** Templates, CSS, vendored JS (htmx.min.js), static skeleton
  developed locally against a FastAPI instance with stubbed/fake mesh data.
- **HTMX = server-rendered fragments**, not a client-side SPA. Data-bound views
  (`wg show`, handshakes, current exit, log tails) only render real against the live
  backend on polaris.
- **Tracked code, not loose files.** Repo lives locally; commits and PRs happen locally;
  polaris pulls reviewed branches via `git pull`. No rsync of working trees onto the master.
- **Integration check** = run real FastAPI on polaris bound to localhost, forward back over
  the jump, verify fragments render against live data.

---

## Rules / non-negotiables

- **No root or passwordless sudo for automated tooling on polaris.** Frontend work
  (JS/HTML/CSS/templates) is unprivileged by nature and stays that way.
- **Tooling scope = the GUI project subfolder.** Launching from the project dir contains
  reach to that subtree only — not polaris's home, node configs, log-collection output, or
  anywhere an Infisical-fetched secret could materialize.
- **All commits and pushes are manual.** No automated git operations. (Maps to the Week-1
  rule — the incident was a git-push problem, not a sudo one.)
- **Backend grit = the real privileged surface.** paramiko SSH-to-nodes calls, nftables
  port-management on vega, the narrow-sudoers systemd unit — every generated line gets
  audited; stray IPv6 stripped (IPv6 is out of scope; generated drafts have leaked it).
- **FARS** (Find And Replace Secrets) applies to any config / log / output that leaves the
  box: IPs, node locations, API keys, sensitive configs.
- **Secrets live in Infisical** (platform, fetched at deploy/runtime — not a file in the
  repo). Never hardcoded. Fetched `.env` files don't land in tooling's working directory.

---

## GUI plan (current)

- **Stack:** FastAPI + HTMX; SQLite or JSON for state; **paramiko** for SSH to nodes;
  systemd unit with **narrow sudoers**.
- **Features:** live mesh status (peers, handshakes, current exit); exit-node switching;
  port management on vega's nftables; log viewer; IDS feed (later, Phase F).
- **Request-Like Port Forwarding (RLPF):** user requests a port via the GUI with a stated
  reason → triaged → **admin CLI on polaris** approves / rejects / defers via hotkeys
  (SSH in + launch the script — NOT a hosted GUI surface). Trust levels: 1 = auto-approve,
  2 = human review, 3 = reject. (From the Fall 2025 hackathon design.)
- **AI triage:** Gemini Flash API (not Flash-Lite — needs detail) scores RLPF requests
  against a pre-approved usecase list. Keys in Infisical. Gemini Flash chosen on cost.
- **AI roles in this project:** Claude = config/grit (primary). Gemini = UI/chart/frill
  (secondary).

---

## Build order (C-independent first)

1. Static skeleton + layout — templates, CSS, htmx wiring. Local, stubbed data.
2. Live mesh status — peers / handshakes / current exit, from `wg show` on polaris.
3. Log viewer — reads log-collection on polaris.
4. Exit-node switching — scaffold; full 2-exit validation gated on business node.
5. vega nftables port management — backend grit, privileged surface.
6. RLPF + Gemini-Flash triage — admin CLI path + AI scoring.
7. IDS feed — Phase F, later.

---

## Don't touch

- The floor's **SSH accept** rule and the **mesh relay accept** rule.
- The **firewalld→nft posture** / default-deny floor.
- The wg0-only binding for this GUI.
- The floor's tunnel-independence (floor stays unconditional; only mesh/forward rules are
  tunnel-scoped).
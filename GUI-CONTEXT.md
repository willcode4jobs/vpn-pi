SU495 — GUI Context (island dashboard / app, Phase E)

Lean context for GUI build sessions — the app only. FARS-clean.

What it is

Per-node web app, served on localhost over wg0 — the single pane of glass for the island.
Runs on every node (decentralized, no central host). Admin view = a URL path, same app.
Built with Claude sub-agents.

Stack

.tsx frontend (preferred over separate html/css/js) + Python backend (learnability).
Bind wg0 / localhost only — never a wide/public bind.

One screen, the two built panels

Files — the island file share. The headline island service: proof the island provides
its own internet-like services, not just a VPN tunnel. Upload/download/delete behind a
FileStore interface (app/store.py), three impls by GUI_FILES env: placeholder (in-memory,
builder PC), sqlite (real, ON POLARIS — the file authority), remote (every other node,
forwards file ops to polaris over wg0). Deployment is Option B: each node runs its OWN
backend (own UI + own identity + own local IDS); only files are central, so a file
uploaded on sirius shows on altair. The frontend is identical everywhere (same-origin
/api) and ships as a static bundle via gui/deploy/push-gui.sh. NOTE: central files make
polaris a server — a deliberate departure from "no central host," taken for scope. Auth
is still a gap — upload/delete must be gated before binding wg0.
IDS feed — host/physical security events only (auditd/udev/fail2ban: USB insertion,
console login, auth bans, unexpected reboot). Same screen as Files, by design.
Admin view (URL path, later) — RLPF port-request flow: request a port + reason → Gemini
Flash triage → approve / reject / defer (tiers: 1 auto / 2 human / 3 reject).

Cut (was scope creep)

Mesh-health and the daemon status-socket coupling are CUT. That panel read the
wg-selfheal daemon's sensor data over a unix socket, which put the GUI on the daemon's
critical path for data that doesn't exist yet (no WG tunnels on any node). The "coupling
lever" decision (read daemon socket vs. query wg directly) is therefore moot — the GUI
no longer talks to the daemon at all. See git history on branch feat/gui-files-ids.

Data source

Mock today; everything reads through one DataSource interface. The real per-node source
(wg0-bound FTP/share listing for Files; auditd/udev/fail2ban for IDS) slots in behind it
with no upstream change. Neither real backend is built yet — but unlike the daemon path,
both can be wired on a single node without any WG tunnels.

Aesthetic — non-negotiable

Ops-console, not SaaS template. No navy, no emoji, no rounded-card dashboard.
Monospace, dense legible status readout, state by color + position, not icons.
Something an admin stares at, not a landing page.
Read the frontend-design skill before generating any UI.

Build order + scope

Files first, then host-IDS sensors, then admin/RLPF. One screen, not three builds.
No hardcoded secrets — Gemini Flash key (RLPF triage) lives in Infisical.
FTP server binds wg0 only; open the control + passive-data port range on wg0 in nftables.

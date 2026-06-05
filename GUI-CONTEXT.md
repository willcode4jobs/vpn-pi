SU495 — GUI Context (mesh dashboard / app, Phase E)

Lean context for GUI build sessions — the app only. FARS-clean.

What it is

Per-node web app, served on localhost over wg0 — the single pane of glass for the island.
Runs on every node (decentralized, no central host). Admin view = a URL path, same app.
Built with Claude sub-agents.

Stack

.tsx frontend (preferred over separate html/css/js) + Python backend (learnability).
Bind wg0 / localhost only — never a wide/public bind.

One screen, four areas

Mesh health — per-peer up / stale / degraded + handshake age, from the daemon's sensor
data. A node going silent here is itself the alarm. The heart of the screen.
IDS feed — host/physical sensor events (auditd/udev: USB insertion, console logins,
unexpected reboots) + mesh anomalies (unexpected peer/handshake). Same screen as
mesh-health, by design.
Files — FTP share / write between nodes.
Admin view (URL path) — RLPF port-request flow: request a port + reason → Gemini Flash
triage → approve / reject / defer (tiers: 1 auto / 2 human / 3 reject).

Data source — the one open decision ("coupling lever")

App reads the daemon's status socket → daemon on the critical path.
App queries wg directly → daemon parallel / off-path.
Parked; decide when wiring real data. (Socket seam lands in daemon v1.1.)

Aesthetic — non-negotiable

Ops-console, not SaaS template. No navy, no emoji, no rounded-card dashboard.
Monospace, dense legible status readout, state by color + position, not icons.
Something an admin stares at, not a landing page.
Read the frontend-design skill before generating any UI.

Build order + scope

The GUI is the surface for the daemon + IDS stack — one screen, not three builds.
Skeleton first: one node, mesh-health panel + IDS feed. Files + admin after.
No hardcoded secrets — Gemini Flash key (RLPF triage) lives in Infisical.
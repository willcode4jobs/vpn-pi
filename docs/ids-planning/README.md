# IDS mesh aggregation — planning set

Planning docs for the multi-node IDS/alert layer: getting host-security events
off mock data and aggregating them on the master **without trusting the hub**.
This folder is the deliberate plan; code follows on approval.

## The problem (why this exists)

Today the IDS feed is **mock**. `gui/backend/app/main.py` hardwires
`SOURCE: DataSource = MockDataSource()`, and `MockDataSource.ids()`
(`gui/backend/app/sources/mock.py`) returns five synthetic seed events. There is
no real sensor read anywhere in the backend, and the daemon status-socket source
that once fed it was **cut** (`gui/backend/app/sources/base.py` docstring).

We want real, per-node host-security alerts (auditd / fail2ban / udev / boots)
collected into one **mesh view on the master (polaris)** — the hardened,
out-of-data-path control node — while the **hub (vega)** stays a blind relay that
buffers ciphertext it cannot read. This is the design the worklog already
committed to (`docs/worklog-2026-06-05.md`, "IDS mesh view → polaris, not vega").

## Decision log (settled)

| Decision | Choice | Why |
|---|---|---|
| Real source vs mock | Build a real per-node `HostDataSource` (journald) | Mock is a placeholder; the seam (`DataSource`) is stable |
| Where alerts aggregate | **Master (polaris)**, never the hub | Security data stays off the edge; master is hardened + out of data path |
| How alerts traverse | **Hub blind-relay, E2E encrypted to the master** | Spoke↔spoke is dead; the hub is the only universal rendezvous but must not read alerts |
| Direction | **Master pulls** from the hub buffer | Master↔hub is the reliable path; matches worklog intent |
| Aggregate view access | **Same GUI, served by the master**, browser-viewable via SSH local-forward, gated by a view-password | Keeps the hub blind; same React app as the fileshare; matches "Master admin via SSH/CLI" (CLAUDE.md) |
| Crypto library | **PyNaCl** (`SealedBox` + Ed25519) | Misuse-resistant; purpose-built. `cryptography` is the fallback if wheels fight us (§03) |
| `node` on `IdsEvent` | **Add an explicit field**, set from the verified signing key | Separates "who reported" from "what it's about"; trustworthy attribution, not a free-text parse (§01) |
| IDS scope | **Host events + daemon tunnel warnings** | Host: USB/LOGIN/AUTH/REBOOT (journald). Daemon: per-node read of the `wg-selfheal` status socket (degraded/stale → `TUNNEL` alerts), shipped via the same relay, aggregated mesh-wide. Best-effort/degrade-to-empty — NOT the cut GUI-critical-path live-mesh feed (§01 §3.1a) |
| Topology | **Hub-and-spoke, settled** — polaris (master) + vega (hub) both load-bearing | spoke↔spoke is dead; a P2P pivot would gut blind-relay + master-pull (see worklog 2026-06-06) |

## Resolved during planning (was: open)

1. **Crypto library = PyNaCl.** Test wheels on a Pi + sirius (py3.12 venv) before
   pinning. §03.
2. **Mesh view = same GUI, served by the master, browser-viewable, password-gated.**
   The fileshare GUI is hub-served; rendering the mesh view there would force the
   hub to decrypt and break blind-relay. Instead the master serves the *same*
   React app over an SSH local-forward, with a session **view-password** on the
   IDS aggregate. Hub stays blind. §04 §6, §02 §9.
3. **Add `node` to `IdsEvent`**, populated from the verified identity. §01 §4.

## The documents

| Doc | What it covers |
|---|---|
| [01-architecture.md](01-architecture.md) | Components, data flow, the seams we reuse, the exact code touch-points |
| [02-threat-model.md](02-threat-model.md) | Trust boundaries, what blind-relay buys, metadata leak + alert-suppression + replay |
| [03-crypto-and-keys.md](03-crypto-and-keys.md) | Envelope format, library choice, key generation / distribution / registry |
| [04-connectivity-and-deployment.md](04-connectivity-and-deployment.md) | Topology reality, the relay port, per-node deploy (incl. sirius SELinux), admin access |
| [05-implementation-plan.md](05-implementation-plan.md) | Build sequence, file-by-file changes, verification, honest estimate |
| [BUILD-STATUS.md](BUILD-STATUS.md) | What's actually implemented vs the plan (live status) |

Operational: [`gui/deploy/RUNBOOK-ids-nodes.md`](../../gui/deploy/RUNBOOK-ids-nodes.md)
— set up a Linux node for the IDS mesh, including the SELinux policy for enforcing
nodes (sirius).

## Status

**Implementation underway on `feat/ids-mesh`.** Steps 1–3 (real local feed,
crypto envelope + registry, hub blind relay) are committed and unit-tested (34
tests); Steps 4–5 (shipper + master aggregator, then multi-node polish +
view-password) are pending. See [BUILD-STATUS.md](BUILD-STATUS.md) for detail.
Planning docs were committed on `docs/ids-planning` (`dox:`); code is `feat:` on
`feat/ids-mesh`.

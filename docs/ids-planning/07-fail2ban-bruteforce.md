# 07 — fail2ban brute-force integration

Three layers on top of the existing ban events (`feat:` c0fbe75 + 4b6089c).
Always-on, degrade-to-empty where fail2ban isn't present.

## 1. What it adds

| Layer | Where | Renders as |
|---|---|---|
| **Attack timeline** | `HostDataSource._bruteforce_events` | one `AUTH/WARN` per source IP — the failed-auth buildup |
| **Enriched bans** | `HostDataSource._auth_events` | the ban `AUTH/CRIT`, now carrying the jail (`[sshd]`) + the folded-in failure count |
| **Live JAILS panel** | `app/sources/fail2ban.py` → `GET /api/jails` → `JailsPanel.tsx` | who is *currently* banned (live state) |

The IDS feed reads as a narrative: several `WARN` attempts from an IP, then the
`CRIT` ban for that same IP with the count — e.g.

```
[WARN] 203.0.113.77   sshd: 7 failed ssh auths from 203.0.113.77 (user root)
[CRIT] 203.0.113.77   fail2ban: banned 203.0.113.77 [sshd] — 7 failed sshd auths
```

Both flow through the mesh, so the master's aggregate shows them attributed to the
originating node.

## 2. Scope: JAILS is per-node, the feed is mesh-wide

The **JAILS panel shows _this node's_ fail2ban state** (live current bans), **not**
a mesh aggregate. On the master it shows polaris's own jails — usually empty, since
the master is control-plane and attacks land on the edge. The **ban events** from
the edge still appear in the master's IDS feed (`CRIT`, attributed). So:

- *who is locked out right now on a node* → that node's JAILS panel;
- *the history of bans/attempts across the mesh* → the master's IDS feed.

The panel is labeled **"this node"** so the scope difference doesn't read as a
contradiction. Mesh-wide jail *state* would mean shipping status through the relay
— a future enhancement, intentionally not done (see `06-views-and-attribution.md`
for the local-vs-mesh model).

## 3. Permissions: none added — journal-derived

**No privilege elevation, no sudoers.** `fail2ban-client` would need a root-only
socket; instead `Fail2banSource` reads `journalctl -u fail2ban` and reconstructs
current state by replaying **Ban − Unban** in the window (last action per
`(jail, ip)` wins). It uses only the `systemd-journal` group the service already
has for the IDS sensors (RUNBOOK §4) — nothing new to grant, no `sudo` rule to
get wrong or abuse.

Tradeoff (accepted for zero added privilege):
- **window-bounded** — a ban older than `GUI_IDS_SINCE` (default `-24h`) that is
  still active won't appear; widen the window if your `bantime` is longer.
- `total_banned` = Ban events seen **in the window**, not fail2ban's all-time total.

`/api/jails` degrades to `[]` (panel: "no jails reporting") if the journal is
unreadable; the ban/attempt *events* in the IDS feed are unaffected.

## 4. Noise + cost control (from the debug pass)

- Attempts are **aggregated per IP** (one `WARN`, not one-per-attempt) with a
  **stable id** (`bruteforce-<ip>`) so a new attempt doesn't re-ship a "new" event.
- `/api/ids` is **cached ~3s** and journal queries are **memoized per compute**, so
  the 2s UI poll doesn't storm `journalctl`/`fail2ban-client` on a Pi.

## 5. Files & tests
- Backend: `app/sources/host.py` (`_bruteforce_events`, `_failed_auths`, enriched
  `_auth_events`), `app/sources/fail2ban.py` (`Fail2banSource`), `app/models.py`
  (`JailStatus`), `app/main.py` (`/api/jails`).
- Frontend: `components/JailsPanel.tsx`, `useJails` (`api.ts`), `JailStatus`
  (`types.ts`), `App.tsx`.
- Tests: `tests/test_host_source.py` (per-IP aggregation, enriched ban, stable id),
  `tests/test_fail2ban.py` (parse, degrade-to-empty).

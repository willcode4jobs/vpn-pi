# Daemon Alert Layer (Stage 5) — build context

**Job:** emit a structured journald event on **state transition only**, latch `degraded` on
breaker trip, and make the per-tick observe snapshot opt-in. Default output = transitions only.

**Plugs between `decide` and journald. Consume these, don't rewrite:**
- `internal/wg/read.go` — per-peer handshake age + endpoint via wgctrl/netlink. Read-only.
- `internal/heal` (decide) — pure `[]PeerState + role + log → []Action`; owns threshold,
  role ladder, circuit breaker.

**States:**
- `ok` — handshake fresh.
- `stale` — handshake age ≥ threshold (150–180s; renews ~2 min). Per-peer, never per-interface.
- `degraded` — breaker latched. **decide owns the latch; alert layer only reflects it.**
- `recovered` — was stale/degraded, now ok. One-shot event, then back to `ok`.

Derive state from what `decide` already determines — don't re-implement the threshold/breaker.
If there's no clean per-peer status to read, add a status enum to the decide core (keep the
logic there).

**Build it as:**
- A pure fn: `last-state map + []PeerState → []Event`. Unit-test with synthetic peers; keep
  the existing 14 + 3 green.
- Structured journald fields (peer id, role, old→new state, handshake age, endpoint, ts) —
  not free text, so the later status socket can consume them.
- **Emit only — no act path** (spoke bounce is the next stage). **No new privilege**
  (`CAP_NET_ADMIN` already covers it). No `wg show` text parsing.

**Done:** transitions appear in journald, unchanged ticks emit nothing, breaker shows
`degraded`→`recovered`, snapshot is opt-in, new tests green.
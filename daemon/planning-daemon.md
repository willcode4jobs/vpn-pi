# Daemon Planning — wg-selfheal

Working planning doc for the build. Decisions get made here, then flow into code
and into `DAEMON-CONTEXT.md`. Living document — edit freely.

---

## Build status (what's done vs. pending)

| Slice | Build-order step | State |
|---|---|---|
| Decision core (`internal/heal`) | 2 — the heart | ✅ done (decide + Classify), 21 tests |
| Read path (`internal/wg/read.go`) | 1 — netlink read | ✅ done, 3 tests |
| Main loop + flags + observe snapshot | — wiring | ✅ done |
| Deploy artifacts (unit + install.sh + push.sh) | 4 — systemd (partial) | ✅ built + used |
| **Read-only deploy to vega + sirius** | 6 — integration (partial) | ✅ deployed + running (old read-only binary) |
| Alert layer — transitions (`internal/alert`) | 5 | ✅ first cut, 11 tests |
| **Act path** — re-assert (`internal/wg/act.go`) | 3 | ✅ first cut — netlink re-assert; bounce deferred |
| systemd `Type=notify` + `WatchdogSec` | 4 | 🔴 not started |
| Status socket (the journald seam) | 5 (v1.1) | 🔴 not started |

> ⚠️ The **non-read-only binary built 2026-06-04 is NOT deployed.** vega + sirius
> still run the old read-only binary from the overnight run. Deploy/iterate the
> new one in the AM.

Privilege model in place: `DynamicUser` + `CAP_NET_ADMIN` only, no root/sudo,
full systemd sandbox. The read-only deploy validates it end-to-end (reading wg
over netlink already needs the cap).

---

## ⚠️ Blocking finding: WireGuard endpoints are STATIC IPs

> Confirmed by William: the WireGuard tunnel endpoint IPs are static, and the
> nodes' local LAN IPs are static (DHCP reservations).

This invalidates the headline remediation baked into `DAEMON-CONTEXT.md`.

### What it kills

- `DAEMON-CONTEXT.md` says remediation = **"re-resolve + `wg set peer endpoint`"**,
  where *re-resolve* = a DNS/DDNS re-lookup to catch a **roaming** endpoint IP.
- With **static** endpoints there is no hostname to re-resolve and the IP never
  changes. **DNS re-resolution is dead as a mechanism.**
- The DDNS / "home now residential dynamic IP" assumption from the architecture
  pivot does not apply to the WireGuard endpoints.

### What survives

- `ActionReResolve` in the decision core is structurally fine, but its *meaning*
  collapses from "re-lookup DNS" → "re-assert the known static endpoint" — a much
  weaker poke (re-pushing an unchanged IP).
- The role ladder (re-assert → spoke-bounce → alert) and circuit breaker are
  unaffected — they're about *how hard* to try, not *what* the action resolves.

---

## ✅ RESOLVED: keepalive on, failure = power outage

Answers (William, 2026-06-03):
1. **`PersistentKeepalive` IS set** → WG already re-handshakes through transient
   drops / NAT timeouts on its own. The daemon must NOT duplicate that; its
   action surface is genuinely small.
2. **The real failure seen: a power outage → WG didn't recover** ("wg crashes"),
   before the daemon existed.

### Honest read: the daemon is NOT the primary fix for that failure
- A power outage kills the node — and the daemon on it. It can't heal a node
  that has no power. It only helps a node that is *up* but whose tunnel is sick.
- "Came back wrong after power return" is a **boot-resilience problem**, owned by
  systemd, not by a runtime watchdog. The real fix:
  **`wg-quick@wg0` enabled + `After=network-online.target` + `Restart=on-failure`.**
  Verify this on vega + sirius regardless of the daemon — it's the bigger lever.
- With keepalive on + static endpoints, once both ends are powered and wg0 is up,
  WG reconnects itself. The residual gap the daemon covers is narrow.

### Locked direction: B-spine + targeted, role-gated recovery
Detection/alert is the spine; recovery is a narrow escalation for the genuinely
stuck post-recovery case (e.g. kernel endpoint cleared by an ungraceful crash, so
keepalive has nowhere to send).

- `ActionReResolve` → **re-assert the static endpoint** (no DNS). Per-peer, safe
  on relay. Fixes a cleared/wrong kernel endpoint so keepalive can resume.
- `ActionBounceInterface` → **wg-quick down/up**, the real crash-recovery — but
  **spoke only** (leaf; severs only its own tunnels). Relay never bounces.
- `ActionAlert` → latch degraded + surface.

The decision core already built encodes exactly this ladder — only
`ActionReResolve`'s *implementation* changes from "DNS re-lookup" to "re-assert
static endpoint."

### Endpoint source: cache-while-healthy (no wg0.conf parsing)
Because endpoints are **static**, the daemon snapshots each peer's endpoint while
that peer is *healthy* and re-asserts the cached value if the kernel later loses
it. This:
- needs **no `wg0.conf` access** (avoids the `600 root` permission grant), and
- can't fabricate an endpoint it never observed → if a peer was never seen
  healthy (cold start, already broken), it **alerts** instead of guessing.

---

## Night-1 read-only findings (2026-06-03)

Deployed read-only to vega (relay) + sirius (spoke). altair parked (it's a macOS
box running the **GUI WireGuard app** = sandboxed network extension; `wgctrl`
can't read it — not a rebuild, a dead-end port. Linux ELF won't run there anyway).

1. **Sandbox validated on both distros.** Service `active (running)` on vega
   (Debian/Pi OS) and sirius (**Fedora, SELinux `Enforcing`**) — the hardened
   unit (`DynamicUser` + `CAP_NET_ADMIN` + seccomp/MDWE) reads wg fine under
   SELinux-enforcing. ~2.3 MB RSS. The biggest deployment risk is retired.
2. **sirius:** fully healthy, 1 peer, no issues.
3. **vega:** 4 healthy peers + 2 flagged:
   - `192.168.1.72:51820` (polaris) — *has* endpoint, never handshaked →
     **real broken tunnel** (William investigating whether vega↔polaris should be up).
   - `endpoint=""` — no endpoint, never handshaked → **false positive**. This is a
     passive / dial-in peer (spoke connects inbound; relay never dials it).
4. **🔧 Decision-core refinement (from #3):** a peer with **no actionable endpoint**
   must NOT be flagged for re-resolve — the relay can't dial/re-assert what it has
   no endpoint for. Treat "stale + no endpoint" as **alert-only / skip**, not
   remediate. Fits cache-while-healthy: never-seen-healthy + no endpoint → can't
   act → alert. Also kills the per-tick `would remediate` log spam on relays.

## Stage 5 (alert) + act path — first cut (2026-06-04, for AM review)

Built non-read-only per William's call ("changed in the AM regardless"). All on
the Mac; nothing deployed.

- **Alert layer (`internal/alert`):** pure `Diff(last, statuses, now) → (events,
  next)`. Emits one structured journald event per **state transition** only;
  unchanged ticks are silent. `recovered` = return to ok from stale/degraded.
- **`heal.Classify`:** per-peer `State` (ok/stale/degraded) derived by reusing
  `decidePeer` — threshold/breaker stay in one place.
- **Act path (`internal/wg/act.go`):** `ReassertEndpoint` re-pushes a peer's
  static endpoint via netlink (`ConfigureDevice`, `UpdateOnly`) — in-cap,
  per-peer, relay-safe. `main` caches each peer's endpoint while healthy and
  re-asserts the cached value when it goes stale; executed re-asserts record
  history so the breaker → degraded works live.
- **Flags:** `--dry-run` (classify + emit, never touch tunnel), `--snapshot`
  (old per-tick observe, now opt-in; default = transitions only).

### Decisions to revisit in the AM
1. **`MaxBounce = 0` at runtime.** Interface-bounce needs a privileged `wg-quick`
   restart (> CAP_NET_ADMIN); the sandbox can't do it. So spokes escalate
   re-assert → **degraded** instead. **Resolve the bounce privilege path**
   (systemd-run? a tiny privileged helper? polaris-triggered restart?).
2. **No-endpoint peers** (passive/inbound, e.g. the night-1 false positive): a
   re-assert with no cached endpoint is skipped quietly. They sit `stale` and
   emit one transition — not yet a distinct "passive/un-actionable" status.
3. **Default mode:** built to *act* by default (`--dry-run` to opt out). Decide
   whether first AM deploy should go out `--dry-run` to watch real transitions
   before it re-asserts anything live.

## Immediate next steps

1. **Overnight read-only run** (deploying tonight) → confirm sandbox + read path
   on live peers; gather real staleness behavior.
2. **Verify wg-quick boot resilience** on vega + sirius (enabled, network-online
   ordering, `Restart=on-failure`) — the actual fix for the power-outage class,
   and arguably higher priority than the daemon's act path.
3. **Build the act path** per the locked direction: endpoint cache → re-assert →
   spoke-only bounce → alert. Decide-core stays pure/unit-tested; the act touches
   the live tunnel, so validate carefully on the nodes.
4. **Fix `DAEMON-CONTEXT.md`** — replace DDNS/DNS-re-resolve language with
   re-assert-static-endpoint + the cache-while-healthy mechanism.

---

## Parked / later

- systemd `Type=notify` + `WatchdogSec` (the daemon watches the mesh; systemd
  watches the daemon).
- v1.1 wg0-bound status socket (the structured-journald seam → app live-status +
  IDS correlator).
- Quiet the verbose per-tick `observe` snapshot once the act path lands.
- Fleet rollout beyond vega + sirius (gated on Phase G deployment automation).

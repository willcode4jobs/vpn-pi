# Daemon Planning — wg-selfheal

Working planning doc for the build. Decisions get made here, then flow into code
and into `DAEMON-CONTEXT.md`. Living document — edit freely.

---

## Build status (what's done vs. pending)

| Slice | Build-order step | State |
|---|---|---|
| Decision core (`internal/heal`) | 2 — the heart | ✅ done, 14 tests green |
| Read path (`internal/wg/read.go`) | 1 — netlink read | ✅ done, 3 tests green |
| Main loop + flags + observe snapshot | — wiring | ✅ done, smoke-tested |
| Deploy artifacts (unit + install.sh + push.sh) | 4 — systemd (partial) | ✅ built, **not yet deployed** |
| **Read-only deploy to vega + sirius** | 6 — integration (partial) | ⏳ ready to run |
| **Act path** (`wg set`, role-gated) | 3 | 🔴 blocked — see open decision |
| systemd `Type=notify` + `WatchdogSec` | 4 | 🔴 not started |
| Structured journald / status-socket seam | 5 | 🔴 not started |

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

## 🔑 Open decision: with static endpoints, what does self-heal actually heal?

When a static-endpoint tunnel goes stale, the usual causes are a transient
network drop or an expired NAT/conntrack mapping. WireGuard with
`PersistentKeepalive` **already re-handshakes through most of those on its own.**
Re-pushing an unchanged static IP does little WG isn't already doing.

That doesn't make the daemon useless — it shifts where its value is:

- **toward** detection / alerting (the v1.1 sensor role), and the **last-resort
  spoke bounce** for cases WG genuinely can't recover from,
- **away from** clever endpoint juggling (which the static-IP reality rules out).

### Two questions that decide the act-path shape

1. **Is `PersistentKeepalive` set on the peers?** (e.g. `PersistentKeepalive = 25`)
   - If **yes** → WG self-heals transients; daemon action surface shrinks; lean
     toward alert + bounce-only-as-last-resort.
   - If **no** → re-asserting endpoint / nudging handshakes has more to do.
2. **What failure have you actually *seen*** that this should fix?
   - The vega `wg0` bounce that severed peers was self-inflicted, not a thing the
     daemon recovers.
   - Is there a real "tunnel died and stayed dead until I intervened" event, or is
     this still defending against a theoretical?

> Goal: build the act path against a failure mode actually hit, not against the
> DDNS-roaming scenario the static-IP reality just ruled out.

---

## Candidate act-path directions (pick after the two questions)

### A. Re-assert + bounce (if keepalive is off / real dead-tunnel events exist)
- `ActionReResolve` → `wg set <if> peer <pub> endpoint <static-ip:port>` to reset
  WG handshake state and correct a cleared/wrong kernel endpoint.
- Endpoint source: needs the configured static value. Options:
  - re-assert the kernel's *current* endpoint (config-free, but useless if the
    kernel endpoint got cleared — the exact failure we'd want to fix), or
  - parse `wg0.conf` once at startup into a `pubkey → endpoint` map (source of
    truth; needs a deploy-time group-read grant since it's `600 root`).
- Spoke bounce as last resort; relay never bounces (alert instead).

### B. Detect + alert (if keepalive already covers transients)
- Daemon becomes primarily a **sensor**: detect staleness, surface it, latch
  degraded. Spoke bounce remains the only autonomous action, last-resort.
- Smaller act surface, closer to the v1.1 "daemon = sensor, polaris = correlator"
  framing — arguably the more honest v1 given static endpoints + keepalive.

---

## Immediate next steps

1. **Run the read-only deploy** (`./deploy/push.sh vega arm64 relay`,
   `./deploy/push.sh sirius amd64 spoke`) — validates sandbox + read path on
   live peers, independent of the act-path decision.
2. **Answer the two questions** (keepalive? real failure seen?).
3. **Pick direction A or B**, then build the act path.
4. **Fix `DAEMON-CONTEXT.md`** — strip the DDNS/DNS-re-resolve language to match
   the static-endpoint reality and the chosen direction.

---

## Parked / later

- systemd `Type=notify` + `WatchdogSec` (the daemon watches the mesh; systemd
  watches the daemon).
- v1.1 wg0-bound status socket (the structured-journald seam → app live-status +
  IDS correlator).
- Quiet the verbose per-tick `observe` snapshot once the act path lands.
- Fleet rollout beyond vega + sirius (gated on Phase G deployment automation).

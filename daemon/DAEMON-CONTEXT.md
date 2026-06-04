# SU495 — Daemon Build Context (self-heal WG watchdog, Phase H)

> Scope: **self-heal WireGuard watchdog, v1.** Build on the **Mac**, deploy **binaries** to nodes.
> Commits/pushes stay manual.

---

## What it is

- Per-node autonomous **WireGuard self-heal daemon.** **Go**, single static binary
  (cross-compiles arm64 / x86 / macOS). Built in-house — not a script, not a third-party repo.
  systemd manages it (`Type=notify` + `WatchdogSec`) but it isn't dependent on systemd.
- Delivers the **connection layer only** of the three-layer heal (detect dead tunnels, reconnect).
  Network-layer (route reconverge) and service-layer (app failover) are **separate builds** —
  don't assume the daemon covers all three.
- **v1 targets the two live nodes — vega + sirius.** Fleet rollout waits on Phase G
  (deployment automation).

## Architecture (v1)

Loop, per node: **read → decide → act → read.**

- **Read** — `wgctrl`/netlink reads per-peer state (handshake age, endpoint). No `wg show` text
  parsing. Read-only, zero lockout risk.
- **Decide** — a **pure function**: `[]PeerState + node role + recent-action log → []Action`.
  Holds threshold + role ladder + circuit breaker. Pure = unit-testable against synthetic peers,
  no live wg.
- **Act** — `wg set <if> peer <pub> endpoint <ip:port>`, **role-gated**. Only part that touches the
  live tunnel.
- **Privilege:** dedicated user + **`CAP_NET_ADMIN`**. NOT root, NOT sudo — but not zero (needs the
  cap to read/set wg). That capability is the least-privilege win.
- **Role-aware remediation:**
  - *spoke* → re-resolve + `wg set peer endpoint`; full bounce only as last resort.
  - *vega (relay/bastion)* → conservative: per-peer re-resolve only. **Never autonomously bounce the
    interface** — a `wg-quick down/up` on the hub severs every peer and re-runs mesh.nft PostUp/Down
    (lived this 2026-06). Alert instead.
- **Circuit breaker:** cap attempts/peer/window, then latch "degraded" + surface. No flapping.
- **Threshold:** handshakes renew ~2 min under keepalive → staleness window **≥150–180s** or it
  flaps. Act **per-peer**, never per-interface.
- **Logging:** structured **journald** — the seam for the v1.1 status socket.

## v1 build order

1. `wgctrl` read path (per-peer staleness).
2. **Decision core** — pure, unit-tested: threshold + role ladder + breaker. ← the heart.
3. Act path (`wg set endpoint`, role-gated).
4. systemd integration (`Type=notify`, `WatchdogSec`, `CAP_NET_ADMIN`, dedicated user).
5. Structured journald logging (seam for v1.1 status socket).
6. Integration on vega + sirius; forced-stale-peer test; confirm `ip_forward`=1, SELinux clean.

## Build / VC / deploy pipeline

- **Code lives on the Mac** (the builder), in the **mesh repo, `daemon/` subdir, own `go.mod`.**
- **Git tracks source only.** `dist/` (binaries) is **gitignored** — artifacts aren't VC, rebuild on
  demand. Versioned binaries → GitHub release assets, never the repo tree.
- **Dev loop (Mac):** edit → `go test ./...` (decision core needs no live wg) → `go build` smoke.
- **Cross-compile (static):** `CGO_ENABLED=0` → fully static, no per-host library matching
  (wgctrl is pure-Go netlink).
  ```bash
  CGO_ENABLED=0 GOOS=linux  GOARCH=arm64 go build -o dist/wg-selfheal-arm64  ./daemon  # vega, polaris
  CGO_ENABLED=0 GOOS=linux  GOARCH=amd64 go build -o dist/wg-selfheal-amd64  ./daemon  # sirius
  CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o dist/wg-selfheal-darwin ./daemon  # Mac local test
  ```
- **Deploy = push the BINARY, not source.** `scp` the per-arch binary + systemd unit over **wg0**,
  install, restart. Nodes need **no Go, no git, no compiler** (matches the hardening "no compilers on
  nodes" call). This is why Go was chosen.
- The manual scp-and-install **is the first slice of Phase G** deployment automation — wrap in
  rsync/Ansible-over-wg0 later.

## Constraints / conventions (carry-over)

- **Agents (Claude Code) live on the Mac only.** Removed from the Pis on purpose — dev/prod
  separation; the nodes are the hardened trust boundary, no agent there. **No root / passwordless
  sudo. Commits + pushes manual** (an agent pushed secrets once when given the reins).
- **Daemon never gets root** — dedicated user + `CAP_NET_ADMIN` only.
- **`ip_forward` stays 1** on relay nodes — the daemon (or any sysctl) must never zero it; that
  silently kills the mesh relay.
- **Deploy keys** are per-repo / per-node; the daemon ships as a **binary over the mesh**, not a
  git-pull onto nodes.

## Deferred / open

- **v1.1:** wg0-bound **status socket** (the structured-journald seam) → feeds app live-status + the
  IDS correlator (daemon = sensor, polaris = correlator).
- **Coupling lever (decide on the Gantt, not now):** app reads the daemon socket → daemon **on** the
  critical path; app queries wg directly → daemon stays **parallel / off-path.**
- Fleet rollout beyond vega + sirius gated on Phase G.
# vpn-pi — a self-contained "island internet"

A WireGuard mesh of small nodes (Raspberry Pis + a couple of Macs) that gives a private
group its own little internet: encrypted node-to-node networking, a shared file service,
direct sealed messaging, mesh-wide intrusion detection, and an **LLM-gated door to the
real internet** — without depending on the public internet for anything but the
underlying transport.

Course project (SU495). Built with heavy use of Claude / coding agents.

> **Phase Two is the current build**: everything below runs today as `islandd`, a single
> self-contained binary per node, in [`island/`](island/). Phase One (the Python/React
> prototype it replaced) is kept for reference in [`gui-and-app/`](gui-and-app/) — see
> [Phase One (legacy)](#phase-one-legacy) at the bottom.

---

## What's done (Phase Two — final)

### `islandd` — the app ([`island/`](island/))

One TypeScript-on-Bun process per node, compiled to a self-contained binary and bound to
`wg0` — **the tunnel is the auth boundary**. Each binary serves the user app (`/`) and the
admin console (`/admin`) from a single bundled SPA. Feature-complete:

- **Crypto core** — Ed25519 sign + X25519 seal (libsodium), byte-compatible with Phase
  One's Python envelope format.
- **Friending** — the *only* authorization primitive on the island. A four-step
  token → receive → accept → confirm handshake; removal is mutual (revoking a friend
  revokes both sides); the admin can revoke but can never forge a friendship.
- **Friend codes + registry** — human-shareable `ISL-…` codes, with polaris hosting the
  mesh directory.
- **File share** — durable SQLite store on vega; spokes proxy to it transparently.
  Access is operator-or-friend, identified by wg0 IP.
- **Messaging** — direct peer-to-peer sealed messages between friends.
- **Internet gate** — see [the LLM gate](#the-llm-gate) below. Deployed and
  operationally tested end-to-end.
- **IDS / Security feed** — every node collects fail2ban hits, wg link health, and
  wg-selfheal events, signs them, and reports to the collector on polaris; the admin
  **Security** tab shows the mesh-wide feed plus a full per-peer status roster.
- **Admin surface** — friends/revocation, gate control, security feed, per-node sysinfo,
  all gated by operator/admin auth and rate-limited.

### The LLM gate

The island defaults to **no internet egress**. Opening the door is a ceremony no single
component can perform alone:

1. The admin app on **builder** (the only place the admin signing key exists) mints a
   signed, sealed canary (`GREEN18`) and POSTs it to vega.
2. **vega** verifies four crypto checks (signature, seal, freshness, keyword).
3. A **local Llama** — Llama 3.2 3B Instruct, Q4_K_M GGUF served by llama.cpp
   `llama-server` on vega's loopback (`127.0.0.1:8080`), answer constrained to YES/NO by
   a GBNF grammar — gives the final approval. Unreachable or ambiguous = fail-safe DENY.
4. The pinned root helper **`island-gate`** (the only thing allowed to touch nftables)
   flips the egress rule; the gate **auto-recloses after 45 minutes**.

The model was self-converted from Meta's original weights for provenance and lives only
on vega, loopback-only.

### `wg-selfheal` — the daemon ([`daemon/`](daemon/))

A per-node Go watchdog (Linux nodes) that keeps the mesh honest and feeds the IDS:

- Reads WireGuard handshake liveness via netlink and classifies every peer on a
  time-tiered ladder: **ok → stale (150 s) → degraded (180 s) → restored** (with a 30 s
  health hold), tuned to sit above WireGuard's ~120 s rekey envelope.
- Emits signed JSON state-transitions to journald; `islandd` folds them into the
  mesh-wide security feed (peers identified by wg0 IP).
- **Remediates**: re-resolves stale peers' endpoints, conservatively gated (180 s +
  circuit breaker). Runs as `relay` on vega (never bounces the hub) and `spoke`
  elsewhere. `go test ./...` passes.

---

## Run it (quickstart — any machine, no nodes needed)

`islandd` has a full mock mode (in-memory store, synthetic peers/IDS feed, auto-approving
mock LLM), so the whole app is demonstrable on a laptop with only [Bun](https://bun.sh)
installed:

```bash
git clone https://github.com/willcode4jobs/vpn-pi.git
cd vpn-pi/island
bun install
bun run dev          # then open the URL it prints — user app at /, admin at /admin
```

Run the tests:

```bash
cd island && bun run typecheck && bun test    # app (TypeScript)
cd daemon && go test ./...                    # daemon (Go)
```

Build the real per-arch binaries:

```bash
cd island && bun run build:all               # dist/islandd-{arm64,x64,mac}
```

Deploy is `island/deploy/push.sh <node> dist/islandd-<arch>` (systemd on the Pis, a
LaunchAgent on the macOS node); node-by-node runbooks live in
[`island/deploy/`](island/deploy/).

---

## Where things are

| Path | What's there |
|---|---|
| [`island/`](island/) | **The Phase Two app** — `islandd` source (`src/`), single-file SPA (`web/`), tests (`test/`), deploy scripts + runbooks (`deploy/`) |
| [`daemon/`](daemon/) | **wg-selfheal** — Go tunnel-healing watchdog + IDS sensor |
| [`pi-deployment/`](pi-deployment/) | node hardening — default-deny nftables, fail2ban, key-only SSH |
| [`docs/`](docs/) | planning, runbooks, flowcharts, `wg-templates/` (mesh configs), worklogs |
| [`gui-and-app/`](gui-and-app/) | Phase One legacy (FastAPI + React) — superseded, kept for reference |
| [`archive/`](archive/) | older single-exit-node prototype |
| [`newContextFile.md`](newContextFile.md) | the Phase Two rewrite brief |

---

## Topology — hub and spoke

Every node holds a WireGuard tunnel to **one hub** (vega); the hub relays traffic between
spokes (no direct spoke-to-spoke tunnels). Dual-stack: IPv4 `10.42.0.0/24` + IPv6 ULA
`fd49:2977:3d2f::/64`, hosts numbered so `::N` matches `10.42.0.N`.

```
                vega (HUB)  10.42.0.2  ── only public-facing node; gate + Llama live here
                │     │      │      │
          polaris  sirius  altair  builder        spokes peer ONLY with vega;
         10.42.0.1 .5      .4      .3             spoke↔spoke is relayed by the hub
```

| Node | wg0 | role |
|---|---|---|
| **vega** | 10.42.0.2 | **hub** — file authority (SQLite), gate node, local Llama, wg-selfheal *relay* |
| **polaris** | 10.42.0.1 | friend-code registry, IDS collector; a spoke on purpose, out of the data path |
| **sirius** | 10.42.0.5 | x86-64 Linux spoke, wg-selfheal sensor |
| **altair** | 10.42.0.4 | macOS spoke (`islandd` via LaunchAgent; no Go daemon on macOS) |
| **builder** | 10.42.0.3 | Mac dev box — the **admin app**, sole holder of the canary signing key; roaming, vega-relayed |

**Why polaris isn't the hub:** a WireGuard hub decrypts everything it relays, so it sits
in the data path. The control plane (registry, IDS collector) should only see control
traffic — so vega (the edge, already in the data path) is the hub and polaris stays a spoke.

**Least privilege, everywhere:** the admin signing key never leaves builder; the model
only listens on vega's loopback; `islandd` runs unprivileged (link status comes from the
wg-selfheal journal, not `wg show`); only the pinned `island-gate` helper touches nftables;
no compiler is installed on vega.

---

## Phase One (legacy)

The first build — a FastAPI + React ops console per node with the original file share and
the blind-relay IDS alert path — lives in [`gui-and-app/`](gui-and-app/) and is described
by [`phaseOneRunbook.md`](phaseOneRunbook.md) and [`CODE-MAP.md`](CODE-MAP.md). Both
documents describe Phase One paths and the old node table only; for anything current,
trust this README and [`island/`](island/).

Repo conventions: [`docs/gitpractice.md`](docs/gitpractice.md).

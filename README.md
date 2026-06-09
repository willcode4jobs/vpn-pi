# vpn-pi — a self-contained "island internet"

A WireGuard mesh of small nodes (Raspberry Pis + a couple of personal machines) that
gives a private group its own little internet: encrypted node-to-node networking, a
shared file service, and network-level intrusion detection — without depending on the
public internet for anything but the underlying transport.

Course project (SU495). Built with heavy use of Claude / coding agents.

> **Phase One** — the build is *up to the GUI*: a hardened hub-and-spoke mesh running
> its first island service. To run it + how it meets the submission requirements, see
> [`phaseOneRunbook.md`](phaseOneRunbook.md). Per-file code map: [`CODE-MAP.md`](CODE-MAP.md).

---

## What's done (Phase One)

- **WireGuard mesh** (kernel-space) — dual-stack hub-and-spoke transport; configs +
  walkthrough in [`docs/wg-templates/`](docs/wg-templates/).
- **Node hardening** (`pi-deployment/harden-base.sh`) — default-deny nftables,
  fail2ban, key-only SSH, unattended security upgrades.
- **IDS GUI** ([`gui/`](gui/)) — FastAPI backend + React frontend, one per node. A
  wg0-bound **file share** (central SQLite store on vega) and a host-security **IDS
  feed** with a **blind-relay** alert path: nodes *sign-then-seal* alerts, the hub
  buffers opaque blobs, and only the master decrypts + verifies + aggregates. It's
  the first proof the island provides its own services, not just a tunnel.

---

## Topology — hub and spoke

Every node holds a WireGuard tunnel to **one hub**; the hub relays traffic between
spokes (no direct spoke-to-spoke tunnels). Dual-stack: IPv4 `10.42.0.0/24` + IPv6 ULA
`fd49:2977:3d2f::/64`, hosts numbered so `::N` matches `10.42.0.N`.

```
                vega (HUB)  10.42.0.2 / fd49:2977:3d2f::2  ── only public-facing node
                │     │      │      │
          polaris  sirius  altair  builder        spokes peer ONLY with vega;
         10.42.0.1 .5      .4      .6             spoke↔spoke is relayed by the hub
```

| Node | wg0 (v4 / v6) | role |
|---|---|---|
| **vega** | 10.42.0.2 / `::2` | **hub** — access/exit edge, file authority, IDS relay |
| **polaris** | 10.42.0.1 / `::1` | **master** — control plane; a spoke on purpose, out of the data path |
| **sirius** | 10.42.0.5 / `::5` | endpoint sensor (x86 Linux) |
| **altair** | 10.42.0.4 / `::4` | viewer (macOS) |
| arcturus / cellphone | 10.42.0.3 / `::3` | endpoint |
| builder | 10.42.0.6 / `::6` | dev box (Mac) |

**Why polaris isn't the hub:** a WireGuard hub decrypts everything it relays, so it
sits in the data path. The master must only see control traffic — so vega (the edge,
already in the data path) is the hub and polaris stays a spoke.

---

## Beyond Phase One

In-tree but not part of this submission: the **wg-selfheal daemon** ([`daemon/`](daemon/),
auto re-asserts unhealthy tunnels) and the island-internet cleanup (removing leftover
exit-node NAT/forwarding now that there's no egress point).

Repo conventions: [`CLAUDE.md`](CLAUDE.md), [`docs/gitpractice.md`](docs/gitpractice.md).

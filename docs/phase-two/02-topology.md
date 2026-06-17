# 02 — Topology: peer-to-peer mesh + the gate

## From hub-and-spoke to flat mesh

Phase One funneled all spoke↔spoke traffic through vega (the hub decrypted and
re-encrypted everything it relayed). Phase Two removes the relay: **every node
holds a direct WireGuard tunnel to every other node it talks to.** There is no
in-path master, no hub redirect.

```
        Phase One (hub-and-spoke)            Phase Two (flat P2P mesh)

              vega (HUB)                        polaris ───── sirius
            /   |   |   \                        |  \       /   |
       polaris sirius altair builder             |   \     /    |
        (every spoke relays via vega)           altair ── vega ── builder
                                                 (each pair peers directly)
```

Addressing is unchanged so existing keys/notes still apply: IPv4 `10.42.0.0/24`,
IPv6 ULA `fd49:2977:3d2f::/64`, host `::N` mirrors `10.42.0.N`.

| Node | wg0 (v4 / v6) | Phase Two role | Reachability |
|---|---|---|---|
| **vega** | 10.42.0.2 / `::2` | **gate node** (only internet uplink + egress toggle) **and file authority** — hosts the universal file-share DB (reused from Phase One) | public endpoint |
| **polaris** | 10.42.0.1 / `::1` | peer; candidate **LLM/oracle** host (see Q in [08](08-open-questions.md)). Its Phase One DB-server role is **deprecated** | configured |
| **sirius** | 10.42.0.5 / `::5` | peer (x86 Linux, has a browser) — **leading LLM host candidate** | behind NAT |
| **altair** | 10.42.0.4 / `::4` | peer (macOS) — viewer-class, full app still runs | behind NAT |
| arcturus | 10.42.0.3 / `::3` | peer (phone) | behind NAT |
| builder | 10.42.0.6 / `::6` | peer (Mac, dev) | behind NAT |

> Roles are now **per-capability**, not per-tier. There is no "master" in the data
> path anymore — polaris's old control-plane privilege is replaced by *admin
> credentials on any node* (see [05](05-api-and-data.md)).

## Where the gate lives

The island has exactly one egress point: **vega**, the only node with a public,
internet-facing path. "Island mode vs. internet access" is literally the state of
vega's egress rules:

```
 ISLAND MODE (default)                  INTERNET ACCESS (gate open)
 ───────────────────────               ────────────────────────────
 vega nftables:                        vega nftables:
   forward  : drop                       forward  : accept (mesh → uplink)
   nat/masq : absent                     nat/masq : MASQUERADE on uplink
 → mesh is sealed                      → peers can route 0.0.0.0/0 via vega
```

Every node's App reads the gate state (vega publishes it over the mesh) and shows
**gated / internet access** on Home. Opening the gate is the canary flow in
[06](06-canary-gate.md); it is time-boxed and auto-recloses.

> **Least-privilege default:** the gate is *closed* on boot and after any reclose.
> Egress is the privileged action, never the resting state. (Matches the project's
> standing posture — default to no-exposure.)

## The universal file share lives on vega (not a hub redirect)

There is **one** island-wide file share, and it is **vega's existing SQLite DB,
reused** — not rebuilt and not per-node. polaris's Phase One DB-server role is
**deprecated**; vega is the single file authority (it's the always-on, public,
already-trusted gate node, so it's the natural home).

This is *not* a contradiction of "no hub redirects." That requirement is about
**traffic relay** — vega decrypting and forwarding one peer's packets to another.
The file share is a **service a node talks to directly**, like any file server:

```
  messaging / friending     →  direct peer ↔ peer        (pure P2P, no vega)
  universal file share       →  peer ↔ vega (the service)  (not relayed through vega
                                                            to a third peer)
```

So vega is in the path for *file storage* (a service it hosts) but never relays
*peer-to-peer* traffic. Friendship still gates who may read/write the share (see
[04](04-friending-protocol.md), [05](05-api-and-data.md)).

## The NAT-traversal problem (must decide — see [08](08-open-questions.md))

A flat mesh assumes peers can reach each other. In Phase One only vega needed a
public endpoint; spokes dialed out to it. In a flat mesh, two nodes *both* behind
home NAT cannot open a direct tunnel without help. Options, in order of preference:

1. **Endpoint-anchored mesh (recommended start).** vega (public) is every node's
   first peer; nodes keep a `PersistentKeepalive` to punch and hold their NAT
   mappings. Direct peer↔peer works once both have an active mapping; pairs that
   can't punch fall back to routing through the node that *can* reach both. This is
   "flat where possible," not "flat always" — but it has **no application-layer
   hub relay**, which is the actual requirement.
2. **All-public endpoints.** Only works if every node has a forwardable port —
   false for phones/macbooks on home NAT. Rejected.
3. **A userspace relay (e.g. a STUN/derp-style box).** More moving parts; defer.

I recommend (1) and call it out explicitly so "P2P, no hub redirects" is honored
at the *app* layer even where the *network* needs vega to bootstrap connectivity.

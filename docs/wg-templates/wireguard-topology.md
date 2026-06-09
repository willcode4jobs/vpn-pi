# WireGuard topology — annotated example configs

**Illustrative, not deployable.** Every `PrivateKey`/`PublicKey` below is an
`<angle-bracket placeholder>`, not a real key — you generate the real keypairs on
each host (see the key-distribution rule). The point of this doc is to make the
**hub-and-spoke** shape, the **addressing**, and *which key goes where* obvious.

---

## The shape

```
                          ┌───────────────────────────────┐
                          │  vega — THE HUB               │
                          │  wg0 10.42.0.2                │
                          │  access/exit edge + file auth │
                          │  PUBLIC: vpn.example-ddns.net │  ← only node with a
                          │          UDP 51820            │     public endpoint
                          └───────────────────────────────┘
            ┌──────────────────┬─────────┴────────┬──────────────────┐
            │ wg tunnel        │                  │                  │
     ┌──────┴──────┐   ┌───────┴──────┐   ┌───────┴──────┐   ┌───────┴──────┐
     │ polaris     │   │ sirius       │   │ altair       │   │ builder      │
     │ 10.42.0.1   │   │ 10.42.0.5    │   │ 10.42.0.4    │   │ 10.42.0.6    │
     │ MASTER      │   │ endpoint     │   │ viewer       │   │ Mac dev box  │
     │ (a spoke)   │   │ sensor (Lx)  │   │ (macOS)      │   │              │
     └─────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
                       (arcturus 10.42.0.3 — endpoint, not built yet)

Every spoke peers ONLY with vega. Spoke→spoke traffic (e.g. sirius shipping an
IDS alert that polaris later reads) is RELAYED THROUGH vega — there are no
direct spoke-to-spoke tunnels. That's the whole reason the file authority and
the IDS relay live on vega: the hub is the one node every spoke can reach.
```

**Why polaris (the master) is a spoke, not the hub:** a WireGuard hub decrypts
and re-encrypts everything it relays — it sits *in the data path*. The master must
only ever see control traffic, so it can't be the hub. vega (the access/exit edge)
is already in the data path by design, so it takes the hub role. See
`gui/deploy/RUNBOOK-ids-nodes.md` and `CODE-MAP.md`.

---

## Key distribution — the part that confuses everyone

WireGuard has no central authority. Each node holds **its own private key** and the
**public key of every peer it talks to**. In hub-and-spoke that means:

| Node | knows its own private key | + the public key(s) of |
|---|---|---|
| **vega** (hub) | vega private | **every** spoke (polaris, sirius, altair, arcturus, builder) |
| polaris (spoke) | polaris private | **vega only** |
| sirius (spoke) | sirius private | **vega only** |
| altair (spoke) | altair private | **vega only** |
| builder (spoke) | builder private | **vega only** |

So the hub's config has one `[Peer]` block per spoke; each spoke's config has
exactly one `[Peer]` block — the hub. A new endpoint = add one `[Peer]` on vega +
give the endpoint a one-spoke config. Nothing private ever leaves the host that
generated it; you only ever copy **public** keys around.
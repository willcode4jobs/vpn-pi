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

---

## Hub — `vega` (`/etc/wireguard/wg0.conf`)

The hub listens on a public UDP port and has a peer for each spoke. Note the
`AllowedIPs` here are **/32** (single host) — the hub routes each spoke to exactly
its own address, and forwards between them.

```ini
[Interface]
# vega is the hub — the only node reachable from the outside.
Address    = 10.42.0.2/24
ListenPort = 51820
PrivateKey = <vega-PrivateKey>

# Relay spoke↔spoke: turn the hub into a router for the island subnet.
# (Also set net.ipv4.ip_forward=1 persistently in /etc/sysctl.d/.)
PostUp   = sysctl -w net.ipv4.ip_forward=1
PostUp   = nft add rule inet filter forward iifname "wg0" oifname "wg0" accept
PostDown = nft delete rule inet filter forward iifname "wg0" oifname "wg0" accept 2>/dev/null || true

# --- spoke: polaris (master) ---
[Peer]
PublicKey  = <polaris-PublicKey>
AllowedIPs = 10.42.0.1/32
# no Endpoint — polaris is behind NAT and dials in; the hub learns its address
# from the incoming handshake.

# --- spoke: sirius (endpoint sensor) ---
[Peer]
PublicKey  = <sirius-PublicKey>
AllowedIPs = 10.42.0.5/32

# --- spoke: altair (macOS viewer) ---
[Peer]
PublicKey  = <altair-PublicKey>
AllowedIPs = 10.42.0.4/32

# --- spoke: builder (Mac dev box) ---
[Peer]
PublicKey  = <builder-PublicKey>
AllowedIPs = 10.42.0.6/32

# --- spoke: arcturus (endpoint — not built yet, shown for shape) ---
# [Peer]
# PublicKey  = <arcturus-PublicKey>
# AllowedIPs = 10.42.0.3/32
```

> **Firewall:** UDP 51820 must be open on vega's nftables (and port-forwarded on
> the home router to `192.168.1.73`). That's a separate per-node firewall step,
> same philosophy as `pi-deployment/open-gui-port.sh` for the GUI port.

---

## Spoke — `polaris` (master)

Every spoke config is nearly identical: one peer (the hub), `AllowedIPs =
10.42.0.0/24` so the *whole island* routes through vega, and a keepalive because
the spoke is behind NAT.

```ini
[Interface]
Address    = 10.42.0.1/24
PrivateKey = <polaris-PrivateKey>

[Peer]
# the hub — the only peer a spoke ever has
PublicKey           = <vega-PublicKey>
Endpoint            = vpn.example-ddns.net:51820   # vega's public address (DDNS)
AllowedIPs          = 10.42.0.0/24                 # route the entire island via the hub
PersistentKeepalive = 25                           # keep the NAT mapping alive
```

**`AllowedIPs = 10.42.0.0/24` is the spoke-to-spoke trick.** It tells polaris
"send anything destined for any island address to vega," and vega's forwarding
(above) relays it to the right spoke. polaris never needs a tunnel to sirius — it
reaches `10.42.0.5` *through* the hub.

---

## Spoke — `sirius` (Linux endpoint sensor)

Identical pattern; only the address and keys differ.

```ini
[Interface]
Address    = 10.42.0.5/24
PrivateKey = <sirius-PrivateKey>

[Peer]
PublicKey           = <vega-PublicKey>
Endpoint            = vpn.example-ddns.net:51820
AllowedIPs          = 10.42.0.0/24
PersistentKeepalive = 25
```

This is the tunnel the IDS shipper rides: sirius's sealed alerts go to
`http://10.42.0.2:8787` (the hub's relay) over this link; polaris later pulls them
from the same hub. Both legs are spoke↔hub.

---

## Spoke — `altair` (macOS viewer)

altair runs the **WireGuard.app from the Mac App Store**, not `wg-quick`. Same
fields, entered in the app's "Add empty tunnel" editor:

```ini
[Interface]
Address    = 10.42.0.4/32           # the app is fine with /32
PrivateKey = <altair-PrivateKey>    # the app can mint this for you

[Peer]
PublicKey           = <vega-PublicKey>
Endpoint            = vpn.example-ddns.net:51820
AllowedIPs          = 10.42.0.0/24
PersistentKeepalive = 25            # a laptop sleeps — keepalive + On-Demand
```

altair is a **viewer only** — it browses the island GUI other nodes serve; it
runs no backend and ships no IDS data (macOS has no journald/fail2ban). Enable
**On-Demand** in the app so the tunnel re-activates after sleep. See
`gui/deploy/RUNBOOK-endpoints.md` Part B.

---

## Spoke — `builder` (your Mac dev box)

Same as any spoke; this is the box you push code/bundles from.

```ini
[Interface]
Address    = 10.42.0.6/24
PrivateKey = <builder-PrivateKey>

[Peer]
PublicKey           = <vega-PublicKey>
Endpoint            = vpn.example-ddns.net:51820
AllowedIPs          = 10.42.0.0/24
PersistentKeepalive = 25
```

---

## Two variants worth knowing

1. **Split-tunnel (shown above):** `AllowedIPs = 10.42.0.0/24` — only *island*
   traffic goes through wg; normal internet stays on the local link. This matches
   the "island internet" framing (file share + IDS), and it's the safe default.

2. **Full-tunnel / exit-node:** if a spoke should send *all* its internet out
   through vega (the original access/exit-node use), set on that spoke:
   ```ini
   AllowedIPs = 0.0.0.0/0
   ```
   and vega must NAT wg0→its uplink (`PostUp` masquerade rule). Don't mix this in
   by accident — `0.0.0.0/0` reroutes the whole box.

---

## Bring-up & sanity

```bash
# spoke (Linux):
sudo wg-quick up wg0
sudo systemctl enable --now wg-quick@wg0      # persist across reboot
sudo wg show                                  # "latest handshake" + transfer = up
ping 10.42.0.2                                # reach the hub
ping 10.42.0.1                                # reach another spoke (THROUGH the hub)
```

A handshake to vega but no ping to another spoke ⇒ the hub's forwarding/NAT rule
or `ip_forward` is missing. A spoke that can't handshake at all ⇒ the hub's UDP
51820 isn't open / not port-forwarded, or the `Endpoint` DDNS name is stale.

---

> Cross-refs: addressing & roles in `CODE-MAP.md`; the firewall model in
> `gui/deploy/NFTABLES-gui-port.md`; why vega (not polaris) is the hub in
> `gui/deploy/RUNBOOK-ids-nodes.md`. The empty `pi-deployment/wg-templates/*.tmpl`
> files are role-based stubs for a future generator and are intentionally separate
> from these per-node examples.

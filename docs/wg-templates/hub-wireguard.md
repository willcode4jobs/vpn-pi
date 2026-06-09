# ============================================================================
# WireGuard HUB config — vega        (deploy to /etc/wireguard/wg0.conf)
# ----------------------------------------------------------------------------
# vega is the ONLY public-facing node. Every spoke peers with vega and nothing
# else; spoke-to-spoke traffic is relayed here, so the hub has one [Peer] block
# per node. Fill the KEY / port placeholders before use — private keys are
# generated on each host and never committed. Dual-stack: IPv4 10.42.0.0/24 +
# IPv6 ULA fd49:2977:3d2f::/64, hosts numbered so ::N matches 10.42.0.N.
# ============================================================================

[Interface]
# vega's own private key (generated on vega; secret, never commit)
PrivateKey = KEY
# vega's mesh address — v4 /24 + v6 /64 (this node IS the hub)
Address = 10.42.0.2/24, fd49:2977:3d2f::2/64
# public UDP port the spokes dial; the home router forwards it to vega
ListenPort = port

# Bring the hub's relay/forwarding firewall up with the interface. mesh.nft
# holds the inter-spoke forward (+ masquerade) rules, kept in its own file so
# this config stays declarative. Expected at /etc/wireguard/mesh.nft.
PostUp = nft -f /etc/wireguard/mesh.nft
# Tear those rules down when the tunnel stops (ignore error if already gone)
PostDown = nft delete table inet mesh 2>/dev/null || true

# --- spoke: polaris (master) ------------------------------------------------
# Co-located on the home LAN, so it gets a STATIC Endpoint (reserved .72).
# Every other spoke is NAT'd and dials in, so the hub learns their address
# from the incoming handshake (no Endpoint line).
[Peer]
#polaris
PublicKey = KEY
Endpoint = 192.168.1.72:port
AllowedIPs = 10.42.0.1/32, fd49:2977:3d2f::1/128

# --- spoke: cellphone (endpoint) --------------------------------------------
[Peer]
#Cellphone
PublicKey = KEY
AllowedIPs = 10.42.0.3/32, fd49:2977:3d2f::3/128

# --- spoke: altair (macOS viewer) -------------------------------------------
[Peer]
#altair
PublicKey = KEY
AllowedIPs = 10.42.0.4/32, fd49:2977:3d2f::4/128

# --- spoke: sirius (endpoint sensor) ----------------------------------------
[Peer]
#sirius
PublicKey = KEY
AllowedIPs = 10.42.0.5/32, fd49:2977:3d2f::5/128

# --- spoke: builder (dev box) -----------------------------------------------
[Peer]
#builder
PublicKey = KEY
AllowedIPs = 10.42.0.6/32, fd49:2977:3d2f::6/128

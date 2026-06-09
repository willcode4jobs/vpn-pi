# ============================================================================
# WireGuard SPOKE config — polaris shown   (deploy to /etc/wireguard/wg0.conf)
# ----------------------------------------------------------------------------
# Every spoke looks like this: ONE [Peer] (the hub, vega) and nothing else.
# Only two things change per node — the [Interface] Address and PrivateKey.
# Fill KEY / port before use; keys are generated on each host, never committed.
# Dual-stack: v4 10.42.0.0/24 + v6 ULA fd49:2977:3d2f::/64 (::N matches .N).
# ============================================================================

[Interface]
# this node's own private key (generated here; secret)
PrivateKey = key
# this node's mesh address — v4 /24 + v6 /64 (polaris = .1 / ::1)
Address = 10.42.0.1/24, fd49:2977:3d2f::1/64
# spokes dial out, so a fixed ListenPort is optional; set one if you want it
ListenPort = port

# The hub — the ONLY peer a spoke has.
[Peer]
#vega
PublicKey = key
# vega's reachable endpoint: LAN-static here; use the public DDNS name off-LAN
Endpoint = 192.168.1.73:port
# vega's /32 + /64. For spoke->spoke via the hub, widen to 10.42.0.0/24, fd49:2977:3d2f::/64
AllowedIPs = 10.42.0.2/32, fd49:2977:3d2f::2/64
# keep the NAT mapping open (the spoke sits behind NAT)
PersistentKeepalive=25

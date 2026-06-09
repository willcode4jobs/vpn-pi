[Interface]
PrivateKey = key
Address = 10.42.0.1/24, fd49:2977:3d2f::1/64
ListenPort = port

[Peer]
# vega
PublicKey = key
Endpoint = 192.168.1.73:port
AllowedIPs = 10.42.0.2/32, fd49:2977:3d2f::2/64
PersistentKeepalive=25
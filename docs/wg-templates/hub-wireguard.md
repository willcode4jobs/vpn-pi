[Interface]
PrivateKey = KEY
Address = 10.42.0.2/24, fd49:2977:3d2f::2/64
ListenPort = port

PostUp = nft -f /etc/wireguard/mesh.nft
PostDown = PostDown = nft delete table inet mesh 2>/dev/null || true

[Peer]           
#polaris
PublicKey = KEY
Endpoint = 192.168.1.72:port
AllowedIPs = 10.42.0.1/32, fd49:2977:3d2f::1/128

[Peer]
# Cellphone
PublicKey = KEY
AllowedIPs = 10.42.0.3/32, fd49:2977:3d2f::3/128

[Peer]
# altair
PublicKey = KEY
AllowedIPs = 10.42.0.4/32, fd49:2977:3d2f::4/128

[Peer]
# sirius
PublicKey = KEY
AllowedIPs = 10.42.0.5/32, fd49:2977:3d2f::5/128

[Peer]
# builder
PublicKey = KEY
AllowedIPs = 10.42.0.6/32, fd49:2977:3d2f::6/128
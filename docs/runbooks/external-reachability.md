# External Reachability Troubleshooting — Command Reference

Commands used to diagnose and verify external WireGuard reachability through Fios port forwarding. Organized by purpose; not all are needed for every issue.

## WireGuard state (vega)

```bash
sudo wg show
sudo systemctl status wg-quick@wg0
sudo systemctl start wg-quick@wg0
sudo systemctl stop wg-quick@wg0
sudo systemctl restart wg-quick@wg0
watch -n 1 sudo wg show
```

## nftables inspection and management (vega)

```bash
sudo nft list ruleset | grep 51820
sudo nft list ruleset | grep 12345
sudo nft -a list ruleset | grep 12345
sudo nft add rule inet filter input udp dport 51820 accept
sudo nft add rule inet filter input tcp dport 12345 accept
sudo nft add rule inet filter input udp dport 12345 accept
sudo nft delete rule inet filter input handle <num>
```

## Packet capture (vega)

```bash
sudo tcpdump -i eth0 -n udp port 51820
sudo tcpdump -i eth0 -nn udp port 51820
sudo tcpdump -i eth0 -n tcp port 12345
sudo tcpdump -i eth0 -n udp port 12345
sudo tcpdump -i eth0 -n
```

## Test listeners (vega)

Note: `nc -l` can silently fail to bind on Pi — verify with `ss` after starting.

```bash
nc -l 12345
nc -ul 12345
ncat -l 12345
ncat -ul 12345
nc -ul 51820
```

## Listener verification (vega) — run after every listener start

```bash
ss -tnlp | grep 12345
ss -unlp | grep 12345
```

## Network sanity checks (vega)

```bash
ip addr show eth0
curl ifconfig.me
```

## Probes from Surface on cellular (PowerShell)

```powershell
Test-NetConnection -ComputerName <wan-ip> -Port 12345
```

Multi-line UDP send:

```powershell
$u = New-Object System.Net.Sockets.UdpClient
$b = [Text.Encoding]::ASCII.GetBytes("probe")
$u.Send($b, 5, "<wan-ip>", 12345)
$u.Close()
```

One-liner version:

```powershell
$u = New-Object System.Net.Sockets.UdpClient; $b = [Text.Encoding]::ASCII.GetBytes("probe"); $u.Send($b, 5, "<wan-ip>", 12345); $u.Close()
```

Note: IP must be passed as a String (quoted). Unquoted IP fails silently.

## Probes from LAN (Mac or Surface on home WiFi)

```bash
ping 192.168.1.73
```

```powershell
Test-NetConnection -ComputerName 192.168.1.73 -Port 12345
```
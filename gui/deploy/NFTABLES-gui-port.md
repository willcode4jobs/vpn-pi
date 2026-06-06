# nftables — opening the GUI port (8787) on polaris

How and why polaris's firewall is changed so the island nodes can reach the
central file-store API, and how to make the change survive a reboot without
fighting `harden-base.sh`.

**Read first:** the GUI upload/delete API is **unauthenticated**. Opening 8787 at
all means *anything that can reach that address+port can read, write, and delete
island files with no credentials*. The firewall **source scope** is the only
control until app auth lands — so these rules are deliberately narrow. Never open
8787 to everything.

---

## Starting point — the harden-base.sh baseline

`pi-deployment/harden-base.sh` installs `/etc/nftables.conf` as a **default-deny**
inbound firewall. The relevant chain:

```
table inet filter {
    chain input {
        type filter hook input priority filter; policy drop;   # deny by default

        iif "lo" accept                                         # loopback
        ct state established,related accept                     # replies to our own conns
        ct state invalid drop
        tcp dport 22 ct state new accept                        # SSH
        icmp type echo-request accept                           # ping (+ icmpv6/nd)
        ...
    }
    chain forward { ... policy drop; }
    chain output  { ... policy accept; }
}
```

Because the policy is `drop`, **port 8787 is closed** — that's why nodes get a
hang/timeout against polaris until we add an explicit `accept`. We are adding one
narrow rule to the `input` chain.

> Note the baseline comment: *"WireGuard UDP port is intentionally NOT opened
> here — added per-node by a later script."* The GUI port follows the same
> philosophy: it's a per-node addition, not part of the shared baseline.

---

## The rule

### Preferred — wg0 interface only (use this once wg is up)

```bash
sudo nft add rule inet filter input iifname "wg0" tcp dport 8787 ct state new accept
```

Only traffic arriving **on the wg0 interface** — i.e. authenticated WireGuard
peers — can reach the port. This is the strongest scope: a non-peer on the LAN
can't even send a packet that matches.

### Interim — explicit node IPs on the island subnet (no wg yet)

```bash
sudo nft add rule inet filter input ip saddr { 10.42.0.4, 10.42.0.5 } tcp dport 8787 ct state new accept
```

Allows only altair (`10.42.0.4`) and sirius (`10.42.0.5`) as sources. Add a node's
IP to the set when it comes online. Tighter than a whole subnet — every allowed
source is named.

### Looser fallback — whole island subnet (avoid if you can)

```bash
sudo nft add rule inet filter input ip saddr 10.42.0.0/24 tcp dport 8787 ct state new accept
```

Any host on `10.42.0.0/24`. Acceptable only if that subnet is exclusively island
nodes; with an unauth API, prefer the explicit-IP form above.

### Token-by-token

| Token | Meaning |
|---|---|
| `inet filter input` | the table (`inet` = v4+v6), chain to append to |
| `iifname "wg0"` | match only packets that arrived on the wg0 interface |
| `ip saddr { ... }` / `ip saddr 10.42.0.0/24` | match by source IP (a set of hosts, or a CIDR subnet) |
| `tcp dport 8787` | destination port 8787 (the GUI/uvicorn bind) |
| `ct state new accept` | accept new connections; established replies are already allowed by the baseline's `ct state established,related accept` |

**CIDR vs bare IP:** `ip saddr` takes either a single address, a `{ set }` of
addresses, or a `subnet/prefix`. The uvicorn `--host` bind, by contrast, takes a
**bare address with no CIDR** — don't put `/24` there. (CIDR = firewall source
match; bare IP = the listen address.)

---

## Runtime vs. persistent — the important part

`nft add rule` changes the **live, in-kernel** ruleset **immediately**, but it is
**not saved**. On reboot, `nftables.service` reloads `/etc/nftables.conf` and your
hand-added rule is gone.

And there's a second trap: **`harden-base.sh` does `flush ruleset` and rewrites
`/etc/nftables.conf` from scratch on every run.** So:

- A runtime `nft add` → lost on reboot.
- A hand-edit of `/etc/nftables.conf` → lost the next time `harden-base.sh` runs.

To make the rule durable you must put it somewhere both reboot **and** a
harden-base re-run preserve. Pick one:

### Option A (simplest, accept the caveat) — edit `/etc/nftables.conf`

Add the line into the `input` chain, right after the SSH rule:

```bash
sudo nano /etc/nftables.conf
#   under  tcp dport 22 ct state new accept
#   add:   ip saddr { 10.42.0.4, 10.42.0.5 } tcp dport 8787 ct state new accept
sudo nft -c -f /etc/nftables.conf      # validate syntax BEFORE applying
sudo systemctl reload nftables         # apply
```

Survives reboot. **Caveat:** a future `harden-base.sh` run overwrites this file —
you'd re-add the line. Fine if you rarely re-run harden-base.

### Option B (durable, project-consistent) — `pi-deployment/open-gui-port.sh`

The follow-on script, mirroring how the baseline defers per-node ports ("added
per-node by a later script"). Run it on **polaris** after harden-base:

```bash
cd ~/projects/vpn-pi && sudo bash -x pi-deployment/open-gui-port.sh
```

What it installs:
- **`/usr/local/sbin/vpn-pi-gui-port-apply`** — a dedup-idempotent helper that
  deletes any existing `:8787` rule, then adds one scoped to the configured node
  IPs. Running it twice never stacks duplicates.
- **`nft-gui-port.service`** — a oneshot, `After=nftables.service`, that runs the
  helper. `enable`d, so the rule **re-asserts automatically on every boot** after
  nftables loads its baseline.

Configure the allowed sources at the top of the script (`ISLAND_SOURCES`); a
commented `WG0 MODE` one-liner in the helper switches from source-IP scoping to
`iifname "wg0"` once the tunnel is up.

**The one caveat, stated honestly:** harden-base.sh uses `systemctl reload`
(not restart) and `flush ruleset`, so re-running harden-base wipes the live rule
and the oneshot won't auto-refire on a reload. Survives reboot fine; after a
harden-base re-run, re-assert with one command:

```bash
sudo systemctl restart nft-gui-port.service     # or just re-run open-gui-port.sh
```

Remove it entirely:
```bash
sudo systemctl disable --now nft-gui-port.service
sudo rm /etc/systemd/system/nft-gui-port.service /usr/local/sbin/vpn-pi-gui-port-apply
sudo systemctl daemon-reload
# the live rule clears on the next nftables reload, or delete it by handle now
```

---

## Verify

```bash
sudo nft list chain inet filter input | grep 8787     # rule present?
sudo ss -tlnp | grep 8787                             # service actually listening on the island addr?
# from a node:
curl -s --max-time 6 http://<polaris-island-addr>:8787/api/health   # {"status":"ok"} = path open end-to-end
```

A hang/timeout from the node means either the rule didn't match (wrong source IP /
interface) or the service is still bound to `127.0.0.1` (see the bind step in
`RUNBOOK.md` §9 / `RUNBOOK-sirius.md` §7).

---

## Remove / roll back

Runtime rule (by handle):

```bash
sudo nft -a list chain inet filter input | grep 8787   # find the "# handle N"
sudo nft delete rule inet filter input handle N
```

Persistent: delete the line you added to `/etc/nftables.conf` (or the follow-on
script), then `sudo systemctl reload nftables`.

Closing the port returns polaris to baseline default-deny for 8787 — nodes can no
longer reach the central store, which is the correct state if the API is exposed
without auth and you're stepping away.

---

## Summary

| | |
|---|---|
| Why | baseline is default-deny; 8787 is closed, so nodes can't reach polaris's store |
| What | one `accept` rule in `inet filter` / `input`, **scoped by source** |
| Scope, best→worst | `iifname "wg0"` → explicit node IPs → subnet CIDR → (never) open to all |
| Live now | `nft add rule ...` (lost on reboot) |
| Persist | edit `/etc/nftables.conf` (lost on harden-base re-run) or a per-node script |
| Why scope matters | the API is unauthenticated — the firewall is the only access control |

# RUNBOOK — deploy the GUI to sirius + altair (wg URL access, like vega)

Stand up islandd on the two spoke Pis so each serves its own GUI on its **wg0 address**,
reachable across the mesh at `http://<wg-ip>:8787` — exactly how you reach vega. Each spoke
gets its own identity + friend code, pulls vega's file share, and announces to polaris so it's
friend-able by code.

| node | wg0 IP | GUI URL (over the mesh) | arch / binary | nftables config path |
|---|---|---|---|---|
| sirius | `10.42.0.5` | `http://10.42.0.5:8787` | x86-64 → `islandd-x64` | `/etc/sysconfig/nftables.conf` |
| altair | `10.42.0.4` | `http://10.42.0.4:8787` | arm64 → `islandd-arm64` | `/etc/nftables.conf` |

> Run the whole thing once per spoke — the steps are identical except the **label**, **IP**,
> **binary** (sirius is x86, altair is arm64), and the **nftables config path** (sirius is
> RHEL/Fedora → `/etc/sysconfig/nftables.conf`, altair is Debian → `/etc/nftables.conf`).
> Both use raw nftables (firewalld is off on sirius). SSH login below is `billy@` (as on vega);
> swap it if a spoke uses a different user.

## Why wg URL access "just works"

The systemd unit's `ExecStart=/usr/local/bin/islandd` takes **no `--host`** — islandd
auto-detects its wg0 address and binds there (`10.42.0.5` / `10.42.0.4`). So GUI-on-the-wg is
automatic; the only extra requirement is the **firewall opening 8787 on wg0** (Step 3). Without
it the bind succeeds but the mesh can't reach it (connection times out), which is exactly the
wall you hit with polaris. Both spokes run **raw nftables** (same as polaris); they only differ
in where the ruleset persists — sirius (RHEL/Fedora) uses `/etc/sysconfig/nftables.conf`, altair
(Debian) uses `/etc/nftables.conf`.

---

## Step 1 — Build the binaries  (ON BUILDER)

The two spokes are **different architectures**: sirius is x86-64, altair is arm64. Build both.
```bash
cd /Users/billyr/Desktop/projects/initfolder/vpn-pi/island
bun run typecheck && bun test && bun run build:x64 && bun run build:arm64
ls -lh dist/islandd-x64 dist/islandd-arm64
```

## Step 2 — Push + install on each spoke  (ON BUILDER)

`push.sh` rsyncs the binary + `deploy/` over wg0 and runs `install.sh` remotely (creates the
`islandd` user + `/var/lib/islandd`, installs the systemd unit, seeds `/etc/islandd/islandd.env`,
prints the auto-generated admin token). Identity/token/env are preserved on re-pushes.

```bash
deploy/push.sh billy@10.42.0.5 dist/islandd-x64        # sirius  (x86-64)
deploy/push.sh billy@10.42.0.4 dist/islandd-arm64      # altair  (arm64)
```
**Save each printed admin token** — it's that spoke's `/admin` password.

## Step 3 — Open 8787 on wg0 (the wg URL access)  (ON EACH SPOKE — `ssh billy@<ip>`)

Both spokes run raw nftables (same as polaris). Scope the rule to **wg0**; leave 8787 closed on
the public NIC (it's a control-plane service). The only per-node difference is the **config
file** you persist into — set `CONF` accordingly, then the rest is identical:
```bash
# sirius (RHEL/Fedora):
CONF=/etc/sysconfig/nftables.conf
# altair (Debian):
CONF=/etc/nftables.conf
```
Add the rule live, then persist it:
```bash
sudo nft insert rule inet filter input iifname "wg0" tcp dport 8787 accept
sudo cp "$CONF" "$CONF.bak"
sudo nano "$CONF"                     # inside `chain input { … }`, add the line below
#     iifname "wg0" tcp dport 8787 accept
sudo nft -c -f "$CONF" && sudo systemctl reload nftables
```
(If the table isn't `inet filter`, use the real table/chain names — `sudo nft -a list ruleset`.
On sirius, confirm firewalld is really off so it can't flush the ruleset: `systemctl is-enabled
firewalld` → `disabled`/`masked`.)

## Step 4 — Configure the spoke's role  (ON EACH SPOKE)

```bash
sudo nano /etc/islandd/islandd.env
```
Set (use the node's own label):
```
ISLAND_LABEL=sirius                              # or altair
ISLAND_REGISTRY_URL=http://10.42.0.1:8787        # announce + friend-by-code (polaris)
ISLAND_EVENTS_URL=http://10.42.0.1:8787          # report to the IDS collector (if events on)
# pull vega's shared files (most nodes do this; vega keeps the durable copy):
ISLAND_SHARE=remote
ISLAND_SHARE_URL=http://10.42.0.2:8787
```
Restart and confirm it bound to wg0 + announced:
```bash
sudo systemctl restart islandd
systemctl is-active islandd
journalctl -u islandd -n 20 --no-pager | grep -iE 'listening|announce'
```
Expect `listening on http://10.42.0.5:8787` (its wg IP, not 127.0.0.1) and
`announced to registry — your friend code: ISL-…`.

---

## Verify (over the mesh)

1. **Reachable on the wg URL** — from **vega or polaris** (real mesh peers). *Not from builder* —
   builder is a roaming spoke behind the vega relay, so a 000 there means builder's relay is down,
   not that the spoke is broken (see `RUNBOOK-builder-mesh-access.md`).
   ```bash
   curl -s -m5 -o /dev/null -w '%{http_code}\n' http://10.42.0.5:8787/api/health   # → 200
   ```
   Then open `http://10.42.0.5:8787` in a browser on the mesh — the GUI loads.
2. **In the registry** — ON POLARIS, resolve the code from the spoke's announce log:
   ```bash
   curl -s http://10.42.0.1:8787/registry/resolve/ISL-XXXXX-XXXXX     # → record JSON
   ```
3. **Full friend-by-code round-trip** (the payoff — two tunnel-bound nodes):
   - sirius GUI → Friends → copy its `ISL-…`.
   - vega GUI → Add a friend → By code → paste → Add → *"Request sent to sirius."*
   - sirius GUI → Pending approvals → accept → both show **"you're now friends."**
   - Now that the spoke *listens on wg0*, the accept delivers automatically (unlike builder on loopback).
4. **File share** — a file uploaded on vega appears in the spoke's Files tab (pulled from `ISLAND_SHARE_URL`).

## Rollback / notes

- Firewall rule wrong? The `.bak` restores it — `sudo cp "$CONF.bak" "$CONF" && sudo systemctl reload nftables` (`$CONF` = `/etc/sysconfig/nftables.conf` on sirius, `/etc/nftables.conf` on altair).
- Re-pushing a new binary later never clobbers identity/token/env (`push.sh` preserves them).
- Each spoke is a full peer: its own identity/keys, its own friends, sealed messages node→node.
  Only vega holds the durable file share and the gate; polaris holds the registry + IDS.

## Checklist (per spoke)

- [ ] (builder) `build:x64` + `build:arm64` → `push.sh` the **matching** binary (sirius=x64, altair=arm64); admin token saved
- [ ] (spoke) nftables allows `wg0` tcp 8787, persisted — sirius → `/etc/sysconfig/nftables.conf`, altair → `/etc/nftables.conf`
- [ ] (spoke) `islandd.env`: label, `ISLAND_REGISTRY_URL`, share; `active`; log shows wg-IP listen + announce
- [ ] (mesh) `curl http://<wg-ip>:8787/api/health` = 200; GUI loads in a browser
- [ ] (polaris) resolve of the spoke's code returns JSON
- [ ] (optional) vega ↔ spoke friend-by-code completes both ways

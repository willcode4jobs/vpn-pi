# Deploy runbook — move the file authority to vega (the hub)

Migrate the durable SQLite file store from **polaris** (a spoke, only reachable
spoke-to-spoke — the flaky path) to **vega**, which is the wg **hub** and so is
directly reachable by every spoke. polaris stays the control-plane master and
leaves the data path; vega becomes the island's file authority.

**Why this works:** every node is configured to talk to the hub, so the moment
the store lives on vega, every node (including the builder) reaches it over a
direct spoke→hub path — no spoke-to-spoke relay, no keepalive games, no
unbastioning polaris. See `NFTABLES-gui-port.md` and `RUNBOOK.md` for the pieces
this reuses.

**Identity note:** vega is the access/exit edge and now also the file authority.
It will hold island file data — acceptable since it's a Pi you own and have
hardened. polaris keeps its control-only isolation (it never becomes the hub —
a wg hub decrypts all spoke traffic, which would break that property).

vega's login is `billy` (same as polaris); its wg/hub address is `10.42.0.2`
(the address every spoke dials). Confirmed reachable from the builder at ~4ms,
0% loss — the spoke→hub path the polaris spoke→spoke path never had.
Run on vega over SSH unless it says "(Mac)" or "(polaris)". Reach by IP — mDNS is
dead behind the firewall.

---

## 1. Prerequisites

- vega hardened (`harden-base.sh` applied — done per CLAUDE.md), reachable by SSH.
- vega is the wg hub with `wg0` up: `sudo wg show` lists the spoke peers.
- Python 3.10+ with venv on vega.
- You can SSH both polaris and vega (they're co-located on the home LAN —
  polaris `192.168.1.72`, vega `192.168.1.73`).

---

## 2. Get the code onto vega

vega's repo state is unconfirmed (CLAUDE.md). If it has the repo + a deploy key:
```bash
cd ~/projects/vpn-pi && git fetch origin && git checkout feat/gui-files-ids && git pull
```
If not, ship it from the Mac (no GitHub needed on vega):
```bash
# (Mac)
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude .venv \
  --exclude __pycache__ --exclude static \
  ~/Desktop/projects/initfolder/vpn-pi/ vega:~/projects/vpn-pi/
```
Confirm: `ls ~/projects/vpn-pi/gui/backend/app/{db.py,store.py}` on vega.

---

## 3. Python env + dependencies (vega)

Identical to polaris `RUNBOOK.md` §3:
```bash
cd ~/projects/vpn-pi/gui/backend
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
./.venv/bin/uvicorn --version
./.venv/bin/python -c "import multipart; print('multipart ok')"
```

---

## 4. Durable DB location (vega)

```bash
sudo mkdir -p /var/lib/vpn-pi
sudo chown billy:billy /var/lib/vpn-pi
sudo chmod 750 /var/lib/vpn-pi
```

---

## 5. Migrate the data from polaris  ← the heart of this runbook

Capture the current file count on polaris so you can verify nothing is lost.
```bash
# (polaris) how many files exist right now?
curl -s 127.0.0.1:8787/api/files | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["files"]),"files")'
#   (use polaris's bind IP if it isn't on loopback)
```

Freeze writes for a clean, consistent copy — stop polaris's store:
```bash
# (polaris)
sudo systemctl stop su495-gui.service
```

Copy the DB file polaris → vega (relay via the Mac; both are on the LAN):
```bash
# (Mac)
scp polaris:/var/lib/vpn-pi/island.db /tmp/island.db
scp /tmp/island.db vega:/tmp/island.db
# (vega) put it in place with the right ownership/mode
sudo install -o billy -g billy -m 640 /tmp/island.db /var/lib/vpn-pi/island.db
rm -f /tmp/island.db        # on the Mac too
```
> The DB is one self-contained file with content stored inline as BLOBs, so a
> plain copy moves everything — metadata *and* file bytes. (`db.py` docstring.)

Leave polaris's `/var/lib/vpn-pi/island.db` in place untouched — it's your
rollback until vega is proven.

---

## 6. First run on vega — loopback smoke test (verify the migration)

```bash
cd ~/projects/vpn-pi/gui/backend
GUI_FILES=sqlite GUI_DB_PATH=/var/lib/vpn-pi/island.db \
GUI_NODE_NAME=vega GUI_NODE_ROLE=edge \
GUI_BIND=127.0.0.1 GUI_PORT=8787 \
  ./.venv/bin/python -m app.main
```
In a second vega session:
```bash
# right store + the migrated rows are all here?
curl -s 127.0.0.1:8787/api/files | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["root"]); print(len(d["files"]),"files")'
#   -> root "vega:island.db" (label comes from the path) AND the SAME count as polaris in §5
# spot-check a download works end to end
ID=$(curl -s 127.0.0.1:8787/api/files | python3 -c 'import sys,json;print(json.load(sys.stdin)["files"][0]["id"])')
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:8787/api/files/$ID/download   # 200
```
File count matches polaris and a download returns 200 → migration is good. `Ctrl-C`.

---

## 7. Install as a service (loopback first)

```bash
sudo cp ~/projects/vpn-pi/gui/deploy/su495-gui.service /etc/systemd/system/
```
Edit it for vega before enabling — the repo unit is polaris-flavored:
```bash
sudo systemctl edit --full su495-gui.service
#   User=billy
#   Group=billy
#   WorkingDirectory=/home/billy/projects/vpn-pi/gui/backend
#   Environment=GUI_NODE_NAME=vega
#   Environment=GUI_NODE_ROLE=edge
#   ExecStart=/home/billy/projects/vpn-pi/gui/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8787
#   (keep GUI_FILES=sqlite, GUI_DB_PATH=/var/lib/vpn-pi/island.db, ReadWritePaths=/var/lib/vpn-pi)
sudo systemctl daemon-reload
sudo systemctl enable --now su495-gui.service
systemctl status su495-gui.service --no-pager
curl -s 127.0.0.1:8787/api/health     # {"status":"ok"}
```

---

## 8. Bind to vega's wg/hub address

```bash
ip -br addr show wg0          # note 10.42.0.2
sudo systemctl edit --full su495-gui.service
#   ExecStart=...uvicorn app.main:app --host 10.42.0.2 --port 8787   (bare IP, no CIDR)
sudo systemctl daemon-reload && sudo systemctl restart su495-gui.service
sudo ss -tlnp | grep ':8787'  # must show 10.42.0.2:8787, not 127.0.0.1
```

---

## 9. Open 8787 to the spokes (wg0-scoped)

Use the per-node script. On the hub, scope by **interface** — every wg peer, no IP
list to maintain. Edit the helper's `WG0 MODE` (or set `ISLAND_SOURCES` to the
spoke IPs) before running:
```bash
# (vega) in pi-deployment/open-gui-port.sh, the generated helper has a commented
# WG0 MODE line — switch the apply to:  iifname "wg0" tcp dport 8787 ...
cd ~/projects/vpn-pi
sudo bash -x pi-deployment/open-gui-port.sh
sudo nft list chain inet filter input | grep 8787    # confirm the rule
```
(Reboot-safe via the `nft-gui-port.service` it installs; re-assert after any
`harden-base.sh` re-run — see `NFTABLES-gui-port.md`.)

---

## 10. Point every node at vega

On each consumer (builder, sirius, altair…) flip `GUI_FILES_URL` from polaris to
vega's hub address — a one-line env change, **no wg reconfig** (the spoke→hub path
already works):
```
GUI_FILES=remote
GUI_FILES_URL=http://10.42.0.2:8787
```
Restart each node's backend. Builder check (this is the reliability win):
```bash
# (builder) direct spoke->hub, should be fast and stable now
curl -s --max-time 6 http://10.42.0.2:8787/api/health      # 200, consistently
```
Then re-point the builder's running backend (I can do this from here).

---

## 11. Verify the island end to end

```bash
# upload from the builder -> lands in vega's authoritative DB
echo "via vega $(date)" > /tmp/v.txt
curl -s -F file=@/tmp/v.txt http://10.42.0.2:8787/api/files
# from sirius/altair: curl http://10.42.0.2:8787/api/files -> the file is visible
# restart vega's service, list again -> still there (persistence holds on the new host)
```

---

## 12. Decommission polaris's store (only after vega is proven)

```bash
# (polaris) it's already stopped from §5; make it permanent
sudo systemctl disable su495-gui.service
# keep polaris's /var/lib/vpn-pi/island.db as a cold backup for now — don't delete yet
```
polaris reverts to control-plane-only. Optionally remove its 8787 firewall rule /
`nft-gui-port.service` since nothing should hit polaris's store anymore.

---

## Rollback

If vega misbehaves before §12 is final:
```bash
# (polaris) bring the old authority back — its DB was never touched
sudo systemctl start su495-gui.service
# repoint nodes' GUI_FILES_URL back to polaris (10.42.0.1:8787)
```
Because §5 froze polaris and you never deleted its DB, rollback is just
"start polaris, repoint nodes."

---

## Notes

- **Don't make polaris the hub** to solve this — a wg hub decrypts all spoke
  traffic, putting the master in the data path and breaking its control-only
  isolation. Hosting the store on the existing hub (vega) avoids that entirely.
- The p2p scope shift is a *separate* topology project (hub relays spoke-to-spoke
  via `AllowedIPs=10.42.0.0/24` + IP forwarding on vega). Where the store lives
  (the hub) is the right call regardless.

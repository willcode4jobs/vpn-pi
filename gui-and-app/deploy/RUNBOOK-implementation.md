# Implementation runbook — roll out the IDS GUI to the island

Takes the operator from **`feat/ids-mesh` committed on the Mac** to the **full IDS
GUI live** — blind-relay mesh, brute-force/fail2ban feed, JAILS panel, and the
view-password — on **vega** (hub + sensor + relay) and **polaris** (master), with
the path for endpoints. This is the orchestration layer; deep per-node detail
lives in [`RUNBOOK-ids-nodes.md`](RUNBOOK-ids-nodes.md), design in
[`../../docs/ids-planning/`](../../docs/ids-planning/).

## The rule that bites: two deploy channels
- **Backend** (Python) → `git pull` + restart.
- **Frontend** (the bundle) → `push-gui.sh` (rsync of `backend/static/`, **not** in
  git). A change spanning both needs *both* — new UI on old API (or vice-versa) is
  the #1 self-inflicted failure here.

## Roles + addresses
| Node | wg0 | role | `GUI_IDS` | serves UI? |
|---|---|---|---|---|
| vega | 10.42.0.2 | hub + sensor + **relay** | `host` (+`GUI_IDS_RELAY=1`) | yes (over wg0) |
| polaris | 10.42.0.1 | **master** (aggregator) | `mesh` | yes (SSH-forward) |
| sirius / altair | .5 / .4 | endpoint sensors | `host` | optional |

---

## Phase 0 — push (Mac)
```bash
git push            # feat/ids-mesh — backend code the nodes will pull
```
The bundle ships in Phase 3 (not via git).

## Phase 1 — keys (you generate; I never hold these)
Per [`03-crypto-and-keys`](../../docs/ids-planning/03-crypto-and-keys.md): master
keypair on polaris, a signer per sensor node, distribute public material only.
```bash
# both nodes: keydir
sudo mkdir -p /var/lib/vpn-pi/ids && sudo chown billy:billy /var/lib/vpn-pi/ids
# polaris (master):  ./.venv/bin/python ../deploy/ids-keygen.py master --out /var/lib/vpn-pi/ids
# vega   (sensor):   ./.venv/bin/python ../deploy/ids-keygen.py node   --out /var/lib/vpn-pi/ids
```
Exchange the **one-line** public keys by hand (no node↔node SSH): copy polaris's
`master.pub` onto vega; paste vega's printed verify key into polaris's registry as
`10.42.0.2=<verifykey>`. (Endpoints later: same, register each on polaris.)

## Phase 2 — backend, each node (vega, polaris)
```bash
cd ~/projects/vpn-pi && git pull
#  if it aborts on untracked files (deploy-artifact limbo):
#    git stash push --include-untracked -m pre-deploy && git pull
cd gui/backend
./.venv/bin/pip install --upgrade pip          # REQUIRED — old pip won't match the pynacl wheel
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -c "import nacl; print('deps ok')"
sudo usermod -aG systemd-journal billy         # IDS + fail2ban sensors (no sudo needed beyond this)
```
Set each node's `Environment=`/`EnvironmentFile=` per
[`RUNBOOK-ids-nodes.md §4/§6`](RUNBOOK-ids-nodes.md) (vega: `GUI_IDS=host` +
`GUI_IDS_RELAY=1` + node key + relay URL + `GUI_IDS_NODE_ADDR=10.42.0.2`; polaris:
`GUI_IDS=mesh` + master key + registry + relay URL + `GUI_IDS_NODE_ADDR=10.42.0.1`).
**No fail2ban grant needed** — the JAILS panel is journal-derived (§4a).

## Phase 3 — frontend bundle (Mac → UI nodes)
```bash
cd ~/Desktop/projects/initfolder/vpn-pi/gui/deploy
./push-gui.sh vega polaris        # builds + rsyncs backend/static/ to each
```
**Order matters for polaris:** it has been API-only, and the static mount is
decided at startup — so the bundle must arrive (this phase) **before** the Phase-4
restart, or `/` 404s.

## Phase 4 — view-password (polaris) + restart everything
View-password is a secret → **root-owned env file, not inline** (`systemctl show`
is world-readable):
```bash
# polaris
sudo install -d -m 750 /etc/vpn-pi
printf 'GUI_VIEW_PASSWORD=%s\n' 'CHOOSE-A-STRONG-ONE' | sudo tee /etc/vpn-pi/gui.env >/dev/null
sudo chmod 600 /etc/vpn-pi/gui.env
sudo systemctl edit --full su495-gui.service     # add: EnvironmentFile=/etc/vpn-pi/gui.env
```
Then restart **last**, after both code (Phase 2) and bundle (Phase 3) are in place:
```bash
# each node
sudo systemctl daemon-reload && sudo systemctl restart su495-gui.service
systemctl status su495-gui.service --no-pager
```

## Phase 5 — verify end to end
Reach addresses: **vega `10.42.0.2:8787`** over wg0; **polaris via SSH-forward**
(`ssh -L 8787:10.42.0.1:8787 polaris` → `http://127.0.0.1:8787`; it binds wg0
`10.42.0.1`, not loopback).

```bash
# vega — its own feed + the relay is buffering opaque ciphertext
curl -s 10.42.0.2:8787/api/ids   | python3 -m json.tool | head
curl -s '10.42.0.2:8787/api/ids/relay?since=0' | python3 -m json.tool | head   # ct = base64

# polaris — the proof
curl -s 10.42.0.1:8787/api/health                                  # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' 10.42.0.1:8787/api/ids     # 401 if GUI_VIEW_PASSWORD set
```
In the browser (polaris, after login):
- **Spine:** vega's events appear with `"node":"10.42.0.2"`, decrypted + merged.
- **Brute-force:** wrong `ssh` ×N → `WARN` attempt rows; past the jail threshold →
  a `CRIT` ban with the count. **JAILS panel** (per-node) shows the banned IP.
- **View-password:** no/wrong password is blocked; correct one renders the mesh.
- **NODE column** populated everywhere (set `GUI_IDS_NODE_ADDR=10.42.0.1` on
  polaris so its own rows show the IP, not the name).

## Endpoints (sirius / altair), when ready
Same as a sensor: Phase 1 node key (register on polaris) + Phase 2 backend with
`GUI_IDS=host` shipping to `http://10.42.0.2:8787`. **sirius extra:** SELinux —
deploy under `/opt` + a py3.12 venv + the policy steps in
[`RUNBOOK-ids-nodes.md §8`](RUNBOOK-ids-nodes.md). The architecture is already
proven, so sirius is a clean add, not a debug session.

## Rollback
- A bad backend: `git checkout <prev> && restart`. A bad bundle: re-run
  `push-gui.sh` from a known-good tree + restart.
- Master misbehaving: the per-node feeds + the hub relay are unaffected; restart
  polaris (its mesh cache is in-memory, re-pulls from the relay).
- The view-password locks *you* out: clear `GUI_VIEW_PASSWORD` from the env file +
  restart (gate goes inactive).

## The gotchas, in one place
1. **Two channels** — backend git, frontend `push-gui.sh`. Don't forget the bundle.
2. **Untracked-limbo** on `git pull` → `git stash push --include-untracked` first.
3. **`pip install --upgrade pip`** before requirements, or pynacl builds from source.
4. **polaris bundle before restart** (static mount is startup-decided).
5. **polaris binds `10.42.0.1`**, not loopback — curl/tunnel that address.
6. **Secrets in a root-owned env file**, never inline `Environment=`.
7. **fail2ban needs no sudo** — JAILS is journal-derived; the `systemd-journal`
   group is the only grant.

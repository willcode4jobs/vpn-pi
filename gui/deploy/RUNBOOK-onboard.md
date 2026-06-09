# Onboard a node — quickstart

One-screen happy path to bring a node into the IDS GUI. **Pick your role, run the
blocks.** Full reference (rollback, every gotcha, verification): see
[`RUNBOOK-implementation.md`](RUNBOOK-implementation.md).

| node | wg0 addr | role block |
|---|---|---|
| vega | 10.42.0.2 | **hub** |
| polaris | 10.42.0.1 | **master** |
| sirius / altair | 10.42.0.5 / 10.42.0.4 | **sensor** |

> sirius extra (x86, SELinux): deploy under `/opt` + py3.12 venv + policy — see
> `RUNBOOK-ids-nodes.md §8` before step 0.

---

## 0. Code + journal access (every node)
```bash
cd ~/projects/vpn-pi && git pull          # if it aborts on untracked files:
#   git stash push --include-untracked -m pre-onboard && git pull
cd gui/backend
./.venv/bin/pip install --upgrade pip && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -c "import nacl; print('deps ok')"
sudo usermod -aG systemd-journal "$USER"  # IDS + fail2ban sensors; no sudo beyond this

# fail2ban must log to the JOURNAL, not /var/log/fail2ban.log (Debian default) —
# else its ban lines never reach journalctl and the JAILS panel / ban events stay
# empty (fail2ban-client status still shows the ban, which masks it):
printf '[Definition]\nlogtarget = SYSTEMD-JOURNAL\n' | sudo tee /etc/fail2ban/fail2ban.local >/dev/null
sudo systemctl restart fail2ban
```

## 1. Keys — SKIP if `/var/lib/vpn-pi/ids/` is already populated
**Reusing existing keys is correct. Regenerating the master key breaks the whole
fleet** (every node's `master.pub` goes stale). Only generate for a brand-new node:
```bash
sudo mkdir -p /var/lib/vpn-pi/ids && sudo chown "$USER:$USER" /var/lib/vpn-pi/ids
# new SENSOR only:
./.venv/bin/python ../deploy/ids-keygen.py node --out /var/lib/vpn-pi/ids
#   -> copy polaris's master.pub into this node's /var/lib/vpn-pi/ids/master.pub
#   -> paste this node's printed verify key into polaris's registry as <wg0-addr>=<key>
```

## 2. Env — `sudo systemctl edit --full su495-gui.service`, add under `[Service]`
(keep the existing `GUI_NODE_NAME`, `GUI_FILES…`, and `ExecStart … --host …` lines)

**sensor:**
```ini
Environment=GUI_IDS=host
Environment=GUI_IDS_NODE_KEY=/var/lib/vpn-pi/ids/node.key
Environment=GUI_IDS_MASTER_PUBKEY=/var/lib/vpn-pi/ids/master.pub
Environment=GUI_IDS_RELAY_URL=http://10.42.0.2:8787
Environment=GUI_IDS_NODE_ADDR=<THIS node's wg0 addr, e.g. 10.42.0.5>
```
**hub (vega):** the sensor block **plus** `Environment=GUI_IDS_RELAY=1`
**master (polaris):**
```ini
Environment=GUI_IDS=mesh
Environment=GUI_IDS_MASTER_KEY=/var/lib/vpn-pi/ids/master.key
Environment=GUI_IDS_REGISTRY=/var/lib/vpn-pi/ids/registry
Environment=GUI_IDS_RELAY_URL=http://10.42.0.2:8787
Environment=GUI_IDS_NODE_ADDR=10.42.0.1
EnvironmentFile=/etc/vpn-pi/gui.env       # the view-password (set it: step 3)
```
> Confirm what's already set first: `systemctl cat su495-gui.service`. You may only
> need to *add* `GUI_IDS_NODE_ADDR` (and, on polaris, the `EnvironmentFile=` line).

## 3. View-password (master only, if not already set)
Secret in a root-owned file — never inline:
```bash
sudo install -d -m 750 /etc/vpn-pi
printf 'GUI_VIEW_PASSWORD=%s\n' 'CHOOSE-A-STRONG-ONE' | sudo tee /etc/vpn-pi/gui.env >/dev/null
sudo chmod 600 /etc/vpn-pi/gui.env
```

## 4. UI bundle — only nodes that serve a browser UI (run on the Mac)
```bash
cd ~/Desktop/projects/initfolder/vpn-pi/gui/deploy && ./push-gui.sh <node>
```
**Must precede the step-5 restart** (the static mount is decided at startup).

## 5. Restart + verify
```bash
sudo systemctl daemon-reload && sudo systemctl restart su495-gui.service
curl -s <this node's wg0 addr>:8787/api/health        # {"status":"ok"}
```
- **sensor/hub:** `curl …:8787/api/ids` shows real events; the hub's
  `…/api/ids/relay?since=0` buffers opaque `ct`.
- **master (polaris, binds 10.42.0.1):** `ssh -L 8787:10.42.0.1:8787 polaris` →
  browse `http://127.0.0.1:8787` → view-password → the mesh feed with the NODE
  column + JAILS panel.

---

### The five things that bite (one-liners)
1. `git pull` aborts → `git stash push --include-untracked` first.
2. `pip install --upgrade pip` *before* requirements (pynacl wheel).
3. **Don't regen keys** if `/var/lib/vpn-pi/ids/` exists — master-key regen = fleet break.
4. UI nodes: `push-gui.sh` **before** the restart.
5. polaris is at **10.42.0.1**, not loopback; secrets go in `/etc/vpn-pi/gui.env`.
6. **fail2ban `logtarget = SYSTEMD-JOURNAL`** — else bans never hit the journal and
   the JAILS panel / ban events stay empty (the CLI status hides it).

# Ground-up runbook — sirius (x86 Linux endpoint sensor, SELinux)

From a **fresh sirius** to a working endpoint: serves its own GUI locally, forwards
files to the hub, and runs the **IDS host sensor** shipping sealed alerts to the
hub. The wall is **SELinux blocking uvicorn** — solved in §3. Self-contained; the
only off-box steps are the frontend bundle (§7) and pushing the branch.

**sirius facts** (correct if wrong): x86 **Linux, SELinux enforcing**; user
`siriususer`, hostname `<hostname>` (island identity is `GUI_NODE_NAME=sirius`);
Python 3.14 (use 3.12 — §2); has a local browser → views its UI at
`http://127.0.0.1:8787`; wg0 `10.42.0.5`; hub = vega `10.42.0.2`.

> **Why uvicorn was blocked.** A systemd service may not `exec` files under
> `/home` (`user_home_t`) — `(code=exited, status=203/EXEC)`. The fix is to deploy
> under **`/opt`** (service-exec-able) and label correctly. Everything below assumes
> `/opt`, never `/home`.

---

## 1. Code → `/opt` (NOT `/home` — this *is* the SELinux fix)
```bash
sudo dnf install -y git-core
sudo mkdir -p /opt/vpn-pi && sudo chown -R siriususer:siriususer /opt/vpn-pi
```

### 1a. Deploy key (read-only — sirius pulls; pushes stay on the Mac)
Generate a passphrase-less keypair **on sirius**, register the public half as a
read-only deploy key on the repo, and pin it for `github.com`:
```bash
# on sirius, as siriususer
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -N "" -C "sirius-deploy"
cat ~/.ssh/id_ed25519_github.pub        # copy this line
```
On GitHub: **repo → Settings → Deploy keys → Add deploy key** → paste the public
key, title `sirius`, **leave "Allow write access" UNCHECKED** (read-only). Then on
sirius:
```bash
cat >> ~/.ssh/config <<'EOF'

Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config ~/.ssh/id_ed25519_github
ssh -T git@github.com                   # "Hi <owner>/vpn-pi! ... does not provide shell access" = success
```
> A repo deploy key is scoped to **this one repo** (unlike an account SSH key) and
> read-only here — sirius can pull but never push, which matches how this fleet
> works (the Mac owns pushes).

### 1b. Clone
```bash
git clone git@github.com:<owner>/vpn-pi.git /opt/vpn-pi
cd /opt/vpn-pi && git checkout feat/ids-mesh
```
> (No-git alternative — rsync from the Mac, skips 1a entirely:
> `rsync -az --delete --exclude .git --exclude .venv --exclude __pycache__ --exclude static
> ~/Desktop/projects/initfolder/vpn-pi/ sirius:/opt/vpn-pi/`)

## 2. Python 3.12 venv (in `/opt`)
```bash
sudo dnf install -y python3.12 policycoreutils-python-utils setroubleshoot-server
cd /opt/vpn-pi/gui/backend
python3.12 -m venv .venv            # py3.14 has no cp314 wheels for pynacl/pydantic-core
./.venv/bin/pip install --upgrade pip && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -c "import nacl, fastapi; print('deps ok')"
```

## 3. SELinux — make uvicorn runnable (the core)
### 3a. Label the deploy
```bash
sudo restorecon -RFv /opt/vpn-pi                       # apply /opt's default contexts
# the venv binaries must be service-exec-able; if restorecon didn't make them bin_t:
sudo semanage fcontext -a -t bin_t "/opt/vpn-pi/gui/backend/.venv/bin(/.*)?"
sudo restorecon -Rv /opt/vpn-pi/gui/backend/.venv/bin
```
### 3b. Allow the non-standard port (the app binds + the shipper connects to 8787)
```bash
sudo semanage port -a -t http_port_t -p tcp 8787 || sudo semanage port -m -t http_port_t -p tcp 8787
```
### 3c. Clear residual denials — DO §4 FIRST, then come back here
**The service unit doesn't exist yet — install + start it in §4** (its
`enable --now` is the start). Return here **only if** `systemctl status
su495-gui.service` then shows `203/EXEC` or the journal shows AVCs:
```bash
sudo ausearch -m AVC -ts recent | audit2why          # WHY it's denied (read this)
# collect into a tight module from the REAL denials, REVIEW, install:
sudo ausearch -m AVC -ts recent | audit2allow -M su495gui
less su495gui.te         # expect ONLY: exec the venv python + bundled .so (pynacl/_sodium,
#                          pydantic_core), name_connect tcp:8787 (shipper→hub), journal read
sudo semodule -i su495gui.pp
sudo systemctl restart su495-gui.service
```
> Denials are logged in **enforcing** too (`ausearch` works without permissive) —
> you usually don't need permissive at all. If you do need to surface the *full
> chain* (enforcing stops at the first denial), make **only the service's domain**
> permissive — **NEVER global `setenforce 0`**:
> ```bash
> sudo semanage permissive -a <service-domain>   # the domain of the 203/EXEC binary
> #   ... start + exercise, collect, audit2allow -M, semodule -i ...
> sudo semanage permissive -d <service-domain>
> ```
> ⚠️ **Global `setenforce 0` then back to enforcing can black-screen the desktop**
> (see `sirius-selinux-blackscreen.md`) — recover with `fixfiles -F onboot && reboot`.
> If `audit2allow` wants anything broad (`sys_admin`, a wide `execmem`), **stop** —
> that's a mislabel `restorecon` should fix, not an `allow`.

## 4. systemd unit (`/opt` paths; endpoint = file-forward + IDS sensor)
```bash
sudo tee /etc/systemd/system/su495-gui.service >/dev/null <<'EOF'
[Unit]
Description=SU495 island GUI (sirius, endpoint sensor)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=siriususer
Group=siriususer
WorkingDirectory=/opt/vpn-pi/gui/backend

# files: forward to the hub (no local DB)
Environment=GUI_FILES=remote
Environment=GUI_FILES_URL=http://10.42.0.2:8787
# IDS: local host sensor, ship sealed alerts to the hub
Environment=GUI_IDS=host
Environment=GUI_NODE_NAME=sirius
Environment=GUI_NODE_ROLE=endpoint
Environment=GUI_IDS_NODE_KEY=/var/lib/vpn-pi/ids/node.key
Environment=GUI_IDS_MASTER_PUBKEY=/var/lib/vpn-pi/ids/master.pub
Environment=GUI_IDS_RELAY_URL=http://10.42.0.2:8787
Environment=GUI_IDS_NODE_ADDR=10.42.0.5
Environment=GUI_PORT=8787

# LOOPBACK-only (sirius has a local browser; the shipper still reaches the hub outbound)
ExecStart=/opt/vpn-pi/gui/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8787
Restart=on-failure
RestartSec=2

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/vpn-pi          # IDS keydir + shipper state
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now su495-gui.service
systemctl status su495-gui.service --no-pager     # active, NO 203/EXEC
```

## 5. Sensor prerequisites
```bash
sudo usermod -aG systemd-journal siriususer        # IDS + fail2ban read the journal
# fail2ban must log to the JOURNAL (else bans never reach the GUI):
printf '[Definition]\nlogtarget = SYSTEMD-JOURNAL\n' | sudo tee /etc/fail2ban/fail2ban.local >/dev/null
sudo systemctl restart fail2ban
# keys (you generate): node key here; copy polaris's master.pub; register sirius's verify key on polaris
sudo mkdir -p /var/lib/vpn-pi/ids && sudo chown siriususer:siriususer /var/lib/vpn-pi/ids
cd /opt/vpn-pi/gui/backend && ./.venv/bin/python ../deploy/ids-keygen.py node --out /var/lib/vpn-pi/ids
#   -> on polaris registry: 10.42.0.5=<sirius verify key>
sudo systemctl restart su495-gui.service          # pick up the journal group + keys
```

## 6. wg + reachability
```bash
sudo wg show wg0 ; ping -c2 10.42.0.2 ; curl -s --max-time5 10.42.0.2:8787/api/health
```
Down? `sudo wg-quick up wg0`; persist: `sudo systemctl enable --now wg-quick@wg0`.

## 7. Frontend bundle (Mac → sirius's `/opt`)
sirius serves its own UI, so it needs the bundle — **at the `/opt` path** (push-gui.sh
targets `~`, so rsync it to `/opt` instead):
```bash
# (Mac) build, then ship to /opt:
( cd gui/frontend && npm run build )
rsync -az gui/backend/static/ sirius:/tmp/static/
# -t allocates a TTY so the over-ssh sudo can prompt for your password:
ssh -t sirius 'sudo rsync -a --delete /tmp/static/ /opt/vpn-pi/gui/backend/static/ && \
               sudo restorecon -Rv /opt/vpn-pi/gui/backend/static && \
               sudo systemctl restart su495-gui.service'
```

## 8. Verify
```bash
# on sirius
curl -s 127.0.0.1:8787/api/health                     # {"status":"ok"}
curl -s 127.0.0.1:8787/api/ids | python3 -m json.tool # sirius's own events
curl -s 127.0.0.1:8787/api/files | python3 -m json.tool | head   # root "vega:island.db" (forwarded)
# browser: http://127.0.0.1:8787  -> masthead "sirius / endpoint", Files + IDS + JAILS
# sensor ships to the master:
sudo fail2ban-client set sshd banip 203.0.113.99      # TEST-NET; not your own ip
#   on polaris: the CRIT ban appears attributed to 10.42.0.5
sudo fail2ban-client set sshd unbanip 203.0.113.99
```

## 9. Troubleshooting (SELinux-first)
| Symptom | Cause → fix |
|---|---|
| `status=203/EXEC` | app under `/home`, or venv not `bin_t` → deploy `/opt` (§1) + `restorecon`/`fcontext` (§3a) |
| starts, then AVC in journal | residual denial → `ausearch -m AVC \| audit2why`; `audit2allow -M` + `semodule -i` (§3c) |
| binds but shipper can't reach hub | `name_connect` to 8787 denied → §3b port label + §3c; or wg down (§6) |
| `/` 404s, `/api/*` works | bundle not at `/opt/…/static` → §7 |
| no IDS events at all | `siriususer` not in `systemd-journal`, or no restart after `usermod` → §5 |
| bans missing but `fail2ban-client status` shows them | fail2ban logging to a file → `logtarget = SYSTEMD-JOURNAL` (§5) |
| `pip` compiles pydantic-core / cargo error | no cp314 wheel → 3.12 venv (§2) |

## 10. Upgrades / uninstall
```bash
cd /opt/vpn-pi && git pull && cd gui/backend && ./.venv/bin/pip install -r requirements.txt
sudo restorecon -Rv /opt/vpn-pi && sudo systemctl restart su495-gui.service   # relabel after pull
# uninstall: sudo systemctl disable --now su495-gui.service ; sudo semodule -r su495gui ;
#            sudo semanage port -d -t http_port_t -p tcp 8787
```

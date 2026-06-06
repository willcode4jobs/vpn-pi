# Deploy runbook — island GUI on sirius

Stand up the island GUI on **sirius** (an **endpoint** node). Unlike polaris (the
headless SQLite file authority — see `RUNBOOK.md`), sirius **serves the browser
UI** and runs **no database**. Its file panel forwards to vega (the hub); its node
identity and IDS feed are local.

**sirius facts this runbook assumes** (correct me if wrong):
- x86 Linux, **not** a Pi. User `brichardt`, home `/home/brichardt`. Hostname is
  `thebigun` — but the *island* identity is set with `GUI_NODE_NAME=sirius`, so
  the masthead and upload attribution read "sirius" regardless of hostname.
- **Has a local desktop/browser** → you reach the UI at `http://127.0.0.1:8787/`
  on sirius itself. No SSH tunnel needed (that was a headless-polaris thing).
- Python 3.14 — newer than the Pi's 3.10. See the §2 wheel caveat.
- sirius and polaris **reach each other** on the network.

**The file authority is `vega` (the wg hub) at `10.42.0.2:8787`** — the store was
moved off polaris (a spoke, only reachable spoke-to-spoke and flaky) onto the hub,
which every spoke reaches directly. See `RUNBOOK-vega-migrate.md`. vega is **live**,
so Phase B is no longer gated — it's just "point at vega."

**Two phases.**
- **Phase A (optional):** sirius runs its UI + backend in **`placeholder`** mode —
  full upload/list/download/delete, but in-memory (gone on restart) and **not**
  shared. Only useful to prove the frontend before wiring the store.
- **Phase B (the real target, §7):** flip one env var to `remote` →
  `GUI_FILES_URL=http://10.42.0.2:8787`. sirius is a spoke, vega is the hub, so
  this path is direct and stable. No redeploy.

**Safety:** the API is unauthenticated, so sirius binds **loopback-only** the
whole time. Never bind `0.0.0.0`.

---

## 1. Get the code onto sirius

sirius has no repo/deploy key yet. The backend Python deploys by pull/copy; pick one.

### Option A — GitHub deploy key (read-only, mirrors polaris)

```bash
# on sirius
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_github -N "" -C "sirius-deploy"
cat ~/.ssh/id_ed25519_github.pub      # add as a READ-ONLY deploy key on the GitHub repo
cat >> ~/.ssh/config <<'EOF'

Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_github
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T git@github.com                 # expect "successfully authenticated"
mkdir -p ~/projects && cd ~/projects
git clone git@github.com:<owner>/vpn-pi.git
cd vpn-pi && git checkout feat/gui-files-ids   # or main, once merged
```

### Option B — rsync from the Mac (no GitHub access on sirius)

```bash
# (Mac) from the repo root
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude .venv \
  --exclude __pycache__ --exclude static \
  ~/Desktop/projects/initfolder/vpn-pi/ sirius:~/projects/vpn-pi/
```

Confirm either way:
```bash
ls ~/projects/vpn-pi/gui/backend/app/{main.py,store.py,remote.py}
```

---

## 2. Python env + dependencies

```bash
cd ~/projects/vpn-pi/gui/backend
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
./.venv/bin/uvicorn --version
./.venv/bin/python -c "import multipart; print('multipart ok')"
```

> **Python 3.14 caveat.** fastapi/pydantic/uvicorn pull compiled wheels
> (`pydantic-core` is Rust). If pip tries to *build from source* (errors about
> `maturin`/`cargo`/`gcc`), there's no cp314 wheel for a pinned version. Fastest
> fix: install a 3.12 alongside and build the venv with it —
> `python3.12 -m venv .venv` — then re-run the installs. The app itself is happy
> on 3.12+.

---

## 3. Ship the frontend bundle (Mac) — REQUIRED on sirius

This is the step polaris skips and sirius needs (sirius serves the UI):

```bash
# (Mac)
gui/deploy/push-gui.sh sirius
ssh sirius 'ls ~/projects/vpn-pi/gui/backend/static/index.html'   # exists -> UI served
```

`push-gui.sh` builds (`tsc + vite`) and rsyncs `backend/static/` to sirius. The
backend auto-serves `/` when that dir exists.

---

## 4. First run — Phase A (placeholder, loopback, manual)

```bash
cd ~/projects/vpn-pi/gui/backend
GUI_FILES=placeholder \
GUI_NODE_NAME=sirius GUI_NODE_ROLE=endpoint \
GUI_BIND=127.0.0.1 GUI_PORT=8787 \
  ./.venv/bin/python -m app.main
```

In a second terminal on sirius, smoke-test:
```bash
curl -s 127.0.0.1:8787/api/node | python3 -m json.tool        # -> "name":"sirius","role":"endpoint"
curl -s 127.0.0.1:8787/api/files | python3 -m json.tool | head # -> "root":"placeholder (in-memory ...)"
echo "sirius smoke $(date)" > /tmp/smoke.txt
ID=$(curl -s -F file=@/tmp/smoke.txt 127.0.0.1:8787/api/files | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s 127.0.0.1:8787/api/files/$ID/download                 # exact bytes back
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE 127.0.0.1:8787/api/files/$ID   # 204
curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:8787/      # 200 (404 = §3 not run)
```

Then open **`http://127.0.0.1:8787/`** in sirius's browser — masthead says
**sirius / endpoint**, Files + IDS panels live. `Ctrl-C` to stop.

---

## 5. Install as a service

The repo's `su495-gui.service` is polaris-specific (SQLite, `billy`,
`/var/lib/vpn-pi`). sirius needs its own unit — `brichardt`, no DB, no writable
data dir. Write it on sirius:

```bash
sudo tee /etc/systemd/system/su495-gui.service >/dev/null <<'EOF'
# SU495 island GUI — sirius (endpoint). Serves the UI; file ops are in-memory
# (Phase A) or forwarded to vega (Phase B). No local database.
# LOOPBACK-ONLY: the API is unauthenticated. Do not bind off-loopback until auth.

[Unit]
Description=SU495 island GUI (sirius, endpoint node)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=brichardt
Group=brichardt
WorkingDirectory=/home/brichardt/projects/vpn-pi/gui/backend

# --- Phase A: placeholder (in-memory, not shared). ---
Environment=GUI_FILES=placeholder
# --- Phase B: comment the line above, uncomment these two (see §7). ---
# Environment=GUI_FILES=remote
# Environment=GUI_FILES_URL=http://10.42.0.2:8787

Environment=GUI_NODE_NAME=sirius
Environment=GUI_NODE_ROLE=endpoint
Environment=GUI_PORT=8787

ExecStart=/home/brichardt/projects/vpn-pi/gui/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8787
Restart=on-failure
RestartSec=2

# Hardening — sirius runs no DB, so nothing outside the read-only system is writable.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now su495-gui.service
systemctl status su495-gui.service
journalctl -u su495-gui.service -n 30 --no-pager
curl -s 127.0.0.1:8787/api/health     # {"status":"ok"}
```

> "Active" ≠ "working" — re-run the §4 upload/download/delete checks against the
> running service before calling it done. Then load `http://127.0.0.1:8787/`.

---

## 6. (Optional) reach sirius's UI from the Mac

Only if you want to view it off-sirius while loopback-only — forward over SSH
(the API stays unexposed):
```bash
# (Mac)
ssh -N -L 8787:127.0.0.1:8787 sirius   # then http://127.0.0.1:8787/ on the Mac
```
If sirius's own browser is enough, skip this.

---

## 7. Phase B — flip sirius to vega's shared store (the target)

vega (the hub) is **live** at `10.42.0.2:8787` and reachable by every spoke, so
this is no longer gated — just point sirius at it. (The API is still
unauthenticated; vega's firewall scopes 8787 to the wg subnet, which is the
current access control — see `NFTABLES-gui-port.md`.)

On sirius:
```bash
sudo systemctl edit --full su495-gui.service
#   comment:   Environment=GUI_FILES=placeholder
#   uncomment: Environment=GUI_FILES=remote
#              Environment=GUI_FILES_URL=http://10.42.0.2:8787
sudo systemctl restart su495-gui.service

curl -s 127.0.0.1:8787/api/files | python3 -m json.tool | head   # -> "root":"vega:island.db"
# upload here, then confirm it shows up directly on vega:  curl http://10.42.0.2:8787/api/files
```
If `/api/files` hangs ~5s then errors, sirius can't reach vega — check the wg path
(`ping 10.42.0.2`) and vega's firewall rule.
(`remote.py` has a 5s timeout so a dead vega won't freeze sirius's UI.)

---

## 8. Upgrades

```bash
# Option A: cd ~/projects/vpn-pi && git pull
# Option B: re-run the Mac rsync from §1B
cd ~/projects/vpn-pi/gui/backend && ./.venv/bin/pip install -r requirements.txt  # if deps changed
sudo systemctl restart su495-gui.service
# (Mac) re-ship UI if it changed:  gui/deploy/push-gui.sh sirius
```
sirius holds no durable state — nothing to back up here (polaris owns the data).

---

## 9. Rollback / uninstall

```bash
sudo systemctl disable --now su495-gui.service
sudo rm /etc/systemd/system/su495-gui.service
sudo systemctl daemon-reload
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `pip install` tries to compile pydantic-core / errors on cargo | no cp314 wheel | rebuild venv with `python3.12 -m venv .venv`, reinstall (§2) |
| `/` 404s, `/api/*` works | static bundle not shipped | re-run §3 `push-gui.sh sirius` |
| masthead says "polaris" not "sirius" | `GUI_NODE_NAME` unset | set it in the unit; `systemctl show su495-gui -p Environment` |
| root says `placeholder (in-memory)` when you wanted sharing | still Phase A | correct until §7 preconditions met |
| `/api/files` hangs ~5s then errors (Phase B) | can't reach polaris | recheck §7 preconditions 1–2 |
| service won't start: `GUI_FILES=remote requires GUI_FILES_URL` | remote without URL | set `GUI_FILES_URL`, or revert to `placeholder` |
| 500 on upload, `ModuleNotFoundError: multipart` | venv deps missing | re-run §2 |
| `git clone/pull` asks for a password | no deploy key | finish §1A, or use §1B rsync |
</content>

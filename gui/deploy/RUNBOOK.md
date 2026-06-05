# Deploy runbook — SQLite file authority on polaris

Stand up the island GUI backend on **polaris** with the real, durable **SQLite**
file store (`GUI_FILES=sqlite`). polaris is the file authority: every other node
runs `GUI_FILES=remote` and forwards file ops here (see `../README.md` §Deployment).

**Role:** polaris is **headless, API-only** — it runs the SQLite file store and
serves `/api/*`, nothing else. It does **not** serve a browser UI; the frontend is
served by the nodes that need it (Option B). So the frontend steps below are
**optional and skipped by default** — no `static/` bundle, no scp.

**Safety posture:** the upload/delete API has **no auth yet**. This runbook brings
polaris up **loopback-only**. Binding to wg0 is a separate, gated step (§9) — do not
do it until auth lands.

Run everything on polaris over SSH unless it says "(Mac)". Reach polaris by IP —
mDNS (`polaris.local`) is dead behind the hardening firewall.

---

## 1. Prerequisites

- polaris hardened (harden-base.sh applied), reachable: `ssh polaris`.
- Repo on polaris at `~/projects/vpn-pi` (already cloned).
- Python 3.10+ and `python3-venv` (`python3 -m venv --help` works).
- The frontend bundle will be shipped from the Mac (§6) — nodes get no npm.

---

## 2. Get the code

```bash
cd ~/projects/vpn-pi
git fetch origin
git checkout feat/gui-files-ids      # or main, once merged
git pull
```

Confirm the file store code is present:

```bash
ls gui/backend/app/{db.py,store.py}    # SqliteFileStore + the seam
```

---

## 3. Python env + dependencies

```bash
cd ~/projects/vpn-pi/gui/backend
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install -r requirements.txt
```

`requirements.txt` includes `python-multipart` (required for uploads) and the
`uvicorn` CLI used by the service. Verify:

```bash
./.venv/bin/uvicorn --version
./.venv/bin/python -c "import multipart; print('multipart ok')"
```

---

## 4. Create the durable DB location

The DB lives outside the repo so a re-clone or `git clean` can't wipe island data,
and it survives reboots. `/var/lib` is the standard spot (same reasoning as
`/var/log/vpn-pi` for logs).

```bash
sudo mkdir -p /var/lib/vpn-pi
sudo chown billy:billy /var/lib/vpn-pi
sudo chmod 750 /var/lib/vpn-pi
```

The DB file itself (`island.db`) is created on first run.

---

## 5. First run + smoke test (loopback, manual)

Before installing a service, prove it works by hand.

```bash
cd ~/projects/vpn-pi/gui/backend
GUI_FILES=sqlite \
GUI_DB_PATH=/var/lib/vpn-pi/island.db \
GUI_NODE_NAME=polaris GUI_NODE_ROLE=relay \
GUI_BIND=127.0.0.1 GUI_PORT=8787 \
  ./.venv/bin/python -m app.main
```

In a second SSH session, exercise the real store end to end:

```bash
# store is sqlite + the right path?
curl -s 127.0.0.1:8787/api/files | python3 -m json.tool | head
#   -> "root": "polaris:island.db"   (NOT "placeholder ...")

# upload -> list -> download -> delete
echo "deploy smoke $(date)" > /tmp/smoke.txt
ID=$(curl -s -F file=@/tmp/smoke.txt 127.0.0.1:8787/api/files | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s 127.0.0.1:8787/api/files/$ID/download        # exact content back
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE 127.0.0.1:8787/api/files/$ID   # 204

# the DB file exists and persists
ls -l /var/lib/vpn-pi/island.db
```

`Ctrl-C` to stop. If the curl checks pass and `island.db` exists, the store is good.

---

## 6. Ship the frontend (Mac) — SKIP for headless polaris

polaris is API-only, so **skip this**. The UI bundle goes to the nodes that serve
a browser UI (sirius/altair/…), not to the file authority. For reference, that
push (run from the Mac, per node) is:

```bash
# only on nodes that serve the UI — NOT polaris
gui/deploy/push-gui.sh <node>
```

On polaris, `/` simply 404s and `/api/*` is the whole surface — by design.

---

## 7. Install as a service

```bash
sudo cp ~/projects/vpn-pi/gui/deploy/su495-gui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now su495-gui.service
```

The unit is loopback-only, runs as `billy`, restarts on failure, and is sandboxed
(`ProtectSystem=strict`, only `/var/lib/vpn-pi` writable). Check it:

```bash
systemctl status su495-gui.service
journalctl -u su495-gui.service -n 30 --no-pager
curl -s 127.0.0.1:8787/api/health        # {"status":"ok"}
```

> "Service active" ≠ "service working" — re-run the upload/download/delete checks
> from §5 against the running service before calling it done.

---

## 8. Reach the API from the Mac while loopback-only (SSH tunnel)

The API is unauthenticated, so it stays on loopback. To hit it from the Mac
without exposing anything to the island, forward the port over SSH:

```bash
# (Mac)
ssh -N -L 8787:127.0.0.1:8787 polaris
```

Then `curl 127.0.0.1:8787/api/files` from the Mac (a browser at `/` 404s —
polaris serves no UI). Close the SSH session to drop access.

---

## 9. Expose on wg0 — LATER, gated on auth

**Do not do this until the upload/delete endpoints are authenticated.** Binding to
wg0 makes write operations reachable by every island peer. When auth is in place:

1. Point the service at the wg0 address:
   ```bash
   sudo systemctl edit su495-gui.service
   # [Service]
   # ExecStart=
   # ExecStart=/home/billy/projects/vpn-pi/gui/backend/.venv/bin/uvicorn app.main:app --host <polaris-wg0-addr> --port 8787
   sudo systemctl restart su495-gui.service
   ```
2. Open the port on **wg0 only** in nftables (match your harden-base.sh table/chain;
   never a wide bind):
   ```bash
   sudo nft add rule inet filter input iifname "wg0" tcp dport 8787 accept
   # persist by adding the same rule to the harden-base.sh ruleset
   ```
3. Point each node's backend at polaris:
   `GUI_FILES=remote GUI_FILES_URL=http://<polaris-wg0-addr>:8787`.

---

## 10. Back up the island data

The DB is the only stateful thing — the rest is rebuildable from git. Snapshot it:

```bash
sudo sqlite3 /var/lib/vpn-pi/island.db ".backup '/var/lib/vpn-pi/island-$(date +%Y%m%d).db'"
```

(Install `sqlite3` CLI if absent: `sudo apt install -y sqlite3`. Not required to
run the GUI — it's only for backups/inspection.)

---

## 11. Upgrades

```bash
cd ~/projects/vpn-pi && git pull
cd gui/backend && ./.venv/bin/pip install -r requirements.txt   # if deps changed
sudo systemctl restart su495-gui.service
# (Mac) re-ship the frontend if it changed:  gui/deploy/push-gui.sh polaris
```

The DB in `/var/lib/vpn-pi` is untouched by upgrades.

---

## 12. Rollback / uninstall

```bash
sudo systemctl disable --now su495-gui.service
sudo rm /etc/systemd/system/su495-gui.service
sudo systemctl daemon-reload
# data is preserved unless you also remove it:
# sudo rm -rf /var/lib/vpn-pi
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/files` root says `placeholder (in-memory)` | `GUI_FILES` not set / not `sqlite` | check the unit's `Environment=GUI_FILES=sqlite`; `systemctl show su495-gui -p Environment` |
| 500 on upload, `ModuleNotFoundError: multipart` | deps not installed in the venv | re-run §3 `pip install -r requirements.txt` |
| service fails to start, `Permission denied` on the DB | `/var/lib/vpn-pi` not owned by `billy` / not in `ReadWritePaths` | redo §4 ownership; confirm `ReadWritePaths=/var/lib/vpn-pi` in the unit |
| `/` 404s but `/api/*` works | no frontend bundle | expected on headless polaris — it's API-only (§6) |
| can't reach `:8787` from another node | loopback-only (by design) | that's §9, and it's gated on auth |
| `polaris.local` won't resolve | mDNS dropped by the firewall | reach polaris by IP (known gotcha) |

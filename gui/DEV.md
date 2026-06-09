# Dev / view — island GUI from the Mac builder

The file authority is **vega** (the wg hub) at `10.42.0.2:8787`. The Mac is a
viewer/dev box — nothing needs to run on it persistently.

**Prereq:** wg up to vega. `ping 10.42.0.2` should reply (~4ms). If it times out,
bring up the WireGuard tunnel first.

---

## A. Just view the live island (no dev server)

vega serves the whole app (UI + files). In a browser:

```
http://10.42.0.2:8787/
```

That's it — page and Files panel both come from vega. (Requires the static bundle
shipped to vega: `rsync -az gui/backend/static/ vega:~/projects/vpn-pi/gui/backend/static/`,
then `sudo systemctl restart su495-gui.service` on vega.)

---

## B. Dev mode (editing the frontend/backend) — two terminals

Run these **from Terminal**, not launchd — the repo lives under `~/Desktop`, which
only an interactive Terminal can read (macOS privacy/TCC).

**Terminal 1 — backend, files proxied to vega:**
```bash
cd ~/Desktop/projects/initfolder/vpn-pi/gui/backend
GUI_NODE_NAME=builder GUI_FILES=remote GUI_FILES_URL=http://10.42.0.2:8787 \
  ./.venv/bin/python -m app.main
# serves http://127.0.0.1:8787  — Files panel reads vega's real store
```

**Terminal 2 — Vite dev server (hot reload), proxies /api → :8787:**
```bash
cd ~/Desktop/projects/initfolder/vpn-pi/gui/frontend
npm run dev
# open the http://127.0.0.1:5173 URL it prints
```

Edit `.tsx`/`.ts` → Vite hot-reloads. Edit backend `.py` → `app.main` auto-reloads
(it runs uvicorn with `--reload`).

---

## Offline / no-vega fallback

No wg or vega down? Drop the remote vars — the backend falls back to an in-memory
placeholder store so the UI still works (demo data, nothing persists):
```bash
cd ~/Desktop/projects/initfolder/vpn-pi/gui/backend
./.venv/bin/python -m app.main          # GUI_FILES unset = placeholder
```

---

## Stop

`Ctrl-C` in each terminal. Nothing is installed/persistent on the Mac.

---

## Ship a UI change to the island

```bash
cd ~/Desktop/projects/initfolder/vpn-pi/gui/frontend
npm run build                                              # -> ../backend/static/
rsync -az ../backend/static/ vega:~/projects/vpn-pi/gui/backend/static/
# on vega:  sudo systemctl restart su495-gui.service
```
Then `http://10.42.0.2:8787/` serves the new UI to every viewer.

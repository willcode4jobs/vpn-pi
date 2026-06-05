# SU495 island GUI — skeleton (Phase E)

Per-node single pane of glass for the island. Two panels on one screen — the
wg0-bound **file share** and a host-security **IDS feed** — served on
loopback/wg0. One app, one screen. Admin (RLPF port-request) comes later.

No daemon. The earlier daemon status-socket coupling (mesh-health) was cut as
scope creep — see git history. This GUI reads only files + host sensors.

See `../GUI-CONTEXT.md` for scope and the non-negotiables.

## Layout

```
gui/
├── backend/                 FastAPI, binds 127.0.0.1 only
│   └── app/
│       ├── main.py          API: /api/node, /api/files, /api/ids
│       ├── models.py        wire models (mirror frontend src/types.ts)
│       └── sources/
│           ├── base.py      DataSource protocol — the one read surface
│           └── mock.py      synthetic node/files/ids, runs with no node or wg
└── frontend/                Vite + React + TypeScript (.tsx), built on the Mac
    └── src/
        ├── App.tsx          one screen: StatusBar + Files + IdsFeed
        ├── api.ts           2s polling hooks; stale-flag = silent-node alarm
        └── components/
```

## Data source

Mock-only today. Everything reads through `sources/base.py:DataSource`, so the
real per-node source — a wg0-bound FTP/share listing for files, auditd/udev/
fail2ban for IDS — drops in behind the same interface with no upstream changes.

## Run it (dev)

Two terminals.

Backend (loopback :8787):
```bash
cd gui/backend
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m app.main
```

Frontend (Vite dev server, proxies /api → backend):
```bash
cd gui/frontend
npm install
npm run dev
```

Open the URL Vite prints (127.0.0.1:5173).

## Test

```bash
cd gui/backend && ./.venv/bin/python -m unittest discover -s tests
```

## Build for a node

```bash
cd gui/frontend && npm run build      # emits to ../backend/static/
cd ../backend && ./.venv/bin/python -m app.main
```

The backend serves the built UI at `/`. Override the bind for wg0 with
`GUI_BIND=<wg0-addr> GUI_PORT=8787`. Never bind 0.0.0.0.

## Status

Skeleton: Files panel + host-IDS feed, one node, mock data. **Not yet:** real
file-share backend, real host sensors, admin/RLPF view, auth, wg0 bind hardening.

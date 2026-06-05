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
│       ├── main.py          API: /api/node, /api/files (+upload/download/delete), /api/ids
│       ├── store.py         FileStore interface + PlaceholderFileStore + build_store()
│       ├── db.py            SqliteFileStore — the real, durable store (on polaris)
│       ├── models.py        wire models (mirror frontend src/types.ts)
│       └── sources/
│           ├── base.py      DataSource protocol — node + IDS read surface
│           └── mock.py      synthetic node/ids, runs with no node or sensors
└── frontend/                Vite + React + TypeScript (.tsx), built on the Mac
    └── src/
        ├── App.tsx          one screen: StatusBar + Files + IdsFeed
        ├── api.ts           2s polling hooks (+ upload/delete); stale = silent-node alarm
        └── components/
```

## Data sources

- **Files — interface + two implementations** (`store.py`). One `FileStore`
  surface (`list/add/get/delete`), selected by `GUI_FILES`:
  - **`placeholder`** (default) — `PlaceholderFileStore`, in-memory. **The active
    store on the builder PC**, where the real DB (which lives on polaris) isn't
    present. Upload/download/delete all work for dev/demo; nothing persists across
    a restart. The panel head shows `placeholder (in-memory)` so it's obvious.
  - **`sqlite`** — `SqliteFileStore` (`db.py`), durable, content stored inline as
    a BLOB. **The real store, on polaris** (the island's file authority). Other
    nodes' GUIs reach it over wg0 — a deliberate central-host scope choice.
  - Endpoints either way: `POST /api/files` (upload), `GET /api/files/{id}/download`,
    `DELETE /api/files/{id}`.
- **Node + IDS — mock.** Still synthetic behind `sources/base.py:DataSource`; the
  real per-node sensors (auditd/udev/fail2ban) drop in with no upstream change.

## Build → push → run on polaris

The builder runs the placeholder; after you push and pull onto polaris, flip the
file store to the real SQLite. No code change — env only:

```bash
# on polaris, after `git pull`:
GUI_FILES=sqlite GUI_DB_PATH=/var/lib/vpn-pi/island.db \
GUI_BIND=<wg0-addr> GUI_PORT=8787 \
  ./.venv/bin/python -m app.main
```

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

Files panel with **upload / download / delete** through the `FileStore` seam —
in-memory placeholder on the builder, real SQLite on polaris (`GUI_FILES=sqlite`).
Host-IDS feed on mock. **Not yet:** real host sensors, admin/RLPF view, auth (the
upload endpoint is unauthenticated — fine on loopback, must be gated before the
backend binds wg0), per-uploader identity, wg0 bind hardening.

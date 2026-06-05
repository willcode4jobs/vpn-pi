# SU495 mesh GUI — skeleton (Phase E)

Per-node single pane of glass. Mesh health + IDS feed on one screen, served on
loopback/wg0. One app, one screen — not three builds. Files + admin (RLPF
port-request) come after this skeleton.

See `../GUI-CONTEXT.md` for scope and the non-negotiables.

## Layout

```
gui/
├── backend/                 FastAPI, binds 127.0.0.1 only
│   └── app/
│       ├── main.py          API + the coupling lever (where the data source is wired)
│       ├── models.py        wire models — mirror the daemon's Go structs 1:1
│       └── sources/
│           ├── base.py      DataSource protocol — the parked socket-vs-wg seam
│           └── mock.py      synthetic 5-node mesh, runs with no daemon/wg/nodes
└── frontend/                Vite + React + TypeScript (.tsx), built on the Mac
    └── src/
        ├── App.tsx          one screen: StatusBar + MeshHealth + IdsFeed
        ├── api.ts           2s polling hooks; stale-flag = silent-node alarm
        └── components/
```

## The coupling lever

GUI-CONTEXT's one open decision — daemon status socket (on critical path) vs.
querying `wg` directly (off-path) — is **parked**. It lives as a code seam, not a
commitment: everything depends on `sources/base.py:DataSource`. Today
`MockDataSource` satisfies it. When the daemon's v1.1 status socket lands, add
`SocketDataSource` (or `WgDataSource`) and change the one `SOURCE =` line in
`app/main.py`. Nothing upstream moves.

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

## Build for a node

```bash
cd gui/frontend && npm run build      # emits to ../backend/static/
cd ../backend && ./.venv/bin/python -m app.main
```

The backend serves the built UI at `/`. Override the bind for wg0 with
`GUI_BIND=<wg0-addr> GUI_PORT=8787`. Never bind 0.0.0.0.

## Status

Skeleton: mesh-health panel + IDS feed, one node, mock data. **Not yet:** files
panel, admin/RLPF view, real data source, auth, wg0 bind hardening.

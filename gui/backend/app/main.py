"""GUI backend — the single pane of glass, per node.

Serves the mesh-health + IDS API and, in production, the built frontend. Binds
loopback/wg0 only — never a wide bind (GUI-CONTEXT.md, non-negotiable).

The DataSource is wired here and nowhere else: today MockDataSource; when the
daemon's v1.1 status socket lands, swap the one line below for SocketDataSource
(daemon on the critical path) or WgDataSource (daemon off-path). That single
assignment *is* the coupling lever.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.models import IdsEvent, MeshSnapshot
from app.sources import DataSource, MockDataSource

# --- The coupling lever. Swap this one binding when real data lands. ---
SOURCE: DataSource = MockDataSource()

app = FastAPI(title="su495-mesh-gui", version="0.1.0-skeleton")


@app.get("/api/mesh", response_model=MeshSnapshot)
def get_mesh() -> MeshSnapshot:
    """Per-peer mesh health for this node. Polled by the mesh-health panel."""
    return SOURCE.mesh()


@app.get("/api/ids", response_model=list[IdsEvent])
def get_ids(limit: int = 100) -> list[IdsEvent]:
    """IDS feed, most-recent-first. Polled by the IDS panel."""
    return SOURCE.ids(limit=limit)


@app.get("/api/health")
def health() -> dict[str, str]:
    """Liveness for the frontend's silent-node detection."""
    return {"status": "ok"}


# --- Static frontend (production). Built on the Mac -> dist/ -> served here. ---
# Absent in dev; the Vite dev server proxies /api to this backend instead.
_DIST = Path(__file__).resolve().parent.parent / "static"
if _DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_DIST / "index.html")


def main() -> None:
    """Loopback-only dev entrypoint. Bind address is overridable for wg0."""
    import uvicorn

    host = os.environ.get("GUI_BIND", "127.0.0.1")  # never 0.0.0.0
    port = int(os.environ.get("GUI_PORT", "8787"))
    uvicorn.run("app.main:app", host=host, port=port, reload=True)


if __name__ == "__main__":
    main()

"""GUI backend — the single pane of glass, per node.

Serves the Files + IDS API and, in production, the built frontend. Binds
loopback/wg0 only — never a wide bind (GUI-CONTEXT.md, non-negotiable).

The data source is mock-only today. The real per-node source (wg0-bound file
share listing + auditd/udev/fail2ban host sensors) will satisfy the same
DataSource protocol and slot in here. (The daemon status-socket source was cut;
the GUI no longer depends on the daemon.)
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.models import FilesSnapshot, IdsEvent, NodeIdentity
from app.sources import DataSource, MockDataSource

SOURCE: DataSource = MockDataSource()

app = FastAPI(title="su495-island-gui", version="0.2.0-skeleton")


@app.get("/api/node", response_model=NodeIdentity)
def get_node() -> NodeIdentity:
    """Identity of this node. Polled by the masthead."""
    return SOURCE.node()


@app.get("/api/files", response_model=FilesSnapshot)
def get_files() -> FilesSnapshot:
    """Island file-share listing. Polled by the Files panel."""
    return SOURCE.files()


@app.get("/api/ids", response_model=list[IdsEvent])
def get_ids(limit: int = 100) -> list[IdsEvent]:
    """Host-security (IDS) feed, most-recent-first. Polled by the IDS panel."""
    return SOURCE.ids(limit=limit)


@app.get("/api/health")
def health() -> dict[str, str]:
    """Liveness for the frontend's silent-node detection."""
    return {"status": "ok"}


# --- Static frontend (production). Built on the Mac -> static/ -> served here. ---
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

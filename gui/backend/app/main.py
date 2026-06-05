"""GUI backend — the single pane of glass, per node.

Serves the Files + IDS API and, in production, the built frontend. Binds
loopback/wg0 only — never a wide bind (GUI-CONTEXT.md, non-negotiable).

The file share sits behind the FileStore interface (app/store.py). On the builder
PC the active store is the in-memory PlaceholderFileStore; on polaris — the
island's file authority — GUI_FILES=sqlite selects the durable SqliteFileStore.
Either way users upload through the GUI (POST /api/files) and every node's GUI
reaches this endpoint over wg0. Node identity and the host-IDS feed are still mock
until real sensors land. (The daemon status-socket source was cut; the GUI no
longer depends on the daemon.)
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile

from app.models import FilesSnapshot, IdsEvent, NodeIdentity, SharedFile
from app.sources import DataSource, MockDataSource
from app.store import FileNotFound, build_store

SOURCE: DataSource = MockDataSource()

# File store: placeholder (in-memory) on the builder, SQLite on polaris. The
# factory reads GUI_FILES / GUI_DB_PATH — see app/store.py.
FILES = build_store()
FILES.seed_if_empty()

_PORT = int(os.environ.get("GUI_PORT", "8787"))

# Cap upload size — an island share, not a CDN. Reject oversized before buffering
# the whole body in memory. 64 MiB is generous for the demo.
_MAX_UPLOAD = int(os.environ.get("GUI_MAX_UPLOAD", str(64 * 1024 * 1024)))

app = FastAPI(title="su495-island-gui", version="0.3.0-skeleton")


@app.get("/api/node", response_model=NodeIdentity)
def get_node() -> NodeIdentity:
    """Identity of this node. Polled by the masthead."""
    return SOURCE.node()


@app.get("/api/files", response_model=FilesSnapshot)
def get_files() -> FilesSnapshot:
    """Island file-share listing from SQLite. Polled by the Files panel."""
    return FILES.list()


@app.post("/api/files", response_model=SharedFile, status_code=201)
async def upload_file(
    file: UploadFile = File(...),
    node: str | None = Form(default=None),
) -> SharedFile:
    """Store an uploaded file in the island DB. `node` defaults to this node."""
    content = await file.read()
    if len(content) > _MAX_UPLOAD:
        raise HTTPException(
            status_code=413,
            detail=f"file exceeds {_MAX_UPLOAD} byte limit",
        )
    name = (file.filename or "unnamed").strip() or "unnamed"
    return FILES.add(
        name=name,
        content=content,
        node=node or SOURCE.node().name,
        content_type=file.content_type,
    )


@app.get("/api/files/{file_id}/download")
def download_file(file_id: int) -> Response:
    """Stream one file back out of the DB as an attachment."""
    try:
        name, content_type, content = FILES.get(file_id)
    except FileNotFound:
        raise HTTPException(status_code=404, detail="no such file")
    return Response(
        content=content,
        media_type=content_type or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


@app.delete("/api/files/{file_id}", status_code=204)
def delete_file(file_id: int) -> Response:
    """Remove a file from the island share."""
    try:
        FILES.delete(file_id)
    except FileNotFound:
        raise HTTPException(status_code=404, detail="no such file")
    return Response(status_code=204)


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
    from fastapi.responses import FileResponse
    from fastapi.staticfiles import StaticFiles

    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(_DIST / "index.html")


def main() -> None:
    """Loopback-only dev entrypoint. Bind address is overridable for wg0."""
    import uvicorn

    host = os.environ.get("GUI_BIND", "127.0.0.1")  # never 0.0.0.0
    uvicorn.run("app.main:app", host=host, port=_PORT, reload=True)


if __name__ == "__main__":
    main()

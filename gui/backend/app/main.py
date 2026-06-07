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

from fastapi import Depends, FastAPI, File, HTTPException, Request, Response, UploadFile

from app.models import FilesSnapshot, IdsEvent, NodeIdentity, SharedFile
from app.peers import resolve as resolve_peer
from app.relay import RelayBatch, RelayDeposit, build_relay
from app.sources import DataSource, build_data_source
from app.store import FileNotFound, build_store
from app.viewauth import LoginRequest, check_password, issue_token, require_view

# IDS/identity source: mock (default) | host (real journald) | mesh (Step 4).
# Selected by GUI_IDS — see app/sources/factory.py.
SOURCE: DataSource = build_data_source()


def require_peer(request: Request) -> str:
    """Authenticate the caller by its wg0 source address and return that address.
    The allowlist (app/peers.py) is the gate: an address not on it — or a missing
    client — is rejected with 403. The returned IP is the trustworthy identity
    stored as a file's adder node (raw IP, no name translation)."""
    client_ip = request.client.host if request.client else None
    peer = resolve_peer(client_ip)
    if peer is None:
        raise HTTPException(status_code=403, detail="unknown wg0 peer — not on the island allowlist")
    return peer

# File store: placeholder (in-memory) on the builder, SQLite on polaris. The
# factory reads GUI_FILES / GUI_DB_PATH — see app/store.py.
FILES = build_store()
FILES.seed_if_empty()

_PORT = int(os.environ.get("GUI_PORT", "8787"))

# Cap upload size — an island share, not a CDN. Reject oversized before buffering
# the whole body in memory. 64 MiB is generous for the demo.
_MAX_UPLOAD = int(os.environ.get("GUI_MAX_UPLOAD", str(64 * 1024 * 1024)))

# IDS blind-relay buffer: present only on the hub (GUI_IDS_RELAY=1), else None
# and the relay routes refuse. The hub buffers opaque ciphertext — see app/relay.py.
RELAY = build_relay()

# Cap a single sealed blob — a host alert, not a payload. Reject oversized deposits.
_MAX_BLOB = int(os.environ.get("GUI_IDS_BLOB_MAX", str(64 * 1024)))

app = FastAPI(title="su495-island-gui", version="0.3.0-skeleton")


@app.on_event("startup")
def _start_shipper() -> None:
    """On a sensor node (node key + relay URL configured), ship this node's local
    feed to the hub in a background thread. No-op on the master/hub-only nodes."""
    from app.ids_shipper import start_shipper

    start_shipper(SOURCE)


@app.post("/api/login")
def login(body: LoginRequest) -> dict[str, str]:
    """Exchange the view-password for a session token (master only — where
    GUI_VIEW_PASSWORD is set). The browser sends the token as a Bearer header on
    the gated reads. Wrong/absent password -> 401."""
    if not check_password(body.password):
        raise HTTPException(status_code=401, detail="bad view password")
    return {"token": issue_token()}


@app.get("/api/node", response_model=NodeIdentity)
def get_node(
    _peer: str = Depends(require_peer), _view: None = Depends(require_view)
) -> NodeIdentity:
    """Identity of this node. Polled by the masthead."""
    return SOURCE.node()


@app.get("/api/files", response_model=FilesSnapshot)
def get_files(_peer: str = Depends(require_peer)) -> FilesSnapshot:
    """Island file-share listing from SQLite. Polled by the Files panel."""
    return FILES.list()


@app.post("/api/files", response_model=SharedFile, status_code=201)
async def upload_file(
    file: UploadFile = File(...),
    peer: str = Depends(require_peer),
) -> SharedFile:
    """Store an uploaded file in the island DB. The adder node is the caller's
    authenticated wg0 IP (require_peer) — not a client-supplied value and not
    this backend's own name — so a file uploaded from 10.42.0.5 reads
    `10.42.0.5` even though the store lives on vega."""
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
        node=peer,
        content_type=file.content_type,
    )


@app.get("/api/files/{file_id}/download")
def download_file(file_id: int, _peer: str = Depends(require_peer)) -> Response:
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
def delete_file(file_id: int, _peer: str = Depends(require_peer)) -> Response:
    """Remove a file from the island share."""
    try:
        FILES.delete(file_id)
    except FileNotFound:
        raise HTTPException(status_code=404, detail="no such file")
    return Response(status_code=204)


@app.get("/api/ids", response_model=list[IdsEvent])
def get_ids(
    limit: int = 100,
    _peer: str = Depends(require_peer),
    _view: None = Depends(require_view),
) -> list[IdsEvent]:
    """Host-security (IDS) feed, most-recent-first. Polled by the IDS panel."""
    return SOURCE.ids(limit=limit)


# --- IDS blind relay (hub only). Opaque ciphertext in, opaque ciphertext out. ---

@app.post("/api/ids/relay", status_code=201)
def relay_deposit(body: RelayDeposit, peer: str = Depends(require_peer)) -> dict[str, int]:
    """A node deposits one sealed alert. Hub-only; the hub stores it verbatim and
    never decrypts. The deposited `node` must match the authenticated caller — a
    cheap integrity gate (the real guarantee is the signature inside the blob)."""
    if RELAY is None:
        raise HTTPException(status_code=503, detail="relay not enabled on this node")
    if body.node != peer:
        raise HTTPException(status_code=403, detail="blob node does not match caller")
    if len(body.ct) > _MAX_BLOB:
        raise HTTPException(status_code=413, detail=f"blob exceeds {_MAX_BLOB} byte limit")
    return {"id": RELAY.deposit(body.node, body.seq, body.ct)}


@app.get("/api/ids/relay", response_model=RelayBatch)
def relay_drain(since: int = 0, limit: int = 500, _peer: str = Depends(require_peer)) -> RelayBatch:
    """The master drains blobs newer than its cursor. Hub-only."""
    if RELAY is None:
        raise HTTPException(status_code=503, detail="relay not enabled on this node")
    return RELAY.drain(since=since, limit=limit)


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

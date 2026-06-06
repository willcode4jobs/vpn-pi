"""The file-store seam: an interface + the builder-side placeholder.

The island file share has three implementations behind one interface:

  - PlaceholderFileStore  (here)        in-memory, the ACTIVE default. Runs on
                                         the builder PC, where the real DB — which
                                         lives on polaris — isn't present. Full
                                         upload/list/download/delete so the GUI
                                         works end to end, but nothing persists
                                         across a restart.
  - SqliteFileStore       (db.py)        the real, durable store. Runs ON POLARIS
                                         (the file authority): GUI_FILES=sqlite.
  - RemoteFileStore       (remote.py)    a NODE's view of the central store. Runs
                                         on every other node: GUI_FILES=remote
                                         GUI_FILES_URL=http://<polaris-wg0>:8787.
                                         Forwards every file op to polaris's API.

Option B topology: each node runs its own backend (its UI + local node/IDS), and
files are central — polaris=sqlite, all other nodes=remote→polaris. A file
uploaded from sirius is visible on altair because both read polaris's store. The
frontend never changes; only this binding (and the backend's host) does.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from app.models import FilesSnapshot, SharedFile


class FileNotFound(Exception):
    """Raised by get()/delete() when no row matches the id. Mapped to HTTP 404."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class FileStore(Protocol):
    """The island file-share surface. Both the placeholder and the real SQLite
    store satisfy this; the API and frontend only ever see the interface."""

    def list(self) -> FilesSnapshot:
        """All files, newest-first, with the store's root/bind labels."""
        ...

    def add(
        self, name: str, content: bytes, node: str, content_type: str | None = None
    ) -> SharedFile:
        """Store a file; return its record (with the new id)."""
        ...

    def get(self, file_id: int) -> tuple[str, str | None, bytes]:
        """Return (name, content_type, content) or raise FileNotFound."""
        ...

    def delete(self, file_id: int) -> None:
        """Remove a file, or raise FileNotFound."""
        ...

    def seed_if_empty(self) -> None:
        """Drop a couple of small files in so a fresh store isn't a blank panel."""
        ...


def seed(store: FileStore) -> None:
    """Shared seed content — real (tiny) bytes, so download works on the seeds
    too. Used by both stores' seed_if_empty()."""
    store.add(
        "README.island.txt",
        b"island file share - upload via the GUI. wg0-only, never public.\n",
        node="polaris",
        content_type="text/plain",
    )
    store.add(
        "harden-base.sh.note",
        b"placeholder - the real harden-base.sh lives in pi-deployment/.\n",
        node="vega",
        content_type="text/plain",
    )


class PlaceholderFileStore:
    """In-memory stand-in for the real polaris SQLite store (see module docstring).

    Implements the full FileStore surface so upload/list/download/delete all work
    on the builder, but everything lives in a dict — gone on restart. The panel
    head shows `placeholder (in-memory)` so it's obvious this isn't the real DB.
    TODO(polaris): the durable store is db.SqliteFileStore; select with GUI_FILES=sqlite.
    """

    def __init__(self, bind: str = "wg0:8787") -> None:
        self._rows: dict[int, dict] = {}
        self._next_id = 1
        self._root = "placeholder (in-memory — real DB on polaris)"
        self._bind = bind

    def list(self) -> FilesSnapshot:
        files = [
            SharedFile(
                id=fid,
                name=r["name"],
                size=r["size"],
                node=r["node"],
                modified=r["modified"],
            )
            for fid, r in self._rows.items()
        ]
        files.sort(key=lambda f: f.modified, reverse=True)
        return FilesSnapshot(root=self._root, bind=self._bind, files=files)

    def add(
        self, name: str, content: bytes, node: str, content_type: str | None = None
    ) -> SharedFile:
        fid = self._next_id
        self._next_id += 1
        modified = now_iso()
        self._rows[fid] = {
            "name": name,
            "size": len(content),
            "node": node,
            "content_type": content_type,
            "content": content,
            "modified": modified,
        }
        return SharedFile(id=fid, name=name, size=len(content), node=node, modified=modified)

    def get(self, file_id: int) -> tuple[str, str | None, bytes]:
        r = self._rows.get(file_id)
        if r is None:
            raise FileNotFound(file_id)
        return r["name"], r["content_type"], r["content"]

    def delete(self, file_id: int) -> None:
        if file_id not in self._rows:
            raise FileNotFound(file_id)
        del self._rows[file_id]

    def is_empty(self) -> bool:
        return not self._rows

    def seed_if_empty(self) -> None:
        if self.is_empty():
            seed(self)


def build_store() -> FileStore:
    """Pick the implementation from env. Defaults to the placeholder so the app
    runs anywhere with nothing to set up; polaris flips it to SQLite; every other
    node points at polaris.

        GUI_FILES=placeholder                                   (default) in-memory
        GUI_FILES=sqlite  GUI_DB_PATH=/var/lib/vpn-pi/island.db  real, on polaris
        GUI_FILES=remote  GUI_FILES_URL=http://<polaris>:8787    a node -> polaris
    """
    port = os.environ.get("GUI_PORT", "8787")
    bind = f"wg0:{port}"
    kind = os.environ.get("GUI_FILES", "placeholder").lower()
    if kind == "sqlite":
        # Local imports keep the non-default backends off the placeholder path.
        from app.db import SqliteFileStore

        default_db = Path(__file__).resolve().parent.parent / "island.db"
        path = os.environ.get("GUI_DB_PATH", str(default_db))
        # Label the store by the node that owns it (the file authority) — not a
        # hardcoded name, so it stays correct if the authority moves (e.g. to vega).
        node = os.environ.get("GUI_NODE_NAME", "polaris")
        return SqliteFileStore(path, root_label=f"{node}:{Path(path).name}", bind=bind)
    if kind == "remote":
        from app.remote import RemoteFileStore

        url = os.environ.get("GUI_FILES_URL")
        if not url:
            raise RuntimeError(
                "GUI_FILES=remote requires GUI_FILES_URL "
                "(e.g. http://<polaris-wg0>:8787)"
            )
        return RemoteFileStore(url)
    return PlaceholderFileStore(bind=bind)

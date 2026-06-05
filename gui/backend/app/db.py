"""SQLite-backed island file store — the real, durable implementation.

This is the store that runs ON POLARIS (the island's file authority), selected
with GUI_FILES=sqlite. On the builder PC the active store is the in-memory
PlaceholderFileStore (app/store.py) — see that module for the build→push→pull
workflow and the FileStore interface both satisfy.

Files that users upload through the GUI are persisted here, content stored inline
as a BLOB. One DB, content-in-BLOB, is the simplest thing that satisfies "connect
the GUI to an sqlite db on polaris." Fine for an island demo; if files get large,
move content to disk and keep only metadata here (the model wouldn't change).

A fresh sqlite3 connection is opened per operation. sqlite3 connections aren't
thread-safe and FastAPI runs sync handlers in a threadpool, so per-call
connections sidestep the sharing problem entirely — cheap for this volume.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterator

from app.models import FilesSnapshot, SharedFile
from app.store import FileNotFound, now_iso, seed

_SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  size          INTEGER NOT NULL,
  node          TEXT    NOT NULL,
  content_type  TEXT,
  content       BLOB    NOT NULL,
  modified      TEXT    NOT NULL          -- ISO 8601 UTC
);
"""


class SqliteFileStore:
    """The island's file table. list/add/get/delete over SQLite. Satisfies the
    FileStore interface (app/store.py)."""

    def __init__(
        self,
        path: str,
        root_label: str = "polaris:island.db",
        bind: str = "wg0:8787",
    ) -> None:
        self._path = path
        self._root = root_label  # shown in the panel head (where files live)
        self._bind = bind        # shown in the panel head (where it's served)
        self._init_schema()

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        con = sqlite3.connect(self._path)
        con.row_factory = sqlite3.Row
        try:
            yield con
            con.commit()
        finally:
            con.close()

    def _init_schema(self) -> None:
        with self._conn() as con:
            con.executescript(_SCHEMA)

    def list(self) -> FilesSnapshot:
        with self._conn() as con:
            rows = con.execute(
                "SELECT id, name, size, node, modified "
                "FROM files ORDER BY modified DESC, id DESC"
            ).fetchall()
        files = [
            SharedFile(
                id=r["id"],
                name=r["name"],
                size=r["size"],
                node=r["node"],
                modified=r["modified"],
            )
            for r in rows
        ]
        return FilesSnapshot(root=self._root, bind=self._bind, files=files)

    def add(
        self,
        name: str,
        content: bytes,
        node: str,
        content_type: str | None = None,
    ) -> SharedFile:
        modified = now_iso()
        with self._conn() as con:
            cur = con.execute(
                "INSERT INTO files (name, size, node, content_type, content, modified) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (name, len(content), node, content_type, content, modified),
            )
            new_id = cur.lastrowid
        return SharedFile(
            id=new_id, name=name, size=len(content), node=node, modified=modified
        )

    def get(self, file_id: int) -> tuple[str, str | None, bytes]:
        """Return (name, content_type, content) or raise FileNotFound."""
        with self._conn() as con:
            row = con.execute(
                "SELECT name, content_type, content FROM files WHERE id = ?",
                (file_id,),
            ).fetchone()
        if row is None:
            raise FileNotFound(file_id)
        return row["name"], row["content_type"], row["content"]

    def delete(self, file_id: int) -> None:
        with self._conn() as con:
            cur = con.execute("DELETE FROM files WHERE id = ?", (file_id,))
            if cur.rowcount == 0:
                raise FileNotFound(file_id)

    def is_empty(self) -> bool:
        with self._conn() as con:
            (n,) = con.execute("SELECT COUNT(*) FROM files").fetchone()
        return n == 0

    def seed_if_empty(self) -> None:
        if self.is_empty():
            seed(self)

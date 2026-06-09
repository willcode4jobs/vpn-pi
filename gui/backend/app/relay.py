"""Hub relay buffer — the blind drop box for sealed IDS alerts.

Runs ON THE HUB (vega), selected by GUI_IDS_RELAY=1. Nodes POST opaque sealed
blobs here; the master pulls them with GET. The hub stores the ciphertext
verbatim and **never decrypts or validates the crypto** — that is the whole
point (blind relay). It only does dumb, bounded buffering:

  - rows are append-only with a monotonic id; the master drains with ?since=<id>
    (the highest id it has consumed) and advances its cursor — at-least-once
    delivery, the master dedupes by (node, seq).
  - bounded: at most `cap` rows; the oldest are evicted on overflow so a chatty
    or malicious peer can't grow the buffer without limit (it also can't read or
    forge — see app/ids_crypto.py).

Persistent sqlite so a hub restart doesn't drop undelivered alerts. Same per-call
connection style as app/db.py (sqlite3 connections aren't threadsafe; FastAPI
runs sync handlers in a threadpool).

No crypto import here, deliberately — the relay path must have no way to read a
blob.
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from pydantic import BaseModel

_SCHEMA = """
CREATE TABLE IF NOT EXISTS relay (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  received  TEXT    NOT NULL,          -- ISO 8601 UTC, hub arrival time
  node      TEXT    NOT NULL,          -- routing label (also authenticated INSIDE the blob)
  seq       INTEGER NOT NULL,          -- per-node sequence (for the master's dedupe/gap check)
  ct        TEXT    NOT NULL           -- base64 sealed blob — OPAQUE to the hub
);
"""

_DEFAULT_CAP = int(os.environ.get("GUI_IDS_RELAY_CAP", "5000"))


class RelayDeposit(BaseModel):
    """One sealed alert as deposited by a node. `ct` is the base64 SealedBox
    ciphertext; the hub treats it as an opaque string."""

    node: str
    seq: int
    ct: str


class RelayBatch(BaseModel):
    """A drain response: blobs newer than the requested cursor, plus the new
    cursor (the max id in this batch, or the requested `since` if empty)."""

    cursor: int
    blobs: list[RelayDeposit]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class RelayBuffer:
    """Bounded, append-only, opaque sqlite ring of sealed blobs."""

    def __init__(self, path: str, cap: int = _DEFAULT_CAP) -> None:
        self._path = path
        self._cap = cap
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

    def deposit(self, node: str, seq: int, ct: str) -> int:
        """Append one blob; evict oldest beyond the cap. Returns its id."""
        with self._conn() as con:
            cur = con.execute(
                "INSERT INTO relay (received, node, seq, ct) VALUES (?, ?, ?, ?)",
                (_now_iso(), node, seq, ct),
            )
            new_id = cur.lastrowid
            # Keep only the newest `cap` rows.
            con.execute(
                "DELETE FROM relay WHERE id <= "
                "(SELECT MAX(id) FROM relay) - ?",
                (self._cap,),
            )
        return new_id

    def drain(self, since: int = 0, limit: int = 500) -> RelayBatch:
        """Blobs with id > since (oldest-first), capped at `limit`. The cursor is
        the max id returned, or `since` when nothing is newer."""
        with self._conn() as con:
            rows = con.execute(
                "SELECT id, node, seq, ct FROM relay WHERE id > ? ORDER BY id ASC LIMIT ?",
                (since, limit),
            ).fetchall()
        blobs = [RelayDeposit(node=r["node"], seq=r["seq"], ct=r["ct"]) for r in rows]
        cursor = rows[-1]["id"] if rows else since
        return RelayBatch(cursor=cursor, blobs=blobs)


def build_relay() -> RelayBuffer | None:
    """Construct the relay only when this node is the hub (GUI_IDS_RELAY truthy).
    Other nodes return None and the relay routes refuse with 503."""
    flag = os.environ.get("GUI_IDS_RELAY", "").lower()
    if flag not in ("1", "true", "on", "yes"):
        return None
    default_db = os.path.join(
        os.environ.get("GUI_DB_DIR", "/var/lib/vpn-pi"), "ids-relay.db"
    )
    path = os.environ.get("GUI_IDS_RELAY_DB", default_db)
    return RelayBuffer(path)

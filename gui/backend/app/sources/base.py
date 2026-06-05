"""The coupling-lever seam.

The one open architectural decision in GUI-CONTEXT.md is *how the app gets its
data*:

  - App reads the daemon's status socket  -> daemon on the critical path
  - App queries wg directly                -> daemon parallel / off-path

That decision is parked until v1.1 ships the wg0-bound status socket. Rather
than pre-commit, the app depends only on this interface. Today MockDataSource
satisfies it. Later, SocketDataSource (reads the daemon socket) or WgDataSource
(shells/netlinks wg directly) drops in here with zero changes upstream — swapping
one line in app/main.py pulls the lever.
"""

from __future__ import annotations

from typing import Protocol

from app.models import IdsEvent, MeshSnapshot


class DataSource(Protocol):
    """Everything the single-screen GUI reads. Keep this surface small — it is
    the contract the real daemon socket will have to satisfy."""

    def mesh(self) -> MeshSnapshot:
        """Current per-peer mesh health for this node."""
        ...

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        """Most-recent-first IDS feed (mesh transitions + host sensor events)."""
        ...

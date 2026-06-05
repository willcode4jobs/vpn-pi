"""The data-source seam (node identity + IDS feed).

These are the still-synthetic reads. Files are no longer here — they moved to a
real SQLite store (app/db.py:FileStore) once uploads landed, since that surface
needs writes (add/delete), not just reads. Node identity and the host-IDS feed
stay behind this interface; the real source (auditd/udev/fail2ban) drops in with
zero changes upstream.

(The earlier daemon status-socket source was cut — see git history. The GUI no
longer sits on the daemon's critical path.)
"""

from __future__ import annotations

from typing import Protocol

from app.models import IdsEvent, NodeIdentity


class DataSource(Protocol):
    """Node identity + IDS read surface. Small on purpose — the contract the
    real per-node sensors will have to satisfy."""

    def node(self) -> NodeIdentity:
        """Identity of the node this pane reports for."""
        ...

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        """Most-recent-first host-security (IDS) feed."""
        ...

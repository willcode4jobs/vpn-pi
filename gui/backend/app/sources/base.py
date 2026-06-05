"""The data-source seam.

Everything the single-screen GUI reads goes through this one interface, so the
panels never know whether they're looking at synthetic data or a real node. Today
MockDataSource satisfies it; the real source (a wg0-bound FTP/share listing for
files, auditd/udev/fail2ban for IDS) drops in here with zero changes upstream.

(The earlier daemon status-socket source was cut — see git history. The GUI no
longer sits on the daemon's critical path.)
"""

from __future__ import annotations

from typing import Protocol

from app.models import FilesSnapshot, IdsEvent, NodeIdentity


class DataSource(Protocol):
    """The full read surface of the GUI. Keep it small — it's the contract the
    real per-node backends will have to satisfy."""

    def node(self) -> NodeIdentity:
        """Identity of the node this pane reports for."""
        ...

    def files(self) -> FilesSnapshot:
        """Current island file-share listing."""
        ...

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        """Most-recent-first host-security (IDS) feed."""
        ...

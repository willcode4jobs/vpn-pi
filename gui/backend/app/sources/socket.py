"""Real data source: the daemon's v1.1 status socket.

This is the "on critical path" arm of the coupling lever. It connects to the
daemon's unix-domain status socket (`internal/status` in the daemon), reads the
single JSON snapshot it serves, and maps it onto the GUI's models.

The daemon and these models were built to the same contract, so the mesh half is
a near-straight decode — `node` and `peers` field names and null semantics line
up 1:1 with NodeIdentity/PeerStatus. The IDS half does need a small mapping: the
daemon emits its *native* mesh transitions (it only knows mesh events), and this
layer is where they become the GUI's richer IdsEvent — kind -> severity, peer
name -> subject, a rendered message, and a synthesized stable id. Host sensors
(USB/login/reboot) are a separate feed and don't come through here.

Connection failure (daemon down, socket absent) propagates as an OSError. That
is intentional: the polling frontend renders the failure as SIGNAL LOST, which
is precisely the "a silent node is the alarm" behavior — not an error to hide.
"""

from __future__ import annotations

import json
import socket
from typing import Any

from app.models import (
    IdsEvent,
    IdsSeverity,
    IdsSource,
    MeshSnapshot,
)

# Daemon transition kind -> how the IDS feed should weight it. Mirrors the
# severity an admin would assign: a recovery is informational, a peer going
# stale is a warning, a degraded latch is critical.
_KIND_SEVERITY: dict[str, IdsSeverity] = {
    "recovered": IdsSeverity.INFO,
    "stale": IdsSeverity.WARN,
    "degraded": IdsSeverity.CRIT,
}

# Human-readable rendering per kind, matching the IDS feed's house style.
_KIND_MESSAGE: dict[str, str] = {
    "recovered": "peer {name} recovered — handshake within threshold",
    "stale": "peer {name} stale — handshake age past threshold",
    "degraded": "peer {name} degraded — remediation exhausted",
}


class SocketDataSource:
    """Reads the daemon's status socket. Satisfies the DataSource protocol.

    Each call opens a short-lived connection and reads the full snapshot (which
    carries both peers and events). The two protocol methods slice out the half
    they need. The snapshot is tiny and the socket is loopback-local, so the
    double read per poll cycle is negligible; a small TTL cache could dedupe it
    later if churn ever matters.
    """

    def __init__(self, path: str, timeout: float = 2.0) -> None:
        self._path = path
        self._timeout = timeout

    def _read_snapshot(self) -> dict[str, Any]:
        """Connect, read one JSON document to EOF, parse. Raises OSError if the
        daemon is unreachable (surfaced to the UI as SIGNAL LOST)."""
        chunks: list[bytes] = []
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(self._timeout)
            sock.connect(self._path)
            while True:
                buf = sock.recv(65536)
                if not buf:
                    break
                chunks.append(buf)
        return json.loads(b"".join(chunks))

    def mesh(self) -> MeshSnapshot:
        snap = self._read_snapshot()
        # node/peers/generated_at align field-for-field; the extra `events` key
        # is ignored. This straight validate is the contract alignment paying off.
        return MeshSnapshot.model_validate(snap)

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        snap = self._read_snapshot()
        events = snap.get("events", [])  # daemon already serves these newest-first
        return [_to_ids_event(e) for e in events[:limit]]


def _to_ids_event(e: dict[str, Any]) -> IdsEvent:
    """Map one native daemon transition onto the GUI's IdsEvent."""
    kind = e.get("kind", "")
    name = e.get("name") or _short_key(e.get("peer", "?"))
    return IdsEvent(
        # The daemon doesn't assign ids; peer+timestamp is stable and unique
        # enough for a feed key (one transition per peer per tick).
        id=f"{e.get('peer', '?')}@{e.get('at', '')}",
        at=e["at"],
        source=IdsSource.MESH,
        severity=_KIND_SEVERITY.get(kind, IdsSeverity.INFO),
        subject=name,
        message=_KIND_MESSAGE.get(kind, f"peer {name} {kind or 'changed'}").format(name=name),
    )


def _short_key(pub: str) -> str:
    return pub[:8] + "…" if len(pub) > 8 else pub

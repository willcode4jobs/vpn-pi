"""SocketDataSource maps the daemon's status-socket JSON onto the GUI models.

The fixture below is the daemon's actual wire format (`internal/status`), so this
test is the cross-language contract check: if the daemon changes its shape, this
breaks. Uses a stdlib fake unix-socket server — no daemon, no new deps.
"""

from __future__ import annotations

import json
import os
import socket
import tempfile
import threading
import unittest

from app.models import IdsSeverity, IdsSource, PeerState
from app.sources import SocketDataSource

# Exactly what `nc -U` pulled from the real daemon: ok / stale / degraded peers,
# null handshake + endpoint on the never-handshaked peer, events newest-first.
SNAPSHOT = {
    "node": {
        "name": "polaris",
        "role": "relay",
        "public_key": "pol1Xn4kQ2bV8sR0aZ7yL3mC6dF9gH2jK5nP8qT1wE=",
        "wg_interface": "wg0",
    },
    "peers": [
        {
            "peer": "veg7Yh2mN9cB4xS1aD6fG3jL0pQ8rT5wZ2eR7yU4iO=",
            "name": "vega",
            "state": "ok",
            "last_handshake": "2026-06-04T22:49:05.368222-04:00",
            "endpoint": "203.0.113.41:51820",
        },
        {
            "peer": "arc9Zx4cV7bN2mM5kL8jH1gF6dS3aP0qW9eR4tY7uI=",
            "name": "arcturus",
            "state": "degraded",
            "last_handshake": None,
            "endpoint": None,
        },
    ],
    "events": [
        {
            "peer": "arc9Zx4cV7bN2mM5kL8jH1gF6dS3aP0qW9eR4tY7uI=",
            "name": "arcturus",
            "kind": "degraded",
            "from": "stale",
            "to": "degraded",
            "last_handshake": None,
            "endpoint": None,
            "at": "2026-06-04T22:49:11.368222-04:00",
        },
        {
            "peer": "alt5Lq2eR8tY1uI4oP7aS0dF3gH6jK9nB2vC5xZ8mQ=",
            "name": "altair",
            "kind": "stale",
            "from": "ok",
            "to": "stale",
            "last_handshake": "2026-06-04T22:45:54.368222-04:00",
            "endpoint": "192.0.2.88:51820",
            "at": "2026-06-04T22:48:54.368222-04:00",
        },
    ],
    "generated_at": "2026-06-04T22:49:19.368222-04:00",
}


class FakeDaemon:
    """A unix socket that serves one JSON snapshot per connection, like the
    daemon's status.Server. Accepts repeatedly so mesh() and ids() can each
    open their own connection."""

    def __init__(self, path: str, payload: dict) -> None:
        self._payload = json.dumps(payload).encode()
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._srv.bind(path)
        self._srv.listen()
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self._srv.accept()
            except OSError:
                return  # closed
            with conn:
                conn.sendall(self._payload)

    def close(self) -> None:
        self._srv.close()


class SocketSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.mkdtemp()
        self._sock = os.path.join(self._dir, "status.sock")
        self._daemon = FakeDaemon(self._sock, SNAPSHOT)
        self._daemon.start()
        self.src = SocketDataSource(self._sock)

    def tearDown(self) -> None:
        self._daemon.close()

    def test_mesh_decodes_node_and_peers(self) -> None:
        snap = self.src.mesh()
        self.assertEqual(snap.node.name, "polaris")
        self.assertEqual(snap.node.role, "relay")
        self.assertEqual(len(snap.peers), 2)

        vega, arcturus = snap.peers
        self.assertEqual(vega.state, PeerState.OK)
        self.assertIsNotNone(vega.last_handshake)
        self.assertEqual(vega.endpoint, "203.0.113.41:51820")

        # Null sentinels must survive as None, not "" or epoch.
        self.assertEqual(arcturus.state, PeerState.DEGRADED)
        self.assertIsNone(arcturus.last_handshake)
        self.assertIsNone(arcturus.endpoint)

    def test_ids_maps_transitions(self) -> None:
        events = self.src.ids()
        self.assertEqual(len(events), 2)

        deg, stale = events  # daemon serves newest-first; order preserved
        self.assertEqual(deg.source, IdsSource.MESH)
        self.assertEqual(deg.severity, IdsSeverity.CRIT)  # degraded -> crit
        self.assertEqual(deg.subject, "arcturus")
        self.assertIn("degraded", deg.message)
        # id keys off the stable public key + timestamp, not the human name.
        self.assertIn("arc9Zx4", deg.id)
        self.assertIn("2026-06-04T22:49:11", deg.id)

        self.assertEqual(stale.severity, IdsSeverity.WARN)  # stale -> warn

    def test_ids_respects_limit(self) -> None:
        self.assertEqual(len(self.src.ids(limit=1)), 1)

    def test_unreachable_socket_raises(self) -> None:
        dead = SocketDataSource(os.path.join(self._dir, "nope.sock"))
        with self.assertRaises(OSError):  # -> frontend renders SIGNAL LOST
            dead.mesh()


if __name__ == "__main__":
    unittest.main()

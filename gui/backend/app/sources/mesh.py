"""MeshDataSource — the master's aggregate IDS feed.

Runs ON THE MASTER (polaris), selected by GUI_IDS=mesh. Pulls sealed blobs from
the hub's relay, opens+verifies each against the node registry, dedupes, and
merges with the master's OWN local feed into one newest-first list. The hub only
ever served ciphertext; decryption happens only here (app/ids_crypto.py).

Structurally the mirror of RemoteFileStore (app/remote.py): stdlib urllib pull,
re-validate against the shared models. A cursor (highest relay id consumed) is
held in-process and advanced each pull — at-least-once delivery from the relay,
so we dedupe by (node, seq).

Attribution comes ONLY from the verified signature: the event's `node` is set
from the payload the signature covers, and the outer routing {node, seq} the hub
saw is cross-checked against it — a mismatch is dropped. Fail-closed throughout
(no master key, unknown signer, bad signature, tamper → the blob is rejected,
never shown as a real alert).

Gap/heartbeat surfacing is Step 5; this is the decrypt+merge spine.
"""

from __future__ import annotations

import base64
import os
import threading
import urllib.request

from app.ids_crypto import VerificationError, load_master_private, open_verify
from app.models import IdsEvent, NodeIdentity
from app.relay import RelayBatch

_TIMEOUT = 5.0  # a dead hub must not hang the master's UI


class MeshDataSource:
    """Aggregates decrypted mesh alerts + the master's local feed."""

    def __init__(
        self,
        *,
        master_private,
        verify_key_for,
        relay_url: str,
        local=None,
        puller=None,
    ) -> None:
        self._priv = master_private
        self._verify_for = verify_key_for
        self._relay_url = relay_url.rstrip("/")
        self._local = local
        self._pull = puller or self._http_pull
        self._cursor = 0
        self._events: dict[tuple[str, int], IdsEvent] = {}  # (node, seq) -> event
        self._rejected = 0
        self._lock = threading.Lock()

    def node(self) -> NodeIdentity:
        if self._local is not None:
            return self._local.node()
        return NodeIdentity(
            name=os.environ.get("GUI_NODE_NAME", "polaris"),
            role=os.environ.get("GUI_NODE_ROLE", "master"),
            wg_interface=os.environ.get("GUI_WG_IFACE", "wg0"),
        )

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        with self._lock:
            self._pull_and_merge()
            mesh_events = list(self._events.values())
        local_events = self._local.ids(limit) if self._local is not None else []
        events = mesh_events + local_events
        events.sort(key=lambda e: e.at, reverse=True)
        return events[:limit]

    def _pull_and_merge(self) -> None:
        try:
            batch = self._pull(self._cursor)
        except OSError:
            return  # hub unreachable — keep what we have; the panel shows stale
        for blob in batch.blobs:
            ev = self._open(blob)
            if ev is None:
                continue
            key = (ev.node, _seq_of(ev))
            self._events.setdefault(key, ev)  # dedupe: first wins
        self._cursor = batch.cursor

    def _open(self, blob) -> IdsEvent | None:
        try:
            payload = open_verify(
                base64.b64decode(blob.ct), self._priv, self._verify_for
            )
        except VerificationError:
            self._rejected += 1
            return None
        # cross-check the hub-visible routing fields against the authenticated ones
        if payload.get("node") != blob.node or payload.get("seq") != blob.seq:
            self._rejected += 1
            return None
        try:
            ev = IdsEvent.model_validate(payload["event"])
        except (KeyError, ValueError):
            self._rejected += 1
            return None
        # attribution from the VERIFIED identity, and carry seq for dedupe
        return ev.model_copy(update={"node": payload["node"], "id": f"{payload['node']}:{payload['seq']}"})

    def _http_pull(self, since: int) -> RelayBatch:
        url = f"{self._relay_url}/api/ids/relay?since={since}&limit=500"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return RelayBatch.model_validate_json(r.read())


def _seq_of(ev: IdsEvent) -> int:
    # id was set to "<node>:<seq>" on open; recover seq for the dedupe key
    try:
        return int(ev.id.rsplit(":", 1)[-1])
    except (ValueError, AttributeError):
        return -1


def build_mesh_source() -> MeshDataSource:
    """Construct the master aggregator from env. Fail-closed: a missing master
    key or relay URL is a hard error, never a silent fall-back to trust."""
    key_path = os.environ.get("GUI_IDS_MASTER_KEY")
    relay_url = os.environ.get("GUI_IDS_RELAY_URL")
    if not key_path or not relay_url:
        raise RuntimeError(
            "GUI_IDS=mesh requires GUI_IDS_MASTER_KEY and GUI_IDS_RELAY_URL"
        )
    with open(key_path, encoding="utf-8") as fh:
        master_private = load_master_private(fh.read().strip())

    from app.ids_registry import verify_key_for
    from app.sources.host import HostDataSource

    return MeshDataSource(
        master_private=master_private,
        verify_key_for=verify_key_for,
        relay_url=relay_url,
        local=HostDataSource(),  # the master's own host feed, merged in
    )

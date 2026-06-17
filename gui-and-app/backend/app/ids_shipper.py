"""IDS alert shipper — the node-side outbound half of the mesh.

Runs on each sensor node. Periodically reads the node's local feed, finds events
it hasn't shipped, seals+signs each (app/ids_crypto.py) and POSTs it to the hub's
relay. The master pulls and decrypts (app/sources/mesh.py). This is the only
component that talks off-node.

Sequence numbers are per-node and monotonic ACROSS restarts (persisted), so the
master's (node, seq) dedupe and future gap detection are meaningful. A seq is
consumed only on a successful POST — if the hub is down, nothing is consumed and
the same events retry next cycle (the feed isn't lost, just delayed). Already-
shipped events are tracked by their stable id so a re-read of the journal window
doesn't re-ship them.

stdlib only (urllib) — no extra dep on a hardened node. Runs as a daemon thread
so the sync journald/HTTP work never blocks the FastAPI event loop.
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
import urllib.error
import urllib.request

from app.ids_crypto import b64, load_master_public, load_signing, seal_sign

_TIMEOUT = 5.0
_INTERVAL = float(os.environ.get("GUI_IDS_SHIP_INTERVAL", "10"))
_WINDOW = int(os.environ.get("GUI_IDS_SHIP_WINDOW", "200"))


class Shipper:
    """Tails a local DataSource and ships unsent events to the hub relay."""

    def __init__(
        self,
        *,
        source,
        node_addr: str,
        signing_key,
        master_public,
        relay_url: str,
        state_path: str,
        poster=None,
        interval: float = _INTERVAL,
        window: int = _WINDOW,
    ) -> None:
        self._source = source
        self._node = node_addr
        self._signing = signing_key
        self._master_pub = master_public
        self._relay_url = relay_url.rstrip("/")
        self._state_path = state_path
        self._post = poster or self._http_post
        self._interval = interval
        self._window = window
        self._seq, self._order = self._load_state()
        self._seen = set(self._order)

    # --- one cycle: ship every unsent event, oldest-first ---

    def ship_once(self) -> int:
        events = [e for e in self._source.ids(limit=self._window) if e.id not in self._seen]
        events.sort(key=lambda e: e.at)  # oldest-first → seq follows time order
        shipped = 0
        for e in events:
            seq = self._seq + 1
            payload = {"node": self._node, "seq": seq, "event": e.model_dump(mode="json")}
            blob = seal_sign(payload, self._signing, self._master_pub)
            if not self._post(self._node, seq, b64(blob)):
                break  # hub down — don't consume seq; retry next cycle
            self._seq = seq
            self._seen.add(e.id)
            self._order.append(e.id)
            shipped += 1
        if shipped:
            self._bound_seen()
            self._save_state()
        return shipped

    def run_forever(self) -> None:
        while True:
            try:
                self.ship_once()
            except Exception:  # a transient read/encode error must not kill the loop
                pass
            time.sleep(self._interval)

    # --- transport ---

    def _http_post(self, node: str, seq: int, ct: str) -> bool:
        body = json.dumps({"node": node, "seq": seq, "ct": ct}).encode("utf-8")
        req = urllib.request.Request(
            f"{self._relay_url}/api/ids/relay",
            data=body,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
                return r.status in (200, 201)
        except (urllib.error.URLError, OSError):
            return False

    # --- persistent state (seq + recently-shipped ids) ---

    def _load_state(self) -> tuple[int, list[str]]:
        try:
            with open(self._state_path, encoding="utf-8") as fh:
                s = json.load(fh)
            return int(s.get("seq", 0)), list(s.get("seen", []))
        except (FileNotFoundError, ValueError, OSError):
            return 0, []

    def _save_state(self) -> None:
        os.makedirs(os.path.dirname(self._state_path) or ".", exist_ok=True)
        tmp = f"{self._state_path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"seq": self._seq, "seen": self._order}, fh)
        os.replace(tmp, self._state_path)  # atomic

    def _bound_seen(self) -> None:
        cap = self._window * 2
        if len(self._order) > cap:
            self._order = self._order[-cap:]
            self._seen = set(self._order)


def build_shipper(source) -> Shipper | None:
    """Construct the shipper from env, or None if this node isn't a shipper
    (e.g. the master, which has no node signing key). Needs the relay URL, the
    node's Ed25519 key, the master's public key, and the node's own wg0 address
    (the identity the hub will see as the source)."""
    relay_url = os.environ.get("GUI_IDS_RELAY_URL")
    node_key = os.environ.get("GUI_IDS_NODE_KEY")
    master_pub = os.environ.get("GUI_IDS_MASTER_PUBKEY")
    node_addr = os.environ.get("GUI_IDS_NODE_ADDR") or os.environ.get("GUI_BIND")
    if not (relay_url and node_key and master_pub and node_addr):
        return None

    with open(node_key, encoding="utf-8") as fh:
        signing = load_signing(fh.read().strip())
    with open(master_pub, encoding="utf-8") as fh:
        master_public = load_master_public(fh.read().strip())

    keydir = os.path.dirname(node_key) or os.path.join(
        os.environ.get("GUI_DB_DIR", "/var/lib/vpn-pi"), "ids"
    )
    state_path = os.environ.get("GUI_IDS_STATE", os.path.join(keydir, "shipper-state.json"))

    return Shipper(
        source=source,
        node_addr=node_addr,
        signing_key=signing,
        master_public=master_public,
        relay_url=relay_url,
        state_path=state_path,
    )


def start_shipper(source) -> Shipper | None:
    """Build the shipper and run it in a daemon thread. Returns it (or None)."""
    shipper = build_shipper(source)
    if shipper is None:
        return None
    threading.Thread(target=shipper.run_forever, name="ids-shipper", daemon=True).start()
    return shipper

"""Wire models for the GUI API.

These mirror the daemon's Go types 1:1 so the eventual status-socket seam is a
straight deserialization, not a translation layer:

  heal.PeerStatus  -> PeerStatus   (mesh health)
  heal.State       -> PeerState    (ok | stale | degraded)
  alert.Event      -> IdsEvent     (one source feeding the IDS feed)

The IDS feed is broader than mesh transitions — auditd/udev host events (USB
insertion, console login, unexpected reboot) land here too — so IdsEvent carries
a `source` and `severity` the daemon's mesh Event doesn't. Mesh transitions are
just one source among several.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel


class PeerState(str, Enum):
    """Mirrors daemon heal.State. Order is the severity ladder."""

    OK = "ok"
    STALE = "stale"
    DEGRADED = "degraded"


class PeerStatus(BaseModel):
    """One peer's mesh-health row. Mirrors daemon heal.PeerStatus."""

    peer: str  # WireGuard public key — stable identity
    name: str  # human label, e.g. "sirius"
    state: PeerState
    last_handshake: datetime | None  # None == never handshaked
    endpoint: str | None


class NodeIdentity(BaseModel):
    """Who this pane of glass is reporting *for*. Each node serves its own."""

    name: str
    role: str  # "spoke" | "relay" — mirrors daemon heal.Role.String()
    public_key: str
    wg_interface: str


class MeshSnapshot(BaseModel):
    """Everything the mesh-health panel needs for one render."""

    node: NodeIdentity
    peers: list[PeerStatus]
    generated_at: datetime


class IdsSource(str, Enum):
    """Where an IDS event came from. Only MESH exists in the daemon today;
    the host sources are placeholders the skeleton already renders so the panel
    is shaped right when auditd/udev sensors land."""

    MESH = "mesh"  # peer/handshake transition, from the daemon
    USB = "usb"  # udev device insertion
    LOGIN = "login"  # auditd console / session login
    REBOOT = "reboot"  # unexpected restart


class IdsSeverity(str, Enum):
    INFO = "info"
    WARN = "warn"
    CRIT = "crit"


class IdsEvent(BaseModel):
    """One line in the IDS feed. Mesh transitions map from daemon alert.Event;
    host events come from sensors not yet built."""

    id: str
    at: datetime
    source: IdsSource
    severity: IdsSeverity
    subject: str  # node/peer/device the event is about
    message: str  # human-readable, already rendered

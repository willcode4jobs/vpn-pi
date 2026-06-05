"""Wire models for the GUI API.

The GUI is the surface for two island concerns:

  - Files — the wg0-bound file share between nodes (the headline "island
    service": proof the island provides its own internet-like services).
  - IDS   — host/physical security events (auditd/udev/fail2ban: USB insertion,
    console login, auth bans, unexpected reboot).

Each node serves its own pane over loopback/wg0; NodeIdentity says who it is
reporting for. There is no peer/mesh-health surface here — that was a daemon
sensor coupling and has been cut.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel


class NodeIdentity(BaseModel):
    """Who this pane of glass is reporting *for*. Each node serves its own."""

    name: str  # star name, e.g. "polaris"
    role: str  # "spoke" | "relay"
    wg_interface: str  # the island interface the services bind to


class SharedFile(BaseModel):
    """One entry in the island file share. `id` is the SQLite row id — the
    handle the GUI uses to download or delete."""

    id: int
    name: str  # path/filename within the share root
    size: int  # bytes
    node: str  # which node contributed it (the share is island-wide)
    modified: datetime


class FilesSnapshot(BaseModel):
    """Everything the Files panel needs for one render. `root`/`bind` head the
    panel so the operator can see the share is wg0-bound, never public."""

    root: str  # share root path on disk, e.g. "/srv/island"
    bind: str  # where the file service listens, e.g. "wg0:21"
    files: list[SharedFile]


class IdsSource(str, Enum):
    """Where a host-security event came from. All are local host sensors — no
    mesh/daemon source. USB/LOGIN/AUTH/REBOOT are the sensors the hardened base
    already has signal for (udev, auditd, fail2ban, uptime)."""

    USB = "usb"  # udev device insertion
    LOGIN = "login"  # auditd console / session login
    AUTH = "auth"  # fail2ban ban / repeated auth failure
    REBOOT = "reboot"  # unexpected restart


class IdsSeverity(str, Enum):
    INFO = "info"
    WARN = "warn"
    CRIT = "crit"


class IdsEvent(BaseModel):
    """One line in the IDS feed. Host sensor events, already rendered."""

    id: str
    at: datetime
    source: IdsSource
    severity: IdsSeverity
    subject: str  # node/device/user the event is about
    message: str  # human-readable, already rendered

"""Synthetic data source — node identity + host-IDS feed with no real node.

Stands in for the real per-node sensors so the screen can be built before
auditd/udev/fail2ban wiring exists. Files are NOT here — they're a real SQLite
store now (app/db.py). IDS events are seeded host-security records, newest first.
Deterministic given a start time — no randomness — so a reload doesn't reshuffle,
but timestamps advance off boot so the feed looks live under polling.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from app.models import (
    IdsEvent,
    IdsSeverity,
    IdsSource,
    NodeIdentity,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class MockDataSource:
    """Satisfies the DataSource protocol with synthetic, time-advancing data.

    Node identity is real per-node config (set GUI_NODE_NAME on each node) so
    uploads from sirius are attributed to sirius; the IDS feed is still synthetic.
    """

    def __init__(self) -> None:
        self._self = NodeIdentity(
            name=os.environ.get("GUI_NODE_NAME", "polaris"),
            role=os.environ.get("GUI_NODE_ROLE", "relay"),
            wg_interface=os.environ.get("GUI_WG_IFACE", "wg0"),
        )
        # Anchor timestamps to construction so ages grow as the app runs.
        self._epoch = _now()

    def node(self) -> NodeIdentity:
        return self._self

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        # Fixed seed host-security events, timestamped relative to boot, newest
        # first. Covers every sensor so the panel is shaped right before real
        # auditd/udev/fail2ban wiring exists.
        seed = [
            (52, IdsSource.USB, IdsSeverity.WARN,
             "sirius", "udev: USB mass-storage inserted on sirius (sdb, 14.4 GB)"),
            (140, IdsSource.AUTH, IdsSeverity.CRIT,
             "vega", "fail2ban: banned 203.0.113.77 — 5 failed ssh auths in 60s"),
            (300, IdsSource.LOGIN, IdsSeverity.INFO,
             "polaris", "auditd: console login billy on tty1"),
            (640, IdsSource.REBOOT, IdsSeverity.WARN,
             "altair", "unexpected reboot detected on altair (uptime reset)"),
            (900, IdsSource.LOGIN, IdsSeverity.INFO,
             "polaris", "auditd: ssh session opened for billy from 192.168.1.50"),
        ]
        events = [
            IdsEvent(
                id=f"evt-{i}",
                at=self._epoch - timedelta(seconds=age_s),
                source=src,
                severity=sev,
                subject=subject,
                message=msg,
            )
            for i, (age_s, src, sev, subject, msg) in enumerate(seed)
        ]
        events.sort(key=lambda e: e.at, reverse=True)
        return events[:limit]

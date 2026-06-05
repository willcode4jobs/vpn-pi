"""Synthetic data source — runs the GUI with no node, no wg, no file server.

Stands in for the real per-node backends so the screen can be built and the
layout locked before the island file share and the host sensors exist. Files are
a fixed island listing; IDS events are seeded host-security records, newest
first. Deterministic given a start time — no randomness — so a reload doesn't
reshuffle, but timestamps advance off boot so the feed looks live under polling.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models import (
    FilesSnapshot,
    IdsEvent,
    IdsSeverity,
    IdsSource,
    NodeIdentity,
    SharedFile,
)

_SELF = NodeIdentity(name="polaris", role="relay", wg_interface="wg0")

# The island file share, wg0-bound. (name, size bytes, contributing node, age-at-epoch secs)
_SHARE_ROOT = "/srv/island"
_SHARE_BIND = "wg0:21"
_FILES = [
    ("topology-v3.pdf", 482_113, "polaris", 1_800),
    ("harden-base.sh", 9_244, "vega", 5_400),
    ("capture-2026-06-04.pcap", 18_446_201, "sirius", 240),
    ("threat-model.md", 31_002, "polaris", 86_400),
    ("altair-keys.tar.gz.age", 2_103, "altair", 600),
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


class MockDataSource:
    """Satisfies the DataSource protocol with synthetic, time-advancing data."""

    def __init__(self) -> None:
        # Anchor timestamps to construction so ages grow as the app runs.
        self._epoch = _now()

    def node(self) -> NodeIdentity:
        return _SELF

    def files(self) -> FilesSnapshot:
        files = [
            SharedFile(
                name=name,
                size=size,
                node=node,
                modified=self._epoch - timedelta(seconds=age_s),
            )
            for name, size, node, age_s in _FILES
        ]
        files.sort(key=lambda f: f.modified, reverse=True)  # newest first
        return FilesSnapshot(root=_SHARE_ROOT, bind=_SHARE_BIND, files=files)

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

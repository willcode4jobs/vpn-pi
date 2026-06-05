"""Synthetic data source — runs the skeleton with no daemon, no wg, no nodes.

Models one node's view of the 5-node star (polaris/vega/sirius/altair/arcturus).
Handshake ages advance off a fixed epoch so the screen looks live under polling:
peers drift toward stale, one is parked degraded, the feed is most-recent-first.
Deterministic given a start time — no randomness — so a reload doesn't reshuffle.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models import (
    IdsEvent,
    IdsSeverity,
    IdsSource,
    MeshSnapshot,
    NodeIdentity,
    PeerState,
    PeerStatus,
)

# Staleness threshold mirrors the daemon's DefaultConfig (180s). Past this a peer
# reads stale; the daemon latches degraded once remediation is exhausted.
STALENESS = timedelta(seconds=180)

_SELF = NodeIdentity(
    name="polaris",
    role="relay",
    public_key="pol1Xn4kQ2bV8sR0aZ7yL3mC6dF9gH2jK5nP8qT1wE=",
    wg_interface="wg0",
)

# (name, pubkey, handshake-age-at-epoch seconds | None=never, endpoint)
_PEERS = [
    ("vega", "veg7Yh2mN9cB4xS1aD6fG3jL0pQ8rT5wZ2eR7yU4iO=", 14, "203.0.113.41:51820"),
    ("sirius", "sir3Kp9wQ1zX7vC2bN5mD8fH4jL6gT0rY3eU9iA2sP=", 47, "198.51.100.22:51820"),
    ("altair", "alt5Lq2eR8tY1uI4oP7aS0dF3gH6jK9nB2vC5xZ8mQ=", 205, "192.0.2.88:51820"),
    ("arcturus", "arc9Zx4cV7bN2mM5kL8jH1gF6dS3aP0qW9eR4tY7uI=", None, None),
]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _classify(age: timedelta | None) -> PeerState:
    """Skeleton stand-in for the daemon's decide ladder: < threshold -> ok,
    over -> stale, never-handshaked -> degraded (treated as breaker-latched)."""
    if age is None:
        return PeerState.DEGRADED
    if age < STALENESS:
        return PeerState.OK
    return PeerState.STALE


class MockDataSource:
    """Satisfies the DataSource protocol with synthetic, time-advancing data."""

    def __init__(self) -> None:
        # Anchor handshakes to construction time so ages grow as the app runs.
        self._epoch = _now()

    def mesh(self) -> MeshSnapshot:
        now = _now()
        drift = now - self._epoch  # real elapsed time since boot
        peers: list[PeerStatus] = []
        for name, pub, age_s, endpoint in _PEERS:
            if age_s is None:
                last_hs = None
                age: timedelta | None = None
            else:
                age = timedelta(seconds=age_s) + drift
                last_hs = now - age
            peers.append(
                PeerStatus(
                    peer=pub,
                    name=name,
                    state=_classify(age),
                    last_handshake=last_hs,
                    endpoint=endpoint,
                )
            )
        return MeshSnapshot(node=_SELF, peers=peers, generated_at=now)

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        # Fixed seed events, timestamped relative to boot, newest first. Covers
        # every source so the panel is shaped right before real sensors exist.
        base = self._epoch
        seed = [
            (8, IdsSource.MESH, IdsSeverity.CRIT,
             "arcturus", "peer arcturus degraded — no handshake, remediation exhausted"),
            (52, IdsSource.USB, IdsSeverity.WARN,
             "sirius", "udev: USB mass-storage inserted on sirius (sdb, 14.4 GB)"),
            (140, IdsSource.MESH, IdsSeverity.WARN,
             "altair", "peer altair stale — handshake age past 180s threshold"),
            (300, IdsSource.LOGIN, IdsSeverity.INFO,
             "polaris", "auditd: console login billy on tty1"),
            (640, IdsSource.REBOOT, IdsSeverity.WARN,
             "vega", "unexpected reboot detected on vega (uptime reset)"),
            (900, IdsSource.MESH, IdsSeverity.INFO,
             "sirius", "peer sirius recovered — handshake within threshold"),
        ]
        events = [
            IdsEvent(
                id=f"evt-{i}",
                at=base - timedelta(seconds=age_s),
                source=src,
                severity=sev,
                subject=subject,
                message=msg,
            )
            for i, (age_s, src, sev, subject, msg) in enumerate(seed)
        ]
        events.sort(key=lambda e: e.at, reverse=True)
        return events[:limit]

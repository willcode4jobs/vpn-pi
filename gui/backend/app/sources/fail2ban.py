"""Live fail2ban jail status — who is banned right now, journal-derived.

**No privilege elevation.** Rather than `sudo fail2ban-client` (a root socket +
a sudoers rule), this reads the fail2ban journal — the same `journalctl -u
fail2ban` the IDS feed already uses (app/sources/journal.py) — and reconstructs
current state by replaying Ban / Unban events in the window (last action per
(jail, ip) wins). It needs only the `systemd-journal` group the service already
holds for the IDS sensors: no sudoers, no root, no new attack surface.

Tradeoff vs fail2ban-client: window-bounded — a ban older than GUI_IDS_SINCE
(default -24h) that is still active won't appear, and `total_banned` counts Ban
events in the window, not fail2ban's all-time total. Fine for a live "who's
locked out" readout, and worth it to add zero privilege.

Degrades to [] on any read failure. The journalctl runner is injected for tests;
results are cached briefly so the 2s UI poll doesn't re-spawn journalctl.
"""

from __future__ import annotations

import os
import re
from typing import Callable

from app.models import JailStatus
from app.sources import journal
from app.sources.cache import TTLCache

Fail2banRunner = Callable[[], str]
_WINDOW = os.environ.get("GUI_IDS_SINCE", "-24h")
_LIMIT = int(os.environ.get("GUI_IDS_PER_SENSOR_LIMIT", "500"))
_TTL = float(os.environ.get("GUI_IDS_CACHE_TTL", "3"))

# "[jail] Ban <ip>" / "[jail] Unban <ip>" (Restore Ban on a fail2ban restart too).
_BAN_RE = re.compile(r"\[([\w-]+)\]\s+(?:Restore\s+)?Ban\s+((?:\d{1,3}\.){3}\d{1,3})")
_UNBAN_RE = re.compile(r"\[([\w-]+)\]\s+Unban\s+((?:\d{1,3}\.){3}\d{1,3})")


def _default_runner() -> str:
    return journal.run(["-u", "fail2ban", "-o", "json", "--since", _WINDOW, "-n", str(_LIMIT)])


class Fail2banSource:
    """Reconstructs current jail state from the fail2ban journal (Ban − Unban)."""

    def __init__(self, runner: Fail2banRunner | None = None) -> None:
        self._run = runner or _default_runner
        self._cache: TTLCache[list[JailStatus]] = TTLCache(_TTL)

    def jails(self) -> list[JailStatus]:
        return self._cache.get_or_compute(self._derive)

    def _derive(self) -> list[JailStatus]:
        # journal is chronological → last action per (jail, ip) wins.
        banned: dict[str, dict[str, bool]] = {}  # jail -> {ip: is_currently_banned}
        totals: dict[str, int] = {}              # jail -> Ban events seen in window
        for rec in journal.parse(self._run()):
            msg = journal.message(rec)
            m = _BAN_RE.search(msg)
            if m:
                jail, ip = m.group(1), m.group(2)
                banned.setdefault(jail, {})[ip] = True
                totals[jail] = totals.get(jail, 0) + 1
                continue
            u = _UNBAN_RE.search(msg)
            if u:
                jail, ip = u.group(1), u.group(2)
                banned.setdefault(jail, {})[ip] = False
        return [
            JailStatus(
                jail=jail,
                currently_banned=sum(ips.values()),
                total_banned=totals.get(jail, 0),
                banned_ips=sorted(ip for ip, is_banned in ips.items() if is_banned),
            )
            for jail, ips in banned.items()
        ]


def build_fail2ban_source() -> Fail2banSource:
    return Fail2banSource()

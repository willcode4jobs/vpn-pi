"""Live fail2ban jail status — who is banned right now, journal-derived.

**No privilege elevation.** Rather than `sudo fail2ban-client` (a root socket +
a sudoers rule), this reads the fail2ban journal — the same `journalctl -u
fail2ban` the IDS feed already uses — and reconstructs current state by replaying
Ban / Unban events in the window (last action per (jail, ip) wins). It needs only
the `systemd-journal` group the service already holds for the IDS sensors: no
sudoers, no root, no new attack surface.

Tradeoff vs fail2ban-client: window-bounded — a ban older than GUI_IDS_SINCE
(default -24h) that is still active won't appear, and `total_banned` counts Ban
events in the window, not fail2ban's all-time total. Fine for a live "who's
locked out" readout, and worth it to add zero privilege.

Degrades to [] on any read failure. The journalctl runner is injected for tests;
results are cached briefly so the 2s UI poll doesn't re-spawn journalctl.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
from typing import Callable

from app.models import JailStatus

Fail2banRunner = Callable[[], str]
_WINDOW = os.environ.get("GUI_IDS_SINCE", "-24h")
_LIMIT = int(os.environ.get("GUI_IDS_PER_SENSOR_LIMIT", "500"))
_TIMEOUT_S = 10
_TTL = float(os.environ.get("GUI_IDS_CACHE_TTL", "3"))

# "[jail] Ban <ip>" / "[jail] Unban <ip>" (Restore Ban on a fail2ban restart too).
_BAN_RE = re.compile(r"\[([\w-]+)\]\s+(?:Restore\s+)?Ban\s+((?:\d{1,3}\.){3}\d{1,3})")
_UNBAN_RE = re.compile(r"\[([\w-]+)\]\s+Unban\s+((?:\d{1,3}\.){3}\d{1,3})")


def _default_runner() -> str:
    """`journalctl -u fail2ban -o json` over the window → stdout, "" on failure.
    No sudo — read via the systemd-journal group."""
    try:
        proc = subprocess.run(
            [
                "journalctl", "--no-pager", "-u", "fail2ban", "-o", "json",
                "--since", _WINDOW, "-n", str(_LIMIT),
            ],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout if proc.returncode == 0 else ""


def _message(rec: dict) -> str:
    m = rec.get("MESSAGE")
    if isinstance(m, list):
        try:
            return bytes(m).decode("utf-8", "replace")
        except (ValueError, TypeError):
            return ""
    return m or ""


class Fail2banSource:
    """Reconstructs current jail state from the fail2ban journal (Ban − Unban)."""

    def __init__(self, runner: Fail2banRunner | None = None) -> None:
        self._run = runner or _default_runner
        self._lock = threading.Lock()
        self._cache: tuple[float, list[JailStatus]] | None = None

    def jails(self) -> list[JailStatus]:
        with self._lock:
            if self._cache is not None and time.monotonic() - self._cache[0] < _TTL:
                return self._cache[1]
            result = self._derive()
            self._cache = (time.monotonic(), result)
            return result

    def _derive(self) -> list[JailStatus]:
        # journal is chronological → last action per (jail, ip) wins.
        banned: dict[str, dict[str, bool]] = {}  # jail -> {ip: is_currently_banned}
        totals: dict[str, int] = {}              # jail -> Ban events seen in window
        for line in self._run().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = _message(rec)
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
        out: list[JailStatus] = []
        for jail, ips in banned.items():
            current = sorted(ip for ip, is_banned in ips.items() if is_banned)
            out.append(
                JailStatus(
                    jail=jail,
                    currently_banned=len(current),
                    total_banned=totals.get(jail, 0),
                    banned_ips=current,
                )
            )
        return out


def build_fail2ban_source() -> Fail2banSource:
    return Fail2banSource()

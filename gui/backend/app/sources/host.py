"""HostDataSource — the real per-node IDS feed, read from journald.

Satisfies the DataSource seam (base.py) by shelling to `journalctl -o json` and
mapping host-security events to IdsEvent. No new dependency — stdlib subprocess
only, the same discipline as RemoteFileStore (app/remote.py). The journal already
carries every sensor the model defines:

    AUTH    fail2ban bans         journalctl -u fail2ban   (MESSAGE has "Ban <ip>")
    LOGIN   ssh / console logins  journalctl _COMM=sshd    ("Accepted ... for <u>")
    USB     mass-storage inserts  journalctl -k            ("usb-storage ...")
    REBOOT  boots recorded        journalctl -k            ("Linux version ...")

Selected by GUI_IDS=host (app/sources/factory.py). Reading the journal as a
non-root service needs the service user in the `systemd-journal` group; if a read
fails (no journalctl, permission denied, non-zero exit) the feed degrades to
empty rather than crashing the API — a blank panel under the GUI's silent-node
staleness signal, not a 500.

The journalctl invocation is injected (the `runner` arg) so the parsing is
unit-testable with canned journald JSON and no live journal.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from typing import Callable

from app.models import IdsEvent, IdsSeverity, IdsSource, NodeIdentity

# How far back each query looks, and a hard cap per query so a chatty journal
# can't blow up a single /api/ids call. Both overridable for tuning.
_SINCE = os.environ.get("GUI_IDS_SINCE", "-24h")
_PER_SENSOR_LIMIT = int(os.environ.get("GUI_IDS_PER_SENSOR_LIMIT", "200"))
_TIMEOUT_S = 10

# Runs `journalctl --no-pager <args...>` and returns stdout. Injectable for tests.
JournalRunner = Callable[[list[str]], str]

_IP_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_LOGIN_RE = re.compile(r"for (?:invalid user )?(\S+) from (\S+)")
_USB_RE = re.compile(r"usb-storage\s+([\w\-:.]+)")


def _default_runner(args: list[str]) -> str:
    """Invoke journalctl; return stdout, or "" on any failure. The feed must
    degrade, never crash the API."""
    try:
        proc = subprocess.run(
            ["journalctl", "--no-pager", *args],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout if proc.returncode == 0 else ""


def _message(rec: dict) -> str:
    """journald MESSAGE is usually a str, but binary messages arrive as a list
    of byte values — coerce both to text."""
    m = rec.get("MESSAGE")
    if isinstance(m, list):
        try:
            return bytes(m).decode("utf-8", "replace")
        except (ValueError, TypeError):
            return ""
    return m or ""


def _at(rec: dict) -> datetime | None:
    """__REALTIME_TIMESTAMP is microseconds since the epoch (as a string)."""
    ts = rec.get("__REALTIME_TIMESTAMP")
    try:
        return datetime.fromtimestamp(int(ts) / 1_000_000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None


def _event(
    rec: dict, source: IdsSource, severity: IdsSeverity, subject: str
) -> IdsEvent | None:
    """Build one IdsEvent from a journald record, or None if it lacks a usable
    timestamp/message."""
    at = _at(rec)
    msg = _message(rec)
    if at is None or not msg:
        return None
    ident = rec.get("SYSLOG_IDENTIFIER") or rec.get("_COMM") or source.value
    rendered = msg if msg.startswith(ident) else f"{ident}: {msg}"
    return IdsEvent(
        id=rec.get("__CURSOR") or f"{source.value}-{rec.get('__REALTIME_TIMESTAMP', '')}",
        at=at,
        source=source,
        severity=severity,
        subject=subject,
        message=rendered,
    )


class HostDataSource:
    """Reads this node's local journal and renders host-security IdsEvents.

    node() is real per-node config (GUI_NODE_NAME/ROLE/WG_IFACE), same as the
    mock — only the IDS feed becomes real here.
    """

    def __init__(self, runner: JournalRunner | None = None) -> None:
        self._run = runner or _default_runner
        self._self = NodeIdentity(
            name=os.environ.get("GUI_NODE_NAME", "polaris"),
            role=os.environ.get("GUI_NODE_ROLE", "relay"),
            wg_interface=os.environ.get("GUI_WG_IFACE", "wg0"),
        )

    def node(self) -> NodeIdentity:
        return self._self

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        events: list[IdsEvent] = []
        events += self._auth_events()
        events += self._login_events()
        events += self._usb_events()
        events += self._reboot_events()
        events.sort(key=lambda e: e.at, reverse=True)
        return events[:limit]

    # --- one journalctl query per sensor; each degrades to [] on read failure ---

    def _json(self, selector: list[str]) -> list[dict]:
        """Run a JSON query (standard window + cap + selector) and parse the
        json-lines output into records, skipping anything unparseable."""
        out = self._run(
            ["-o", "json", "--since", _SINCE, "-n", str(_PER_SENSOR_LIMIT), *selector]
        )
        recs: list[dict] = []
        for line in out.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return recs

    def _auth_events(self) -> list[IdsEvent]:
        out: list[IdsEvent] = []
        for rec in self._json(["-u", "fail2ban"]):
            msg = _message(rec)
            if "Ban " not in msg:  # bans only, not unbans/notices
                continue
            ip = _IP_RE.search(msg)
            ev = _event(rec, IdsSource.AUTH, IdsSeverity.CRIT, ip.group(0) if ip else "unknown")
            if ev:
                out.append(ev)
        return out

    def _login_events(self) -> list[IdsEvent]:
        out: list[IdsEvent] = []
        for rec in self._json(["_COMM=sshd"]):
            msg = _message(rec)
            if "Accepted " not in msg:  # successful auths; failures are fail2ban's job
                continue
            m = _LOGIN_RE.search(msg)
            subject = f"{m.group(1)}@{m.group(2)}" if m else "unknown"
            ev = _event(rec, IdsSource.LOGIN, IdsSeverity.INFO, subject)
            if ev:
                out.append(ev)
        return out

    def _usb_events(self) -> list[IdsEvent]:
        out: list[IdsEvent] = []
        for rec in self._json(["-k"]):
            msg = _message(rec)
            if "usb-storage" not in msg and "USB Mass Storage" not in msg:
                continue
            m = _USB_RE.search(msg)
            # the captured token ends at the message delimiter ":" — strip it
            device = m.group(1).rstrip(":") if m else "usb"
            ev = _event(rec, IdsSource.USB, IdsSeverity.WARN, device)
            if ev:
                out.append(ev)
        return out

    def _reboot_events(self) -> list[IdsEvent]:
        # Each "Linux version …" kernel line marks a boot. We report boots in the
        # window as WARN; classifying expected vs UNEXPECTED (clean shutdown vs
        # crash) needs prior-shutdown analysis and is deliberately future work.
        out: list[IdsEvent] = []
        for rec in self._json(["-k"]):
            msg = _message(rec)
            if not msg.startswith("Linux version"):
                continue
            ev = _event(rec, IdsSource.REBOOT, IdsSeverity.WARN, "system")
            if ev:
                out.append(ev)
        return out

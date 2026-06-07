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
import threading
import time
from datetime import datetime, timezone
from typing import Callable

from app.models import IdsEvent, IdsSeverity, IdsSource, NodeIdentity

# How far back each query looks, and a hard cap per query so a chatty journal
# can't blow up a single /api/ids call. Both overridable for tuning.
_SINCE = os.environ.get("GUI_IDS_SINCE", "-24h")
_PER_SENSOR_LIMIT = int(os.environ.get("GUI_IDS_PER_SENSOR_LIMIT", "200"))
_TIMEOUT_S = 10
# Cache a full ids() result this long so the 2s UI poll doesn't 1:1 map to a
# storm of journalctl spawns (the journal window is hours — staleness is moot).
_IDS_TTL = float(os.environ.get("GUI_IDS_CACHE_TTL", "3"))

# Runs `journalctl --no-pager <args...>` and returns stdout. Injectable for tests.
JournalRunner = Callable[[list[str]], str]

# A real fail2ban ban is "Ban <ip>" — anchored on a following IP so it can't
# match the unit's own "Started fail2ban.service" / "Fail2Ban Service" lines.
_BAN_RE = re.compile(r"\bBan\s+((?:\d{1,3}\.){3}\d{1,3})")
_LOGIN_RE = re.compile(r"for (?:invalid user )?(\S+) from (\S+)")  # also matches "Failed password for…"
_USB_RE = re.compile(r"usb-storage\s+([\w\-:.]+)")
_JAIL_RE = re.compile(r"\[([\w-]+)\]")  # the fail2ban jail, e.g. [sshd]


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
        # Label this node's own events with its own identity so the NODE column
        # isn't blank on a local feed. Prefer the wg0 address (matches how the
        # master attributes remote events); fall back to the node name. On the
        # master, remote events get re-stamped from the VERIFIED signature
        # (app/sources/mesh.py), so this self-label only governs local rows.
        self._self_node = (
            os.environ.get("GUI_IDS_NODE_ADDR")
            or os.environ.get("GUI_BIND")
            or self._self.name
        )
        self._lock = threading.Lock()
        self._ids_cache: tuple[float, list[IdsEvent]] | None = None
        self._jcache: dict[tuple[str, ...], list[dict]] = {}  # per-compute journal memo

    def node(self) -> NodeIdentity:
        return self._self

    def ids(self, limit: int = 100) -> list[IdsEvent]:
        with self._lock:
            now = time.monotonic()
            if self._ids_cache is not None and now - self._ids_cache[0] < _IDS_TTL:
                return self._ids_cache[1][:limit]
            self._jcache = {}  # fresh per-compute journal memo
            failed = self._failed_auths()  # ip -> aggregated failed-ssh-auth buildup
            events: list[IdsEvent] = []
            events += self._auth_events(failed)        # bans (CRIT), enriched with count
            events += self._bruteforce_events(failed)  # attempts (WARN), one per IP
            events += self._login_events()
            events += self._usb_events()
            events += self._reboot_events()
            for e in events:
                e.node = self._self_node  # this node's own events carry its identity
            events.sort(key=lambda e: e.at, reverse=True)
            self._ids_cache = (time.monotonic(), events)  # stamp at completion
            return events[:limit]

    # --- one journalctl query per sensor; memoized per compute so the two sshd
    #     and the two -k callers don't each re-spawn journalctl. [] on read failure. ---

    def _json(self, selector: list[str]) -> list[dict]:
        """Run a JSON query (standard window + cap + selector) and parse the
        json-lines output into records, skipping anything unparseable."""
        key = tuple(selector)
        if key in self._jcache:
            return self._jcache[key]
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
        self._jcache[key] = recs
        return recs

    def _auth_events(self, failed: dict[str, dict]) -> list[IdsEvent]:
        out: list[IdsEvent] = []
        for rec in self._json(["-u", "fail2ban"]):
            msg = _message(rec)
            m = _BAN_RE.search(msg)  # real "Ban <ip>" only — skips lifecycle lines
            if not m:
                continue
            ip = m.group(1)
            jail = _JAIL_RE.search(msg)
            jail_name = jail.group(1) if jail else "sshd"
            ev = _event(rec, IdsSource.AUTH, IdsSeverity.CRIT, ip)
            if ev:
                # fold in the correlated brute-force count (A2): the ban reads as
                # the consequence of the attempts surfaced by _bruteforce_events.
                n = failed.get(ip, {}).get("count")
                detail = f" — {n} failed {jail_name} auths" if n else ""
                ev.message = f"fail2ban: banned {ip} [{jail_name}]{detail}"
                out.append(ev)
        return out

    def _failed_auths(self) -> dict[str, dict]:
        """Aggregate sshd 'Failed password' lines by source IP — the brute-force
        buildup. ip -> {count, at(latest), user, rec(latest)}. Used for the WARN
        attempt events and to enrich the ban (so one attack = at most two rows,
        not one-per-attempt)."""
        agg: dict[str, dict] = {}
        for rec in self._json(["_COMM=sshd", "_COMM=sshd-session"]):
            msg = _message(rec)
            if "Failed password" not in msg:
                continue
            m = _LOGIN_RE.search(msg)
            if not m:
                continue
            user, ip = m.group(1), m.group(2)
            at = _at(rec)
            cur = agg.get(ip)
            if cur is None:
                agg[ip] = {"count": 1, "at": at, "user": user, "rec": rec}
            else:
                cur["count"] += 1
                if at is not None and (cur["at"] is None or at > cur["at"]):
                    cur.update(at=at, user=user, rec=rec)  # keep the latest attempt
        return agg

    def _bruteforce_events(self, failed: dict[str, dict]) -> list[IdsEvent]:
        """One WARN per source IP for the failed-auth buildup (not per attempt)."""
        out: list[IdsEvent] = []
        for ip, info in failed.items():
            ev = _event(info["rec"], IdsSource.AUTH, IdsSeverity.WARN, ip)
            if ev:
                # STABLE id keyed on the IP (not the latest attempt's cursor), so
                # a new attempt doesn't mint a "new" event that the shipper re-sends.
                ev.id = f"bruteforce-{ip}"
                ev.message = (
                    f"sshd: {info['count']} failed ssh auths from {ip} (user {info['user']})"
                )
                out.append(ev)
        return out

    def _login_events(self) -> list[IdsEvent]:
        out: list[IdsEvent] = []
        # OpenSSH >= 9.6 logs accepted auths from sshd-session, not sshd; match both.
        for rec in self._json(["_COMM=sshd", "_COMM=sshd-session"]):
            msg = _message(rec)
            if "Accepted " not in msg:  # successes only; "Failed password ..." is fail2ban's job
                continue
            m = _LOGIN_RE.search(msg)
            if not m:  # require the "for <user> from <ip>" shape — no bare "unknown" logins
                continue
            ev = _event(rec, IdsSource.LOGIN, IdsSeverity.INFO, f"{m.group(1)}@{m.group(2)}")
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

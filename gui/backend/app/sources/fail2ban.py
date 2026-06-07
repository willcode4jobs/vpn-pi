"""Live fail2ban jail status — who is banned right now.

Reads `fail2ban-client status` (the jail list) and `status <jail>` (currently
banned IPs + counts). fail2ban-client talks to a root-only socket, so the service
runs it through a narrow read-only sudoers grant (see RUNBOOK-ids-nodes.md):

    <svc-user> ALL=(root) NOPASSWD: /usr/bin/fail2ban-client status*

Degrades to an empty list on any failure (no fail2ban, no sudoers, socket down)
rather than erroring the API — same discipline as HostDataSource. The command
runner is injected so the parsing is unit-testable without a live fail2ban.

Distinct from the IDS event stream: bans/attempts there are a historical *feed*;
this is the current *state* (a small live readout). The JAILS panel polls it.
"""

from __future__ import annotations

import re
import subprocess
from typing import Callable

from app.models import JailStatus

Fail2banRunner = Callable[[list[str]], str]
_TIMEOUT_S = 5

_JAIL_LIST_RE = re.compile(r"Jail list:\s*(.*)")
_BANNED_IPS_RE = re.compile(r"Banned IP list:\s*(.*)")
_CUR_BANNED_RE = re.compile(r"Currently banned:\s*(\d+)")
_TOTAL_BANNED_RE = re.compile(r"Total banned:\s*(\d+)")


def _default_runner(args: list[str]) -> str:
    """`sudo -n fail2ban-client <args>` → stdout, or "" on any failure. `-n` so a
    missing sudoers fails fast (non-zero) instead of prompting."""
    try:
        proc = subprocess.run(
            ["sudo", "-n", "fail2ban-client", *args],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_S,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout if proc.returncode == 0 else ""


class Fail2banSource:
    """Parses fail2ban-client output into JailStatus rows."""

    def __init__(self, runner: Fail2banRunner | None = None) -> None:
        self._run = runner or _default_runner

    def jails(self) -> list[JailStatus]:
        m = _JAIL_LIST_RE.search(self._run(["status"]))
        if not m:
            return []
        names = [j for j in m.group(1).replace(",", " ").split() if j]
        out: list[JailStatus] = []
        for name in names:
            status = self._run(["status", name])
            if not status:
                continue
            ips_m = _BANNED_IPS_RE.search(status)
            ips = ips_m.group(1).split() if ips_m else []
            cur = _CUR_BANNED_RE.search(status)
            total = _TOTAL_BANNED_RE.search(status)
            out.append(
                JailStatus(
                    jail=name,
                    currently_banned=int(cur.group(1)) if cur else len(ips),
                    total_banned=int(total.group(1)) if total else 0,
                    banned_ips=ips,
                )
            )
        return out


def build_fail2ban_source() -> Fail2banSource:
    return Fail2banSource()

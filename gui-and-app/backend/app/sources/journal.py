"""Shared journald access — the one place we shell journalctl and degrade.

Both the host sensors (host.py) and the fail2ban jail reader (fail2ban.py) read
the journal the same way: run `journalctl --no-pager …`, tolerate the str-or-
byte-list MESSAGE field, parse `-o json` output, and degrade to empty on any
failure (missing binary, permission, non-zero) rather than crashing the API.
That contract lives here once, with no extra privilege (systemd-journal group).
"""

from __future__ import annotations

import json
import subprocess

_TIMEOUT_S = 10


def run(args: list[str]) -> str:
    """`journalctl --no-pager <args>` → stdout, or "" on any failure."""
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


def message(rec: dict) -> str:
    """journald MESSAGE is usually a str; binary messages arrive as a list of
    byte values — coerce both to text."""
    m = rec.get("MESSAGE")
    if isinstance(m, list):
        try:
            return bytes(m).decode("utf-8", "replace")
        except (ValueError, TypeError):
            return ""
    return m or ""


def parse(out: str) -> list[dict]:
    """`-o json` line output → records, skipping anything unparseable."""
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

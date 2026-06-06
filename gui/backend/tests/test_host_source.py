"""HostDataSource parsing checks — journald JSON → IdsEvent.

No live journal: the journalctl runner is injected and returns canned json-lines.
Locks the mapping (sensor → source/severity/subject) and the degrade-to-empty
behaviour the API relies on.
"""

from __future__ import annotations

import json
import os
import unittest
from unittest import mock

from app.models import IdsSeverity, IdsSource
from app.sources.host import HostDataSource


def _rec(message: str, ts_us: int, *, ident: str = "kernel", comm: str = "kernel") -> str:
    """One journald json-line."""
    return json.dumps(
        {
            "__REALTIME_TIMESTAMP": str(ts_us),
            "__CURSOR": f"cur-{ts_us}",
            "MESSAGE": message,
            "SYSLOG_IDENTIFIER": ident,
            "_COMM": comm,
        }
    )


# canned outputs keyed by the sensor selector present in the journalctl args
_AUTH = "\n".join([_rec("NOTICE [sshd] Ban 203.0.113.77", 2_000_000_000, ident="fail2ban")])
_LOGIN = "\n".join(
    [_rec("Accepted publickey for billy from 192.168.1.50 port 51000", 3_000_000_000, ident="sshd")]
)
_KERNEL = "\n".join(
    [
        _rec("usb-storage 1-1:1.0: USB Mass Storage device detected", 4_000_000_000),
        _rec("Linux version 6.6.0 (builder@pi) ...", 1_000_000_000),
    ]
)


def _runner(args: list[str]) -> str:
    if "fail2ban" in args:
        return _AUTH
    if "_COMM=sshd" in args:
        return _LOGIN
    if "-k" in args:
        return _KERNEL
    return ""


class TestHostSource(unittest.TestCase):
    def setUp(self) -> None:
        self.src = HostDataSource(runner=_runner)

    def test_node_identity_from_env(self) -> None:
        with mock.patch.dict(os.environ, {"GUI_NODE_NAME": "sirius"}, clear=False):
            self.assertEqual(HostDataSource(runner=_runner).node().name, "sirius")

    def test_auth_ban_is_crit_with_ip_subject(self) -> None:
        auth = [e for e in self.src.ids() if e.source is IdsSource.AUTH]
        self.assertEqual(len(auth), 1)
        self.assertEqual(auth[0].severity, IdsSeverity.CRIT)
        self.assertEqual(auth[0].subject, "203.0.113.77")
        self.assertIn("Ban", auth[0].message)

    def test_login_is_info_with_user_at_host_subject(self) -> None:
        login = [e for e in self.src.ids() if e.source is IdsSource.LOGIN]
        self.assertEqual(len(login), 1)
        self.assertEqual(login[0].severity, IdsSeverity.INFO)
        self.assertEqual(login[0].subject, "billy@192.168.1.50")

    def test_usb_insert_is_warn(self) -> None:
        usb = [e for e in self.src.ids() if e.source is IdsSource.USB]
        self.assertEqual(len(usb), 1)
        self.assertEqual(usb[0].severity, IdsSeverity.WARN)
        self.assertEqual(usb[0].subject, "1-1:1.0")

    def test_reboot_from_kernel_version_line(self) -> None:
        reboot = [e for e in self.src.ids() if e.source is IdsSource.REBOOT]
        self.assertEqual(len(reboot), 1)
        self.assertEqual(reboot[0].subject, "system")

    def test_newest_first_and_limited(self) -> None:
        events = self.src.ids(limit=3)
        self.assertEqual(len(events), 3)  # 4 parsed, capped to 3
        ats = [e.at for e in events]
        self.assertEqual(ats, sorted(ats, reverse=True))

    def test_degrades_to_empty_on_read_failure(self) -> None:
        # runner returning "" everywhere (no journalctl / permission denied)
        self.assertEqual(HostDataSource(runner=lambda args: "").ids(), [])


if __name__ == "__main__":
    unittest.main()

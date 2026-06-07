"""Fail2banSource checks — parse fail2ban-client output; degrade to empty.

Injected runner, no live fail2ban. Locks the parse of the jail list and a jail's
banned-IP list, and the empty-on-failure contract the API relies on.
"""

from __future__ import annotations

import unittest

from app.sources.fail2ban import Fail2banSource

_STATUS = "Status\n|- Number of jail:\t1\n`- Jail list:\tsshd\n"
_SSHD = (
    "Status for the jail: sshd\n"
    "|- Filter\n|  |- Currently failed:\t2\n|  |- Total failed:\t10\n"
    "`- Actions\n   |- Currently banned:\t2\n   |- Total banned:\t3\n"
    "   `- Banned IP list:\t203.0.113.77 1.2.3.4\n"
)


def _runner(args: list[str]) -> str:
    if args == ["status"]:
        return _STATUS
    if args == ["status", "sshd"]:
        return _SSHD
    return ""


class TestFail2banSource(unittest.TestCase):
    def test_parses_jail_and_banned_ips(self) -> None:
        jails = Fail2banSource(runner=_runner).jails()
        self.assertEqual(len(jails), 1)
        j = jails[0]
        self.assertEqual(j.jail, "sshd")
        self.assertEqual(j.currently_banned, 2)
        self.assertEqual(j.total_banned, 3)
        self.assertEqual(j.banned_ips, ["203.0.113.77", "1.2.3.4"])

    def test_degrades_to_empty_on_failure(self) -> None:
        # no fail2ban / no sudoers → runner returns "" → empty list, not an error
        self.assertEqual(Fail2banSource(runner=lambda args: "").jails(), [])

    def test_jail_with_no_bans(self) -> None:
        clear = _SSHD.replace("Currently banned:\t2", "Currently banned:\t0").replace(
            "Banned IP list:\t203.0.113.77 1.2.3.4", "Banned IP list:\t"
        )

        def runner(args: list[str]) -> str:
            return _STATUS if args == ["status"] else clear

        j = Fail2banSource(runner=runner).jails()[0]
        self.assertEqual(j.currently_banned, 0)
        self.assertEqual(j.banned_ips, [])


if __name__ == "__main__":
    unittest.main()

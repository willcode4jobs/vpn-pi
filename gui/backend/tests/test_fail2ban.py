"""Fail2banSource checks — current jail state derived from the fail2ban journal.

No sudo, no live fail2ban: the journalctl runner is injected and returns canned
ban/unban json-lines. Locks the Ban−Unban replay (last action wins), the
multi-jail split, and the empty-on-failure contract.
"""

from __future__ import annotations

import json
import unittest

from app.sources.fail2ban import Fail2banSource


def _rec(message: str, ts_us: int) -> str:
    return json.dumps({"__REALTIME_TIMESTAMP": str(ts_us), "MESSAGE": message})


# chronological: .77 banned; .4 banned then unbanned; recidive bans 9.9.9.9
_JOURNAL = "\n".join(
    [
        _rec("Started fail2ban.service - Fail2Ban Service.", 500),  # noise, ignored
        _rec("fail2ban.actions: NOTICE [sshd] Ban 203.0.113.77", 1000),
        _rec("fail2ban.actions: NOTICE [sshd] Ban 1.2.3.4", 2000),
        _rec("fail2ban.actions: NOTICE [sshd] Unban 1.2.3.4", 3000),
        _rec("fail2ban.actions: NOTICE [recidive] Ban 9.9.9.9", 4000),
    ]
)


class TestFail2banSource(unittest.TestCase):
    def test_current_state_from_ban_minus_unban(self) -> None:
        jails = {j.jail: j for j in Fail2banSource(runner=lambda: _JOURNAL).jails()}
        self.assertEqual(set(jails), {"sshd", "recidive"})
        sshd = jails["sshd"]
        self.assertEqual(sshd.banned_ips, ["203.0.113.77"])  # .4 was unbanned
        self.assertEqual(sshd.currently_banned, 1)
        self.assertEqual(sshd.total_banned, 2)  # two Ban events in the window
        self.assertEqual(jails["recidive"].banned_ips, ["9.9.9.9"])

    def test_degrades_to_empty_on_failure(self) -> None:
        # no fail2ban / journal unreadable → runner returns "" → empty list
        self.assertEqual(Fail2banSource(runner=lambda: "").jails(), [])


if __name__ == "__main__":
    unittest.main()

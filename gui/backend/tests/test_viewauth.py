"""View-password gate checks — no-op when unset, fail-closed when set.

Functions exercised directly (no TestClient/httpx), with a fake Request for the
dependency — same approach as the require_peer tests.
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

from fastapi import HTTPException
from starlette.requests import Request

import app.viewauth as va


def _req(authorization: str | None = None) -> Request:
    headers = [(b"authorization", authorization.encode())] if authorization else []
    return Request({"type": "http", "headers": headers})


class TestViewAuthInactive(unittest.TestCase):
    """No GUI_VIEW_PASSWORD -> the gate is a no-op (every other node)."""

    def test_require_view_passes_when_unset(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("GUI_VIEW_PASSWORD", None)
            self.assertIsNone(va.require_view(_req()))  # no raise
            self.assertFalse(va.gate_active())
            self.assertFalse(va.check_password("anything"))


class TestViewAuthActive(unittest.TestCase):
    """GUI_VIEW_PASSWORD set -> fail-closed; only a valid issued token passes."""

    def setUp(self) -> None:
        self._env = mock.patch.dict(os.environ, {"GUI_VIEW_PASSWORD": "s3cret"}, clear=False)
        self._env.start()
        va._TOKENS.clear()

    def tearDown(self) -> None:
        self._env.stop()
        va._TOKENS.clear()

    def test_wrong_password_rejected(self) -> None:
        self.assertFalse(va.check_password("nope"))
        self.assertTrue(va.check_password("s3cret"))

    def test_valid_token_passes_others_401(self) -> None:
        token = va.issue_token()
        self.assertIsNone(va.require_view(_req(f"Bearer {token}")))  # no raise
        for bad in (None, "Bearer ", "Bearer garbage", "s3cret"):
            with self.assertRaises(HTTPException) as cm:
                va.require_view(_req(bad))
            self.assertEqual(cm.exception.status_code, 401)

    def test_tokens_are_distinct(self) -> None:
        self.assertNotEqual(va.issue_token(), va.issue_token())

    def test_expired_token_rejected_and_evicted(self) -> None:
        token = va.issue_token()
        va._TOKENS[token] = 0.0  # force-expire (epoch 0, long past)
        with self.assertRaises(HTTPException) as cm:
            va.require_view(_req(f"Bearer {token}"))
        self.assertEqual(cm.exception.status_code, 401)
        self.assertNotIn(token, va._TOKENS)  # evicted on the failed check


if __name__ == "__main__":
    unittest.main()

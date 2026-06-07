"""View-password gate — human auth for the master's browser-facing reads.

The mesh aggregate (the master's /api/ids + /api/node) is the most sensitive
consolidated feed on the island. require_peer (app/peers.py) authenticates the
*node* by its wg0 address; this adds a *human* gate on top: viewing the aggregate
in a browser needs a password. It lives only on the master (GUI_VIEW_PASSWORD), so
the blind hub never holds it.

Active only when GUI_VIEW_PASSWORD is set — elsewhere require_view is a no-op, so
the single frontend bundle works on every node. When a password IS set the gate is
fail-closed: no valid token -> 401.

POST /api/login compares the password once, in constant time, and mints a random
session token kept in memory (single uvicorn worker; tokens clear on restart). The
browser stores it and sends it as a Bearer header; require_view checks membership,
so the password itself is never sent on the polling requests.

v1 is one shared password (no per-user identity / accountability beyond "knew the
password"). Upgrade path: a user table + signed sessions behind this same seam.
The password must come from a root-owned env file / Infisical, never an inline
unit `Environment=` line (world-readable via `systemctl show`).
"""

from __future__ import annotations

import os
import secrets

from fastapi import HTTPException, Request
from pydantic import BaseModel

# Issued session tokens (this process). High-entropy random; cleared on restart.
_TOKENS: set[str] = set()


class LoginRequest(BaseModel):
    password: str


def _password() -> str | None:
    # read per-call (not cached) so config/tests take effect without reimport
    return os.environ.get("GUI_VIEW_PASSWORD") or None


def gate_active() -> bool:
    return _password() is not None


def check_password(pw: str) -> bool:
    """Constant-time compare of a submitted password to the configured one."""
    p = _password()
    return p is not None and secrets.compare_digest(pw, p)


def issue_token() -> str:
    token = secrets.token_urlsafe(32)
    _TOKENS.add(token)
    return token


def _bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        return auth[len("Bearer ") :].strip() or None
    return None


def require_view(request: Request) -> None:
    """FastAPI dependency. No-op when no password is configured (gate inactive);
    otherwise require a valid issued Bearer token, else 401."""
    if _password() is None:
        return
    token = _bearer(request)
    if token is None or token not in _TOKENS:
        raise HTTPException(status_code=401, detail="view password required")

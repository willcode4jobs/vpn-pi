"""wg0 peer allowlist — island access control + adder attribution.

A request's wg0 source address is matched against the allowlist here to (a)
authorize the request and (b) record WHO added a file. The stored/displayed
value is the raw wg0 IP — no name translation. An IP is unambiguous, always
available, and doesn't need a map kept in sync as nodes come online (e.g.
arcturus, not built yet, will just show its address the day it appears).

Why the source address is trustworthy as authentication: the file authority
binds wg0 only with no proxy in front, so the peer address FastAPI sees IS the
node's wg0 tunnel address — and WireGuard cryptographically pins each peer to
its address (a packet from 10.42.0.5 could only have come through sirius's key).
So an allowlist of wg0 addresses is real per-peer auth. This replaces the prior
"whole 10.42.0.0/24 is trusted" firewall-only scope (docs/worklog-2026-06-05.md).

Addresses from docs/worklog-2026-06-05.md (wg subnet 10.42.0.0/24). The name
beside each is documentation only — it is NOT what gets stored. Edit as the
island grows, or override the whole set at runtime with
GUI_PEERS="10.42.0.1,10.42.0.2,..." (bare IPs; trailing "=name" comments OK).
"""

from __future__ import annotations

import os

# Loopback is always allowed (operator on the host itself, local dev) and stores
# as the literal loopback address — still "just the IP", no translation.
_LOOPBACK = {"127.0.0.1", "::1"}

# The allowlist: wg0 host addresses .1–.7 in the 10.42.0.0/24 island subnet.
# Values are human notes only; auth + storage use the keys (IPs). Unassigned
# slots are pre-allowed so a node works the moment it joins (e.g. arcturus) —
# tighten by deleting unused lines if you want a strict allowlist.
_DEFAULT_PEERS = {
    "10.42.0.1": "polaris",     # master, control-plane
    "10.42.0.2": "vega",        # hub, file authority
    "10.42.0.3": "unassigned",
    "10.42.0.4": "altair",      # endpoint
    "10.42.0.5": "sirius",      # endpoint
    "10.42.0.6": "builder",     # Mac, viewer/dev
    "10.42.0.7": "unassigned",  # arcturus likely lands here (not yet built)
}


def _load() -> set[str]:
    """Allowed wg0 IPs from env (GUI_PEERS) if set, else the documented default.
    An env override REPLACES the default (predictable, no surprise merges).
    Accepts bare IPs or "ip=note" entries; only the IP is used."""
    raw = os.environ.get("GUI_PEERS")
    if not raw:
        return set(_DEFAULT_PEERS)
    out: set[str] = set()
    for entry in raw.split(","):
        ip = entry.split("=", 1)[0].strip()
        if ip:
            out.add(ip)
    if not out:
        raise RuntimeError(f"GUI_PEERS set but no usable IPs parsed from: {raw!r}")
    return out


PEERS = _load()


def resolve(client_ip: str | None) -> str | None:
    """Return the caller's wg0 IP if it is an allowed island peer, else None.

    The returned value IS what gets stored as a file's adder — the raw IP, no
    name lookup. None (unknown or missing address) becomes a 403 in the caller.
    """
    if client_ip is None:
        return None
    if client_ip in _LOOPBACK or client_ip in PEERS:
        return client_ip
    return None

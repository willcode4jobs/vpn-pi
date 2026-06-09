"""A one-slot TTL cache for an expensive read, thread-safe.

Both the host feed and the fail2ban reader poll subprocess-backed data every 2s
(the UI interval) but the underlying journal window is hours — so a few seconds of
staleness is free. This memoizes the whole result for `ttl` seconds across the
FastAPI threadpool + the shipper thread, so the poll doesn't 1:1 map to a storm of
journalctl spawns. The stamp is taken at completion, so a caller that blocks on the
lock during a slow compute gets the fresh result instead of recomputing.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Generic, TypeVar

T = TypeVar("T")


class TTLCache(Generic[T]):
    def __init__(self, ttl: float) -> None:
        self._ttl = ttl
        self._lock = threading.Lock()
        self._stamp = 0.0
        self._value: T | None = None
        self._fresh = False

    def get_or_compute(self, compute: Callable[[], T]) -> T:
        with self._lock:
            if self._fresh and time.monotonic() - self._stamp < self._ttl:
                return self._value  # type: ignore[return-value]
            value = compute()
            self._value = value
            self._stamp = time.monotonic()  # stamp at completion
            self._fresh = True
            return value

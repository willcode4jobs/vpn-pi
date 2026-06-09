"""build_data_source() — pick the IDS/identity source from env.

Mirrors build_store() in app/store.py: one interface (DataSource), several
implementations, chosen by an env var, defaulting to the safe in-process option
so the app runs anywhere with nothing configured.

    GUI_IDS=mock   (default)  synthetic seed — dev/demo, no sensors needed
    GUI_IDS=host              real local journald feed (HostDataSource)
    GUI_IDS=mesh              master-side aggregator (MeshDataSource) — Step 4

Local imports keep the heavier/optional sources off the default path.
"""

from __future__ import annotations

import os

from app.sources.base import DataSource


def build_data_source() -> DataSource:
    kind = os.environ.get("GUI_IDS", "mock").lower()
    if kind == "host":
        from app.sources.host import HostDataSource

        return HostDataSource()
    if kind == "mesh":
        from app.sources.mesh import build_mesh_source

        return build_mesh_source()
    from app.sources.mock import MockDataSource

    return MockDataSource()

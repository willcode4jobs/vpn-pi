# 01 — Architecture

How real per-node alerts get produced, sealed, relayed through the hub, and
aggregated on the master. The design mirrors the file-store seam that already
ships, so most of this is "apply a known pattern," not new invention.

## 1. The whole picture in one diagram

```
 ENDPOINT / ANY NODE (sirius, altair, polaris-local, …)
   journald ──▶ HostDataSource.ids() ──▶ [IdsEvent, …]      (local feed; its own panel)
                      │
                      ▼  shipper loop (new IdsEvents only, by sequence)
              sign(node key) + seal(master pubkey) ──▶ opaque blob {node, seq, ct}
                      │
                      ▼  POST /api/ids/relay   (wg0 → hub; gated by require_peer)
 ──────────────────────────────────────────────────────────────────────────────
 HUB (vega, 10.42.0.2)
   relay buffer (bounded, sqlite) ── stores opaque blobs. CANNOT read or forge. ──┐
   GET /api/ids/relay?since=<cursor>  ◀───────────────────────────────────────────┘
                      ▲
 ──────────────────── │ pull (spoke→hub, reliable) ─────────────────────────────
 MASTER (polaris, 10.42.0.1)  — control-plane only, loopback-bound
   MeshDataSource.ids():
     pull blobs ──▶ open(master priv) + verify(node pub via registry)
                ──▶ dedupe by (node, seq), detect gaps
                ──▶ merge with polaris's OWN local HostDataSource feed
                ──▶ [IdsEvent, …] newest-first  (the mesh view)
   Operator views it via  ssh -L  to polaris:8787  (admin-only)
```

## 2. The seam we reuse (this is the whole trick)

The file share already solved "one interface, swap the implementation by env":

- `DataSource` Protocol — `gui/backend/app/sources/base.py` (`node()`, `ids(limit)`).
- `MockDataSource` — `gui/backend/app/sources/mock.py` (current `SOURCE`).
- The model to copy: `build_store()` in `gui/backend/app/store.py` picks
  `placeholder | sqlite | remote` from `GUI_FILES`; `RemoteFileStore`
  (`gui/backend/app/remote.py`) forwards ops over wg0 with **stdlib `urllib`
  only** (no deps on hardened nodes).

We add the same shape for IDS:

```
build_data_source()  (new, GUI_IDS env)
  GUI_IDS=mock   → MockDataSource          (default; dev unchanged)
  GUI_IDS=host   → HostDataSource          (real journald reader; every node)
  GUI_IDS=mesh   → MeshDataSource          (master only; pulls hub, decrypts, merges)
```

`SOURCE` in `gui/backend/app/main.py:27` changes from a hardwired
`MockDataSource()` to `SOURCE = build_data_source()`. Nothing else in the API
changes — `/api/ids` (`main.py`, `get_ids`) still just calls `SOURCE.ids(limit)`
behind `require_peer`.

## 3. New components

### 3.1 `HostDataSource` — `app/sources/host.py` (new)
Implements `DataSource`. `ids()` reads the local journal and maps to `IdsEvent`:

| `IdsSource` | signal | journald query |
|---|---|---|
| `AUTH` | fail2ban ban | `journalctl -u fail2ban -o json --since …` |
| `LOGIN` | ssh / console login | `journalctl _COMM=sshd` / PAM session-open |
| `USB` | mass-storage insert | `journalctl -k` (kernel usb-storage) |
| `REBOOT` | unexpected restart | `journalctl --list-boots` vs clean-shutdown marker |

Shells to `journalctl` (no new dep, same discipline as `RemoteFileStore`). Reads
need the `systemd-journal` group on the service user — never run as root (§04).
`node()` is unchanged (returns this node's `NodeIdentity`).

### 3.2 Alert shipper — `app/ids_shipper.py` (new)
An asyncio background task started on node backend startup. Tails new
`IdsEvent`s (tracked by a per-node monotonic **sequence number**), seals + signs
each (§03), and POSTs `{node, seq, ct}` to the hub's `/api/ids/relay`. A down hub
must not block the node — retry with backoff, keep going. The shipper is the only
component that talks off-node.

### 3.3 Hub relay — routes in `app/main.py` + `app/relay.py` (new)
Two routes, **on the same port 8787** (no new port, no new nftables rule — they
ride the hub's existing wg0-exposed app):
- `POST /api/ids/relay` — deposit one opaque blob. Gated by `require_peer`
  (`gui/backend/app/peers.py`) so only island peers can deposit. The hub stores
  the blob verbatim; it never decrypts or validates contents.
- `GET /api/ids/relay?since=<cursor>` — drain blobs newer than a cursor. The
  master is the only legitimate caller (also `require_peer`-gated).

Backed by a small **bounded sqlite table** (the hub already runs sqlite for
files). Ciphertext-at-rest is fine — it's opaque. Bounded so a chatty node can't
grow it without limit. Enabled by env (`GUI_IDS_RELAY=1`) so non-hub nodes don't
allocate it.

### 3.4 `MeshDataSource` — `app/sources/mesh.py` (new, master only)
Implements `DataSource`. `ids()`:
1. `GET /api/ids/relay?since=<cursor>` from the hub (stdlib `urllib`).
2. For each blob: `open` with the master private key, `verify` the signature
   against the **node pubkey registry** (§03). Drop anything that fails — a
   failed verify is a security event in itself.
3. Dedupe by `(node, seq)`; flag sequence **gaps** (suppressed/dropped alerts).
4. Merge with the master's own local `HostDataSource` feed, newest-first.

## 4. Model + frontend change (small)

`IdsEvent` (`gui/backend/app/models.py`) gains an explicit originating-node
field so the aggregate view can show it — instead of overloading `subject`:

```python
class IdsEvent(BaseModel):
    id: str
    at: datetime
    node: str          # NEW — verified originating node (from the signing key, not self-reported)
    source: IdsSource
    severity: IdsSeverity
    subject: str        # what the event is ABOUT (device/user) — no longer doubling as the node
    message: str
```

Frontend: add a `node` column to `IdsFeed.tsx` and the `node` field to the
`IdsEvent` type in `gui/frontend/src/types.ts`. Polling (`useIds` in
`gui/frontend/src/api.ts`) is unchanged — the master's `/api/ids` just returns a
merged, multi-node list. Single-node panels look identical (one node value).

> **Decided:** add the `node` field. It's set from the *verified* signing
> identity (not a string parse of `subject`), so it's the trustworthy attribution
> surface — and it frees `subject` to mean what it says (the device/user/IP the
> event is about). One-line model + one-column FE change.

## 5. What does NOT change

- `/api/ids` signature, `require_peer` auth, the polling model, the frontend
  data flow. The aggregation is entirely behind the `DataSource` seam.
- The file share. IDS is a parallel concern reusing the same patterns.

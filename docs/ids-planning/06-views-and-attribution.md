# 06 — Views and attribution

Why the per-node GUI (e.g. vega) and the master GUI (polaris) show **different
data from the same app**, and how the NODE column is filled. This is the
"shouldn't the two GUIs be married?" question, answered. The full pipeline is in
`01-architecture.md`; this doc is the viewing + attribution slice.

## 1. Two views, one app — different by design

Every node runs the **same** React bundle + FastAPI backend. What differs is the
backend's `GUI_IDS` mode and what that node is *allowed to see*:

| GUI | runs | `GUI_IDS` | shows | NODE column |
|---|---|---|---|---|
| **Per-node** (vega, sirius, …) | each node | `host` | that node's **own local feed** | its own wg0 IP |
| **Master** (polaris) | the master only | `mesh` | the **whole-mesh aggregate** | each event's **verified** origin |

They are **not** meant to show the same content — and they *can't*, because of the
blind-relay boundary (§2). The same-ness is: same app, same columns, consistent
attribution. The difference is scope, and it's intentional.

```
 sensor node (vega / sirius / …)                         MASTER (polaris)
 ─────────────────────────────                           ────────────────
 journald ─▶ HostDataSource          POST (sealed)       MeshDataSource (GUI_IDS=mesh)
   self-label node = own wg0 IP ──▶  hub relay  ──pull──▶  open+verify, re-stamp node
   │                                 (opaque,             from the VERIFIED signature,
   ▼                                  blind)               merge with its own local feed
 GUI_IDS=host  →  LOCAL feed                              │
 vega:8787 over wg0                                       ▼
 (its own events only;                                  MESH aggregate (all nodes)
  cannot decrypt others)                                 ssh -L + view-password
```

## 2. Why they can't be "married" (the security reason)

The hub (vega) is a **blind relay**: it buffers sealed ciphertext it has **no key
to read** (`02-threat-model.md`). So vega's GUI can only ever render vega's *own*
local journald feed — it cannot show sirius's or polaris's alerts, because it
can't decrypt them. If it could, the hub would no longer be blind, and a hub
compromise would leak the whole island's alert history — the exact outcome the
design prevents.

Therefore the **whole-mesh view exists only on the master**, the sole holder of
the decryption key, reached over SSH (`04-connectivity-and-deployment.md §6`).
"Unify the content onto every node" is precisely what the architecture forbids.
What we unify instead: the app, the columns, and how NODE is attributed.

## 3. How the NODE column is filled

`IdsEvent.node` (`gui/backend/app/models.py`) is the originating node. It is set
in two different places, with two different trust levels:

### 3.1 A node's own events — self-labeled
`HostDataSource` (`gui/backend/app/sources/host.py`) stamps every local event with
**this node's own address** — `GUI_IDS_NODE_ADDR` (or `GUI_BIND`, falling back to
the node name). This is not a security claim: a node describing *itself* on *its
own* panel can't impersonate anyone. It just stops the column being blank on a
local feed.

### 3.2 Remote events on the master — from the verified signature
This is the trustworthy path. Each alert ships as:

```
outer blob   { node, seq, ct }          ← hub-visible, for routing/dedupe
inner payload { node, seq, at, event }  ← sealed + SIGNED, only the master sees it
```

`MeshDataSource._open` (`gui/backend/app/sources/mesh.py`):
1. decrypts `ct` and **verifies the signature** against the registered key for
   the payload's `node` (`gui/backend/app/ids_registry.py`) — a node can't claim
   to be `10.42.0.5` without `10.42.0.5`'s signing key;
2. **cross-checks** the hub-visible outer `node`/`seq` against the authenticated
   inner ones (mismatch → dropped);
3. sets `IdsEvent.node` from the **verified inner** value — never the
   self-reported or hub-visible one.

So on the master, the NODE column is a **cryptographically verified identity**.
The self-label from §3.1 is overwritten here for remote events (and the two agree
for honest nodes, since both derive from the same wg0 address).

> **Invariant:** displayed attribution on the master comes only from the verified
> signature. The outer `node` (which the hub sees and could lie about) is used
> only for routing and is always cross-checked, never trusted for display.

## 4. Two auth layers, two different jobs

Don't confuse the two gates — they protect different things:

| Gate | File | Authenticates | Applies to |
|---|---|---|---|
| `require_peer` | `app/peers.py` | the **node** by wg0 source address | all data + relay routes, every node |
| `require_view` | `app/viewauth.py` | the **human** by password | the master's browser reads (`/api/node`, `/api/ids`) |

`require_peer` is machine-to-machine (and gates the relay so only island peers
deposit). `require_view` is the human gate on the sensitive aggregate, live only
where `GUI_VIEW_PASSWORD` is set (the master). The hub never holds the password.

## 5. Reaching each view

- **Per-node (local):** browse that node's wg0 address, e.g. `http://10.42.0.2:8787`
  (vega) — gated by `require_peer` (you're a wg0 peer). Shows that node's own feed.
- **Master (mesh):** the master is loopback-bound; tunnel in and supply the
  view-password: `ssh -L 8787:10.42.0.1:8787 polaris` → `http://127.0.0.1:8787`.
  Shows every node's events, verified-attributed, merged with polaris's own.

## 6. Making the scope legible (recommended polish)

Because the two views look identical but differ in scope, the panel should *say*
which one you're on — driven by the backend's `GUI_IDS` mode (exposed on
`/api/node`):

- per-node feed → a `LOCAL · <addr>` tag in the IDS panel head;
- master aggregate → a `MESH · all nodes` tag.

This turns "two GUIs that disagree" into "one app, two clearly-labeled scopes."
Frontend: `gui/frontend/src/components/IdsFeed.tsx`. (Not yet built.)

## 7. Summary

- One app; **scope** differs, not the design.
- vega = its own local feed (blind hub, can't see the mesh). polaris = the whole
  mesh (sole key holder), over SSH + password.
- NODE is self-labeled on a node's own feed, and **verified-from-signature** on
  the master — never a trusted self-report for remote events.
- Unifying *content* everywhere is what blind-relay forbids; unifying the app,
  columns, and attribution is what we do instead.

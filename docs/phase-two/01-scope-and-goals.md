# 01 — Scope & goals

## The reframe

Phase One was a **hub-and-spoke VPN/IDS**: vega relayed all traffic, polaris was
the control master, and trust was a static allowlist of wg0 addresses. Phase Two
reframes the project as a **gated island internet**:

- **Island by default.** Nodes talk to each other; nobody reaches the public
  internet. "Island mode" is the resting state.
- **Gate, not exit node.** Internet access is a privilege that is *opened*, on
  request, through a local-LLM-mediated **canary** — then auto-closed.
- **Peer-to-peer.** The mesh is flat. No node relays for another; there are no hub
  redirects. Every node is a peer.
- **Friending is the trust layer.** Permissions between nodes come from a mutual
  token exchange, not from an IP allowlist or a firewall scope.

## Goals (what "done" means for Phase Two skeleton)

1. A **single end-user App** (one Bun-compiled executable, one process) that:
   - authenticates/authorizes peers via mutual friending (token give → accept);
   - sends messages and writes/downloads files between friends;
   - shows island-mode state (gated vs. internet access);
   - home view: local fail2ban entries, active friend requests, wg connectivity.
2. An **Admin** surface reached at `…/admin` that:
   - manages friendships — **delete yes, force never**;
   - issues a **canary** prompt to the local LLM to open the gate;
   - shares ~all code with the user backend ("very similar… seamless").
3. The **canary keyword is cryptographically signed and sealed** — typing the word
   is not enough; the command must be provably from the admin.

## Non-goals (explicitly out of scope for the skeleton)

- Re-implementing the Phase One IDS blind-relay aggregation. fail2ban entries are
  read *locally* and shown on Home; cross-node IDS aggregation is deferred.
- A polished UI. The frontend is whatever is simplest to serve from the Bun binary
  (see [03](03-architecture.md) — leaning a single static HTML/JS bundle).
- NAT-traversal automation. Mesh endpoints are configured, not auto-discovered
  (flagged as a risk in [02](02-topology.md)).

## Requirements traceability

Every line of `newContextFile.md` maps to a design home:

| newContextFile intent | Lives in |
|---|---|
| Archive old app/gui → archive branch | [07](07-migration-and-build.md) |
| New branch off main, delete files | [07](07-migration-and-build.md) |
| Backend language is **TypeScript / Bun** | [03](03-architecture.md), [07](07-migration-and-build.md) |
| Single file, friending authn/authz | [03](03-architecture.md), [04](04-friending-protocol.md) |
| Token: one gives, other accepts → mutual write | [04](04-friending-protocol.md) |
| Friends message + write/download files | [04](04-friending-protocol.md), [05](05-api-and-data.md) |
| See island mode (gated vs internet) | [02](02-topology.md), [06](06-canary-gate.md) |
| Home: fail2ban, friend requests, wg status | [05](05-api-and-data.md) |
| Admin at `/admin` | [05](05-api-and-data.md) |
| Admin deletes (not forces) friendships | [04](04-friending-protocol.md), [05](05-api-and-data.md) |
| Canary → local LLM opens egress | [06](06-canary-gate.md) |
| Canary signed + sealed | [04](04-friending-protocol.md), [06](06-canary-gate.md) |
| Two backends similar/seamless | [03](03-architecture.md) |
| P2P mesh, no hub redirects | [02](02-topology.md) |
| Gate depends on local LLM (Llama) | [06](06-canary-gate.md) |

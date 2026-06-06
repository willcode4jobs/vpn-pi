# 02 — Threat model

What the blind-relay design protects, what it deliberately does not, and the
honest residual risks. This is the doc that justifies the architecture.

## 1. The principle

**User data stays off the master; security data stays off the edge.** The hub
(vega) is the most-exposed node — it is both the access/exit edge and the wg hub
that decrypts all spoke traffic it routes. The master (polaris) is hardened,
control-plane only, and out of the data path. Therefore the alert history and
the ability to read alerts must live on the **master**, and the hub must be able
to carry alerts without reading them. (`docs/worklog-2026-06-05.md`.)

## 2. Trust boundaries

| Party | Can read alerts? | Can forge alerts? | Can suppress alerts? |
|---|---|---|---|
| Endpoint node (origin) | its own only | only its own (it's the author) | n/a |
| **Hub (vega)** | **No** (ciphertext only) | **No** (no signing key) | **Yes** (it relays) — detectable, §5 |
| Master (polaris) | Yes (holds the private key) | n/a (it's the verifier) | n/a |
| Other island peer | No | No (no valid node key) | No |
| Off-island attacker | blocked at wg0 + `require_peer` | — | — |

Two independent cryptographic guarantees carry this table:
- **Confidentiality** — alerts are sealed to the master's public key, so only the
  master decrypts. The hub stores opaque blobs.
- **Authenticity / integrity** — each alert is signed by the originating node's
  key and verified by the master against a registry of known node keys. A blob
  the hub (or anyone) tampers with or fabricates fails verification and is
  dropped.

## 3. Why not the simpler options

- **Aggregate on the hub (plaintext).** Rejected: a hub compromise would both
  blind detection and leak the entire alert history — the exact outcome the
  control/edge split exists to prevent.
- **Master pulls each node directly.** Rejected for now: the master is a spoke
  and spoke↔spoke is unreliable (the file-store migration proved it —
  `ping 10.42.0.1` was 100% loss). Routing it through the hub would still expose
  plaintext at the hub (a wg hub decrypts what it routes). So direct-pull buys
  nothing on trust and costs a WireGuard topology project. See §04.
- **Shared write-token (the earlier sketch).** Superseded. The node signing key
  is a stronger, per-node credential with no shared secret to rotate, and it
  gives attribution the token never could.

## 4. What the hub still learns (metadata — honest limits)

Blind ≠ invisible. The hub can observe, for each blob:
- **which node** deposited it (the `node` field + the wg0 source address),
- **when** (arrival time) and **roughly how big** the alert is,
- the **rate** of alerts per node.

It cannot read the event content (source, subject, message). For this project
that residual is acceptable: traffic-analysis resistance is out of scope, and the
nodes/hub are all owned, hardened devices. **State this plainly** — do not imply
the hub learns nothing.

## 5. Alert suppression (the real residual risk) and its mitigation

A compromised or failing hub cannot read or forge, but it **can drop blobs** — a
denial-of-alerts attack that is dangerous precisely because absence looks like
"all quiet." Mitigation, built in from the start:

- **Per-node monotonic sequence numbers.** Every alert carries `seq`. The master
  detects gaps: "node sirius jumped seq 40→47 — six alerts missing." A gap is
  itself surfaced as a CRIT meta-event in the mesh view.
- **Heartbeats.** Each node ships a signed heartbeat on an interval even when it
  has no alerts, so a silent node (or a hub withholding its blobs) shows up as
  stale — the same silent-node principle the GUI already uses for polling
  (`gui/frontend/src/api.ts`, the `stale` flag).

This converts suppression from invisible to detectable. It does not prevent it —
preventing it needs a second independent path, which is out of scope.

## 6. Replay and freshness

The hub (or an attacker who captured a blob) could re-deposit old blobs.
Defenses:
- `(node, seq)` dedupe at the master drops replays of already-seen alerts.
- Each blob is signed over `{node, seq, at, event}`, so `seq`/`at` cannot be
  altered to dodge the dedupe without breaking the signature.
- The master tracks the highest `seq` seen per node; anything `<=` is ignored.

## 7. Key compromise

- **A node's signing key leaks** → the attacker can forge that *one* node's
  alerts (inject or, combined with a hub, mislead). Contained to one node;
  revoked by removing its pubkey from the master registry (§03). It cannot
  decrypt others' alerts.
- **The master's private key leaks** → confidentiality of all alerts is lost.
  The key never leaves the master (the hardened collector), mode-0600,
  root-owned; this is the single most sensitive secret and is treated as such.
- **The hub is fully compromised** → see §4–5: read-blind, forge-blind,
  suppression detectable. This is the whole point of the design.

## 8. Fail-closed posture

- Master with no private key configured → mesh source refuses to start (don't
  silently fall back to trusting plaintext).
- A blob that fails verify → dropped and counted, never shown as a real alert.
- Hub unreachable → the master shows its local feed and marks the mesh portion
  stale (visible degradation, not a silent empty panel).

## 9. Viewing the aggregate (view-password)

The mesh view is the same GUI, served by the **master** and reached via SSH
local-forward (`04-connectivity-and-deployment.md §6`) — never the hub, so the
hub stays blind. Two layers gate *who sees the consolidated feed*:

- **Access** — the master is loopback-bound; reaching it at all requires an SSH
  session to polaris (key-based, the existing admin path).
- **View-password** — a session password (`GUI_VIEW_PASSWORD`, root-owned env on
  the master) gates the aggregate in the browser. The consolidated security feed
  is more sensitive than any single node's, so viewing is gated in addition to
  access. Constant-time compare, fail-closed (no password configured on the
  master → the view refuses, doesn't open up). Start as one shared password
  (mirrors the sketch in `docs/llm-brief-sanitized.md`); per-user identity is a
  later upgrade behind the same gate.

This is a *read* gate on already-decrypted data on the trusted node — it does not
replace the crypto (§2), which is what keeps the hub from ever seeing plaintext.

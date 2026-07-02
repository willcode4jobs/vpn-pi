# Opening the gate from the app — options + plan

> **DECIDED + BUILT: Option C.** The app's "Open gate" button now calls a loopback/
> operator-only `POST /api/gate/open` on the node that holds the admin key — it mints the
> canary locally and forwards it to the gate node. One click, key never in the browser.
> **Setup steps are at the bottom** ([Setup — Option C](#setup--option-c-built)). The
> options analysis below is kept for the record.

---

## Quick start — run it (3 steps)

The system is three processes: vega runs **llama-gate** (the model) + **islandd** (the gate
node); builder runs **islandd as the admin app** (loopback). The gate-view proxy runs only on
builder — **vega needs no redeploy** for this; the `/api/gate` additions are harmless there.

**1 — On vega: confirm services + grab two values.** `ssh` in, then:
```bash
systemctl is-active llama-gate islandd          # both must print: active
sudo cat /var/lib/islandd/identity/x25519.pub   # → ISLAND_GATE_TARGET_X25519
sudo cat /var/lib/islandd/admin.token           # → ISLAND_GATE_TARGET_TOKEN
sudo grep ADMIN_PUBKEY /etc/islandd/islandd.env  # MUST equal builder's ~/island-admin/ed25519.pub
```
If `ISLAND_ADMIN_PUBKEY` is blank/different, vega rejects the canary with 403 — set it to
builder's admin signer pub and `sudo systemctl restart islandd`. (Services not `active`?
That's the model/daemon deploy — see `RUNBOOK-deploy-gate-model.md`.)

**2 — On builder: run the admin app** (keep this terminal open; paste vega's two values):
```bash
export ISLAND_ADMIN_KEY_DIR=~/island-admin
export ISLAND_GATE_TARGET=http://10.42.0.2:8787
export ISLAND_GATE_TARGET_X25519='<vega x25519.pub>'
export ISLAND_GATE_TARGET_TOKEN='<vega admin.token>'
export ISLAND_GATE_TARGET_LABEL=vega
cd /Users/billyr/Desktop/projects/initfolder/vpn-pi/island
bun run src/main.ts --host 127.0.0.1      # use ~/.bun/bin/bun if bun isn't on PATH
```
On startup it prints **builder's own admin token** (also in `~/.islandd/admin.token`) — needed next.

**3 — In the browser:** open **http://127.0.0.1:8787/admin** → click the top-bar lock →
paste **builder's** admin token (from step 2, *not* vega's). On the **Internet access** card:
- The chip reads **"Island · vega"** / **"Internet · vega"** — it's vega's real gate, not this laptop's.
- **Open gate** mints on builder → forwards to vega → Llama approves → chip flips, log shows vega's entries.
- **Close** forwards to vega. Vega down → **"Gate node · vega unreachable"** (never a false "Island").

**Two tokens, don't mix them up:**

| Token | Where it goes | Unlocks |
|---|---|---|
| **builder's** admin token | the browser lock at `/admin` | builder's admin UI (gate log, close) |
| **vega's** admin token | `ISLAND_GATE_TARGET_TOKEN` env | the proxy's internal calls to vega |

The **Open** button is operator-gated and you're on loopback, so it works with no token; the
**log/close** panels go through `requireAdmin`, so the browser needs builder's token to fill them.

---

The gate works end-to-end via the `islandd canary` CLI. This doc covers making the
**app's "Open gate"** actually open egress in production (it used to error *"Needs the
admin app in production"*) — the one hard constraint, the options, and what we built.

---

## The one hard constraint (why the button doesn't "just work")

Opening the gate requires **minting a canary**: signing the request with the admin
**Ed25519 private key** and sealing it to vega's X25519 key. Whoever holds that private key
can authorize internet egress. **So it must never live in a browser** — not in JS, not in
localStorage, not uploaded to a page. A browser is shared, cached, and XSS-reachable; a
leaked admin key = anyone can open the island. Every option below is a way to keep the
mint *off* the browser while still driving it from the UI.

## Current state (what exists)

| Piece | State |
|---|---|
| `POST /admin/canary` (verify sealed blob → LLM → open) | ✅ works in prod — takes a `{blob}` |
| `POST /admin/canary/mint` (what the UI button calls) | ❌ **mock-only** — 404 in prod (can't mint without the key) |
| `POST /admin/gate/close` (the UI close button) | ✅ works — no key needed |
| `islandd canary` CLI (mints on a trusted machine) | ✅ works — this is today's "admin app" |
| Home/Gate **state + log** display | ✅ live for every user |

So the *receiving* side (`/admin/canary`) already works. The gap is purely **where the
mint happens.**

---

## Options

### A. Paste a pre-minted blob into the admin UI  ✅ recommended (ship now)

Mint on the CLI, paste the result into the app.

- Admin runs `islandd canary --text "GREEN18 open the internet"` **without `--send`** → it
  prints the sealed blob.
- Admin pastes that blob into a **textarea** in the admin Gate card → the UI POSTs
  `{blob}` to the existing `/admin/canary`.
- **Frontend-only change.** No backend work, no key in the browser, works from any admin
  browser on the mesh.
- Tradeoff: two steps (CLI mint → paste), not one click. Fine for an occasional,
  deliberate action like opening egress.

### B. Admin key in the browser  ❌ rejected

Load the private key in the page and mint with `libsodium-wrappers` in JS.
- **Rejected** — this is exactly the thing the constraint forbids. One XSS, shared laptop,
  or cached key and the gate is compromised. Don't.

### C. The admin's own islandd as the "admin app"  ⭐ best one-click UX (later)

Run islandd on the **admin's trusted machine** (builder) with the admin keypair available,
and add an **operator-only, loopback** endpoint that mints locally and forwards to vega.

- New route `POST /api/gate/open` (operator-gated: loopback / op-token only): loads the
  admin identity from a configured dir, `makeCanary(text, vegaX25519)`, POSTs the blob to
  vega's `/admin/canary`, returns the result.
- The admin app's **Open button calls this local endpoint** → genuine one click; the key
  never leaves builder, never touches a browser, never crosses the mesh.
- Tradeoff: the admin key sits in a dir readable by the admin's *own* islandd (acceptable —
  it's the admin's trusted box, same trust as the CLI). Must be **operator-only + loopback**
  so a mesh peer can't trigger a mint.

### D. Standalone mini admin GUI  (overkill)

A dedicated desktop tool that holds the key and has a button. Most work for no gain over C
(which reuses islandd). Skip unless there's a reason.

---

## Recommendation

1. **Now: Option A (paste-blob).** Frontend-only, secure, shippable today. Turns the dead
   "Prompt for Llama" field into a working "paste canary → open" flow.
2. **Later (optional): Option C.** If you want true one-click from the admin's app, add the
   loopback mint endpoint. Keep A as the fallback for any other admin/browser.

Both keep the private key on a trusted machine — the security model is unchanged; only the
*UX of submitting* the canary changes.

---

## Implementation sketch

### A — paste-blob (frontend only)

In `web/index.html`, the admin Gate card:
- Replace the prompt→mint flow with a **textarea** ("Paste a canary minted with
  `islandd canary`") + an **Open** button that does `api("/admin/canary", {json:{blob}})`.
- Keep the mock prompt→mint path **only when `--mock`** (where `/admin/canary/mint` exists),
  so the laptop demo still one-clicks; prod uses the paste field.
- Show the returned `opened` / `reason` and refresh the gate state/log (already wired).

No backend change — `/admin/canary` already verifies + opens.

### C — admin-app mint endpoint (frontend + backend)

- **Config:** `ISLAND_ADMIN_KEY_DIR` (the admin keypair) + `ISLAND_GATE_TARGET`
  (vega's URL) + vega's admin token — set **only** on the admin's machine.
- **Backend:** `POST /api/gate/open` — `requireOperator` (loopback/op-token), load admin
  identity, `makeCanary(keyword, text, vegaX25519)`, POST to `${target}/admin/canary` with
  the admin token, return `{opened, reason, gate}`. Reuses `core/canary.ts` + `core/identity.ts`.
- **Frontend:** the Open button calls `/api/gate/open` when this instance is configured as
  an admin app; otherwise show the paste field (A).
- **Security:** operator-only + loopback bind; the key is never read by any mesh-facing
  path; document that this endpoint is admin-machine-only.

---

## Decisions to lock before building

1. **Option A now, or jump to C?** (A = today, frontend-only; C = one-click, more code.)
2. **Canonical canary text** = "GREEN18 open the internet" (explicit — the model denies the
   ambiguous bare "open the gate"). Bake this into the UI's default + the CLI examples.
3. For C: confirm the **admin machine** (builder) and where its key dir lives, and that the
   endpoint stays **loopback/operator-only**.

---

## Setup — Option C (built)

What got built:
- `POST /api/gate/open` (operator-only) in `src/main.ts` — mints the canary locally and
  forwards the sealed blob to the gate node's `/admin/canary`. Returns 404 on a node that
  doesn't hold the admin key.
- The admin UI Gate card's **Open** button calls it (optional "Reason" field; defaults to
  "open the internet" — explicit so the LLM approves it). `web/index.html`.
- Config via env (`islandd.env.example`): `ISLAND_ADMIN_KEY_DIR`, `ISLAND_GATE_TARGET`,
  `ISLAND_GATE_TARGET_X25519`, `ISLAND_GATE_TARGET_TOKEN`, `ISLAND_GATE_TARGET_LABEL`.

### Gate-view proxy — status/log/close reflect the **target** (the disconnect, fixed)

The open button minting into vega while the status chip, log, and Close all read this
laptop's *own* (empty) gate was the design disconnect. Now, **when this node is an admin app
(`ISLAND_GATE_TARGET` is set), the gate read/control surface proxies to the target**, so the
app is a real remote console for vega rather than a button that mints into the void:

- `GET /api/gate` (top-bar chip + Home hero) → fetches the target's `/api/gate`. Adds
  `target`, `target_label`, and `reachable` to the JSON (additive; gate node itself is
  unchanged). If the target doesn't answer, it reports **island + `reachable:false`** —
  fail-safe, never a false "open".
- `GET /admin/gate/log` → fetches the target's log (with the target admin token). The
  laptop has no local log; you read vega's real audit trail.
- `POST /admin/gate/close` → forwards the close to the target (closing the laptop's local
  gate would do nothing).
- The UI labels the gate **"· vega"** (the target host, or `ISLAND_GATE_TARGET_LABEL`) on
  the chip, the Home eyebrow, and the admin card heading — so it's always clear *which*
  node's gate you're looking at. An unreachable target shows "Gate node · vega unreachable".

On the **gate node itself** (vega: no `ISLAND_ADMIN_KEY_DIR`/target) all of these return
the local gate exactly as before — the proxy only engages on the admin app. The crypto
authority model is unchanged: vega still verifies seal + signature + keyword + nonce and
runs the LLM; we only changed *where the app reads gate state from*.

Run the **admin app** on the operator's trusted machine (builder), bound to **loopback** so
operator auth is automatic and nothing is exposed on the mesh:

```bash
export ISLAND_ADMIN_KEY_DIR=~/island-admin
export ISLAND_GATE_TARGET=http://10.42.0.2:8787
export ISLAND_GATE_TARGET_X25519='<vega x25519 — sudo cat /var/lib/islandd/identity/x25519.pub on vega>'
export ISLAND_GATE_TARGET_TOKEN='<vega admin token — sudo cat /var/lib/islandd/admin.token on vega>'
cd /Users/billyr/Desktop/projects/initfolder/vpn-pi/island
bun run typecheck && bun test
bun run src/main.ts --host 127.0.0.1
```

Then open `http://127.0.0.1:8787/admin` → **Internet access** card → **Open gate**. It mints
the canary on builder, forwards to vega, vega verifies + Llama approves → gate opens. The
state/log update in place; **Close** works as before.

Notes:
- Loopback bind = `requireOperator` passes without a token (you're local); the admin key
  stays on builder and the open route is never reachable from the mesh.
- A node **without** `ISLAND_ADMIN_KEY_DIR` returns 404 from `/api/gate/open`, and its UI
  shows "this node can't open the gate — use the admin app." Exactly one machine mints.
- If `bun run src/main.ts` errors on the admin key, check `ISLAND_ADMIN_KEY_DIR` points at
  the `islandd keygen` dir (with `ed25519.key`/`x25519.key`).

## Notes

- The crypto/authority model does **not** change in any option — vega still verifies seal +
  admin signature + keyword + nonce and runs the LLM. We're only moving *where the canary is
  submitted from*, never weakening the gate.
- Whatever we build, the gate **state + log** in the app already reflect reality, and the
  **close** button already works — so users always *see* the gate correctly; this is purely
  about the *open* trigger.

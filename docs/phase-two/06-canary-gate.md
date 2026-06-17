# 06 — The canary gate (LLM-mediated internet access)

## Goal

The island is sealed by default. To get internet access, the admin issues a
**canary** — a natural-language prompt whose first token is a reserved keyword —
which a **local LLM (Llama)** interprets, and which (if approved) opens vega's
egress for a bounded time. The canary must be **signed and sealed** so that
*typing the keyword is not enough*: only the admin's verified key can move the gate.

## Why an LLM is in the loop

Two reasons, both intentional:
1. **Natural-language policy.** "canary open egress for 30 min, web only" is parsed
   into a structured action by Llama, rather than the admin hand-crafting flags.
2. **A refusal layer.** The model can decline requests that violate a stored policy
   ("canary open everything forever") — a soft guardrail *in addition to* the hard
   crypto check, never instead of it.

The crypto is what makes it safe; the LLM is what makes it usable. If the model is
down, the gate simply stays closed (fail-safe = island mode).

## Flow

```
 admin app (any node)                     vega (gate node)
 ────────────────────                     ────────────────
 1. compose: "<canary> open egress 30m"
 2. canary = {
      action_text, issued, nonce, ttl_s
    } sign(admin.ed25519)
    then seal → vega.x25519               
        │  POST /admin/canary  (over wg0)
        └──────────────────────────────►  3. open seal, verify admin signature
                                              & that signer ∈ admins
                                           4. check keyword present, nonce fresh,
                                              not expired                (HARD checks)
                                           5. hand action_text to local Llama
                                              → {decision: open|deny, scope, ttl}
                                           6. if open: island-gate helper flips
                                              nftables egress on; arm reclose timer
                                           7. append to gate.log; broadcast new
                                              gate state to the mesh
 8. every node's Home now shows "internet access" until reclose → back to "island"
```

## The "signed and sealed" requirement (newContextFile line 18)

The canary reuses `core/envelope` exactly like a friend message:

- **Sign** (Ed25519, admin key): proves *who* issued it; replaces "anyone who knows
  the word." The keyword itself is **not** a secret — the signature is the secret.
- **Seal** (X25519, to vega): only vega can read the canary; an on-path observer
  can't learn the gate is being opened or replay the request elsewhere.
- **nonce + ttl**: single-use and short-lived, so a captured canary can't reopen
  the gate later.

## Egress toggle (least privilege)

- Default and post-reclose state: **island** (forward drop, no MASQUERADE).
- Open state is **always time-boxed** (`ttl` from the LLM decision, hard-capped).
  There is no "open indefinitely" path.
- Only vega has an uplink, so only vega has a gate. The web process never edits
  nftables — it calls the narrow `island-gate` helper (see [03](03-architecture.md)),
  which can flip *only* the egress ruleset.

## Open design points (see [08](08-open-questions.md))

- **Which node runs Llama?** sirius (x86, capable) is the lead candidate; vega
  (the gate) running it co-located is simpler but loads the edge node. If the LLM
  host ≠ vega, step 5 is itself a sealed mesh round-trip.
- **Keyword value & whether it's configurable.** It's not a secret, but it should
  be distinctive to avoid accidental triggers.
- **Policy prompt for Llama** — the system prompt that defines what it will/won't
  approve. Needs your input on the allow/deny rules.

# 04 — Friending protocol

Friending replaces the Phase One static wg0-IP allowlist. It is the **only** way a
node gains write/message permission to another node. The security property that
must hold: **no friendship can exist without a token issued by one side and
accepted by the other** — and therefore the admin can *delete* a friendship but
can *never forge* one (admin holds neither party's private key).

## Identities

Each node has one long-lived identity, generated **by William on the host** (the
daemon only loads it):

- **Ed25519** signing keypair → authenticity ("this really came from sirius").
- **X25519** box keypair → confidentiality (`crypto_box_seal` to a node's pubkey).

A node's **identity = its two public keys** (plus a human label and its wg0 addr,
which are documentation/routing only, never the root of trust).

## The handshake (token give → accept)

```
  Alice (gives)                                   Bob (accepts)
  ─────────────                                   ─────────────
  1. mk FRIEND_TOKEN {                            
       from: Alice.pubkeys,
       label, wg0,
       nonce, issued, expires
     }  sign(Alice.ed25519)                       
              │   token handed over out-of-band
              │   (paste / QR / one-shot mesh msg)
              └───────────────────────────────►   2. verify Alice's signature,
                                                      check not-expired, nonce unseen
                                                   3. record Alice as FRIEND
                                                   4. mk ACCEPT {
                                                         from: Bob.pubkeys, label, wg0,
                                                         ref: token.nonce
                                                      } sign(Bob.ed25519)
              ◄───────────────────────────────┐      seal → Alice.x25519
  5. open+verify ACCEPT, record Bob as FRIEND │
  ─────────────────────────────────────────────
  RESULT: mutual. Both now hold the other's verified pubkeys
          → both may message and write files to the other.
```

Key points:
- **One token, one accept, mutual result.** The token authorizes Alice→Bob trust;
  the accept authorizes Bob→Alice trust. Accepting completes both directions, which
  is exactly "after this both can write files to the other node."
- **Tokens are single-use and expiring** (nonce + `expires`). A captured token
  can't be replayed after acceptance or after expiry.
- **The accept is sealed** to Alice so an eavesdropper on the path can't harvest
  Bob's acceptance or learn the graph.
- **No token = no permission.** A node with no accepted friendship can do nothing
  to a peer but be ignored. There is no implicit/whole-subnet trust anymore.

## State machine (per peer, on each node)

```
   (none) ──issue token──► OFFERED ──(peer accepts, we verify accept)──► FRIENDS
   (none) ──recv token──►  PENDING ──(we accept)───────────────────────► FRIENDS
   FRIENDS ──admin delete / we revoke──► (none)        # revoke is local + one-sided
```

- **PENDING** = an active **friend request** shown on Home (newContextFile line 11).
- **Revocation** is one-sided and immediate: deleting a friend removes their write
  permission on *this* node right away. We *notify* the ex-friend (best effort) so
  their side can drop the stale entry, but security doesn't depend on them acting.

## What admin can and cannot do (security boundary)

| Action | Allowed? | Why |
|---|---|---|
| List friendships / pending requests | ✅ | Read-only visibility |
| **Delete** a friendship | ✅ | Revocation needs no counterparty key |
| **Force/create** a friendship | ❌ **never** | Would require forging a signed token + accept; admin has neither private key. Enforced by *not having an API for it*, not by a policy flag. |

This is the crux of newContextFile line 15 ("admin can delete… but cannot force").
The inability to forge is **structural**: friendship records are only created by
verifying signatures the admin can't produce.

## Reuse

`core/envelope` is the Phase One sign-then-seal model verbatim (see
`gui-and-app/backend/app/ids_crypto.py` for the reference implementation and its
canonicalisation rules — sorted-key, no-whitespace JSON, no floats — which the
TypeScript port must reproduce byte-for-byte so signatures verify across languages
during migration).

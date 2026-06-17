// The envelope — sign-then-seal / open-then-verify.
//
// This is the trust primitive the whole island reuses: friend tokens, messages,
// files, and the canary command all travel as sealed+signed envelopes. Ported
// verbatim (algorithm + wire format) from Phase One's gui-and-app/backend/app/
// ids_crypto.py so the bytes interoperate during migration.
//
// Two guarantees, in order:
//   1. SIGN  the canonical payload with the sender's Ed25519 key  -> authenticity.
//   2. SEAL  (payload + signature) to the recipient's X25519 key   -> confidentiality
//            (libsodium crypto_box_seal — an anonymous sealed box).
//
// Sign-THEN-seal means the signature lives INSIDE the sealed box: an in-path
// observer (or a node merely buffering the blob) sees only ciphertext, never the
// payload nor an attributable signature. Fail-closed: any decrypt/parse/trust/
// signature problem is a rejection, never a pass-through.

import { canonicalBytes, type Json } from "./canonical.ts";
import { getSodium } from "./sodium.ts";

export class VerificationError extends Error {}

// Resolve a sender identity (the payload's "node") to its trusted Ed25519 public
// key, or null if unknown. Injected so this module has no dependency on the
// friend store — and so tests can pass a closure.
export type VerifyKeyFor = (node: string) => Uint8Array | null;

/**
 * Sender side: sign `payload`, then seal (payload + signature) to `recipientPublicKey`.
 * Returns the opaque ciphertext. `signSecretKey` is the 64-byte Ed25519 secret key.
 */
export async function sealSign(
  payload: { [key: string]: Json },
  signSecretKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const s = await getSodium();
  const signature = s.crypto_sign_detached(canonicalBytes(payload), signSecretKey);
  const inner = canonicalBytes({
    payload,
    sig: s.to_base64(signature, s.base64_variants.ORIGINAL),
  });
  return s.crypto_box_seal(inner, recipientPublicKey);
}

/**
 * Recipient side: open the sealed box, then verify the inner signature against the
 * trusted key for the payload's `node`. Returns the trusted payload or throws
 * VerificationError.
 */
export async function openVerify(
  blob: Uint8Array,
  recipientPublicKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
  verifyKeyFor: VerifyKeyFor,
): Promise<{ [key: string]: Json }> {
  const s = await getSodium();

  let innerBytes: Uint8Array;
  try {
    innerBytes = s.crypto_box_seal_open(blob, recipientPublicKey, recipientPrivateKey);
  } catch {
    throw new VerificationError("cannot decrypt blob");
  }

  let payload: { [key: string]: Json };
  let signature: Uint8Array;
  let node: string;
  try {
    const obj = JSON.parse(new TextDecoder().decode(innerBytes));
    payload = obj.payload;
    signature = s.from_base64(obj.sig, s.base64_variants.ORIGINAL);
    node = payload.node as string;
    if (typeof node !== "string") throw new Error("missing node");
  } catch {
    throw new VerificationError("malformed sealed contents");
  }

  const verifyKey = verifyKeyFor(node);
  if (verifyKey === null) {
    throw new VerificationError(`unknown node, not trusted: ${node}`);
  }

  if (!s.crypto_sign_verify_detached(signature, canonicalBytes(payload), verifyKey)) {
    throw new VerificationError(`bad signature for node ${node}`);
  }

  return payload;
}

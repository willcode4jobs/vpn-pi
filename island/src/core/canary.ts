// The canary — the only thing that can open the island's internet gate.
//
// A canary is an envelope (core/envelope.ts): signed by an ADMIN key and sealed to
// vega's X25519 key. Typing the keyword is not enough — the *signature* is the
// secret. vega applies four HARD checks before the LLM is even consulted; the LLM is
// a subordinate refusal layer, never the authority (see core/gate.ts):
//
//   1. the seal opens (only vega can)            — confidentiality + addressed to us
//   2. the signature verifies against an ADMIN    — authenticity (admin allowlist)
//   3. the keyword (GREEN18) is the first token   — intent
//   4. the nonce is unseen + the canary is fresh  — anti-replay (nonce in core/gate.ts)
//
// Fail-closed: anything wrong throws, the gate stays island.

import { toB64, fromB64 } from "./codec.ts";
import { openVerify, sealSign, type VerifyKeyFor } from "./envelope.ts";
import type { Identity } from "./identity.ts";
import { getSodium } from "./sodium.ts";

export class CanaryError extends Error {}

/** A verified canary (the trusted payload). */
export interface Canary {
  admin: string; // admin Ed25519 public (base64) — the verified signer
  keyword: string;
  text: string; // the natural-language request handed to the LLM
  nonce: string; // single-use
  issued: string; // ISO 8601
}

/**
 * Admin side: build a canary — sign with the admin key, seal to vega's X25519.
 * Returns base64 for the admin app to POST to /admin/canary.
 */
export async function makeCanary(
  admin: Identity,
  keyword: string,
  text: string,
  vegaX25519: string,
  now: Date = new Date(),
): Promise<string> {
  const s = await getSodium();
  const payload = {
    node: await toB64(admin.ed25519.publicKey), // envelope verifies against payload.node
    keyword,
    text,
    nonce: await toB64(s.randombytes_buf(16)),
    issued: now.toISOString(),
  };
  const blob = await sealSign(payload, admin.ed25519.secretKey, await fromB64(vegaX25519));
  return toB64(blob);
}

/**
 * vega side: open + verify a canary. `adminVerify` resolves only ALLOWLISTED admin
 * keys (a non-admin signer -> VerificationError). Then checks keyword + freshness.
 * Replay (nonce) is enforced by the Gate, which consumes the returned nonce.
 */
export async function verifyCanary(
  vega: Identity,
  blobB64: string,
  adminVerify: VerifyKeyFor,
  keyword: string,
  freshnessSeconds: number,
  now: Date = new Date(),
): Promise<Canary> {
  // throws VerificationError if the seal won't open or the signer isn't an admin
  const payload = await openVerify(
    await fromB64(blobB64),
    vega.x25519.publicKey,
    vega.x25519.privateKey,
    adminVerify,
  );

  const text = String(payload.text ?? "");
  const kw = String(payload.keyword ?? "");
  const firstToken = text.trim().split(/\s+/)[0] ?? "";
  if (kw !== keyword || firstToken !== keyword) {
    throw new CanaryError("canary keyword missing or not the first token");
  }

  const issuedMs = Date.parse(String(payload.issued));
  if (!Number.isFinite(issuedMs)) throw new CanaryError("canary has no valid issued time");
  const ageMs = now.getTime() - issuedMs;
  if (Math.abs(ageMs) > freshnessSeconds * 1000) {
    throw new CanaryError("canary is stale or future-dated");
  }

  return {
    admin: String(payload.node),
    keyword: kw,
    text,
    nonce: String(payload.nonce),
    issued: String(payload.issued),
  };
}

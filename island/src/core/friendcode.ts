// Compact friend codes — one clean string instead of the raw-JSON invite.
//
//   invite:  island-invite1<base64url(packed token)>     (≈240 chars, was ~540 JSON)
//   reply:   island-reply1<accept blob>
//
// The pack reconstructs the EXACT FriendToken object, so the existing signature (over
// canonical JSON, see core/friends.ts) still verifies — this is a transport encoding,
// not a new crypto format. Short registry codes (a fingerprint of the key) come in a
// later sub-phase; see docs/phase-two/FRIEND-CODES.md.

import type { FriendToken } from "./friends.ts";
import { getSodium } from "./sodium.ts";

const INVITE_PREFIX = "island-invite1";
const REPLY_PREFIX = "island-reply1";
const VERSION = 1;

// Packed layout: ver(1) ed25519(32) x25519(32) nonce(16) issued(8) expires(8) sig(64)
//                labelLen(1) label(N) wg0Len(1) wg0(M)
export async function encodeInvite(t: FriendToken): Promise<string> {
  const s = await getSodium();
  const std = s.base64_variants.ORIGINAL;
  const ed = s.from_base64(t.from.ed25519, std);
  const x = s.from_base64(t.from.x25519, std);
  const nonce = s.from_base64(t.nonce, std);
  const sig = s.from_base64(t.sig, std);
  const label = new TextEncoder().encode(t.from.label);
  const wg0 = new TextEncoder().encode(t.from.wg0);
  if (label.length > 255 || wg0.length > 255) throw new Error("label/wg0 too long for an invite");

  const buf = new Uint8Array(1 + 32 + 32 + 16 + 8 + 8 + 64 + 1 + label.length + 1 + wg0.length);
  const dv = new DataView(buf.buffer);
  let o = 0;
  buf[o++] = VERSION;
  buf.set(ed, o); o += 32;
  buf.set(x, o); o += 32;
  buf.set(nonce, o); o += 16;
  dv.setBigUint64(o, BigInt(Date.parse(t.issued)), false); o += 8;
  dv.setBigUint64(o, BigInt(Date.parse(t.expires)), false); o += 8;
  buf.set(sig, o); o += 64;
  buf[o++] = label.length; buf.set(label, o); o += label.length;
  buf[o++] = wg0.length; buf.set(wg0, o);

  return INVITE_PREFIX + s.to_base64(buf, s.base64_variants.URLSAFE_NO_PADDING);
}

export async function decodeInvite(code: string): Promise<FriendToken> {
  const s = await getSodium();
  if (!code.startsWith(INVITE_PREFIX)) throw new Error("not an island invite code");
  const buf = s.from_base64(code.slice(INVITE_PREFIX.length).trim(), s.base64_variants.URLSAFE_NO_PADDING);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const std = s.base64_variants.ORIGINAL;

  let o = 0;
  if (buf[o++] !== VERSION) throw new Error("unsupported invite version");
  const ed = buf.subarray(o, (o += 32));
  const x = buf.subarray(o, (o += 32));
  const nonce = buf.subarray(o, (o += 16));
  const issued = Number(dv.getBigUint64(o, false)); o += 8;
  const expires = Number(dv.getBigUint64(o, false)); o += 8;
  const sig = buf.subarray(o, (o += 64));
  const labelLen = buf[o++]!;
  const label = new TextDecoder().decode(buf.subarray(o, (o += labelLen)));
  const wg0Len = buf[o++]!;
  const wg0 = new TextDecoder().decode(buf.subarray(o, (o += wg0Len)));

  return {
    v: 1,
    from: { ed25519: s.to_base64(ed, std), x25519: s.to_base64(x, std), label, wg0 },
    nonce: s.to_base64(nonce, std),
    issued: new Date(issued).toISOString(),
    expires: new Date(expires).toISOString(),
    sig: s.to_base64(sig, std),
  };
}

// --- short friend code: a verifiable fingerprint of the identity key ---
//
// `ISL-XXXXX-XXXXX` = Crockford base32 of the first 50 bits of BLAKE2b(ed25519). It's
// a stable, shareable handle for an identity, and it COMMITS to the key — so when a
// directory (the polaris registry, I-3) resolves a code, the recipient re-derives the
// fingerprint and checks it matches, and the directory can't substitute a key. Until
// then it's a human-comparable identity check (like a Signal safety number).

// Crockford base32 alphabet (no I/L/O/U — unambiguous for humans).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function fingerprint(ed25519B64: string): Promise<string> {
  const s = await getSodium();
  const hash = s.crypto_generichash(32, s.from_base64(ed25519B64, s.base64_variants.ORIGINAL));
  // first 56 bits → drop low 6 → 50 bits → ten 5-bit symbols
  let acc = 0n;
  for (let i = 0; i < 7; i++) acc = (acc << 8n) | BigInt(hash[i]!);
  acc >>= 6n;
  let out = "";
  for (let i = 9; i >= 0; i--) out += ALPHABET[Number((acc >> BigInt(i * 5)) & 31n)];
  return `ISL-${out.slice(0, 5)}-${out.slice(5)}`;
}

/** True if `code` is the fingerprint of `ed25519B64` (case-insensitive). */
export async function codeMatches(ed25519B64: string, code: string): Promise<boolean> {
  return (await fingerprint(ed25519B64)) === code.trim().toUpperCase();
}

// The accept is already a compact sealed base64 blob — just label it.
export function encodeReply(acceptBlob: string): string {
  return REPLY_PREFIX + acceptBlob;
}

export function decodeReply(code: string): string {
  if (!code.startsWith(REPLY_PREFIX)) throw new Error("not an island reply code");
  return code.slice(REPLY_PREFIX.length).trim();
}

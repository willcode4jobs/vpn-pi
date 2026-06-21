// Friending — the island's only authorization primitive.
//
// A friendship can ONLY come into being through a verified token + accept exchange.
// There is deliberately no method to add a friend directly, so an admin (or anyone)
// can DELETE a friendship but can never FORGE one — they'd need a counterparty's
// Ed25519 key, which they don't have. See docs/phase-two/04-friending-protocol.md.
//
// Handshake (giver = Alice, receiver = Bob):
//   1. Alice issueToken()      -> a signed, expiring, single-use FriendToken, handed
//                                  to Bob out-of-band (paste/QR). Recorded as OFFERED.
//   2. Bob   receive(token)    -> verify sig + freshness; recorded as PENDING (a
//                                  friend request shown on Home).
//   3. Bob   accept(alice)     -> Bob records Alice as FRIEND and returns an ACCEPT
//                                  blob (signed by Bob, SEALED to Alice).
//   4. Alice confirm(blob)     -> opens+verifies the accept; records Bob as FRIEND.
// Result: mutual. Both hold the other's verified public keys.
//
// Trust model: the token is handed to a specific person out-of-band; whoever returns
// a valid accept referencing its single-use nonce IS that person. The public keys in
// the accept become their identity (TOFU bound to the out-of-band handoff).

import { canonicalBytes, type Json } from "./canonical.ts";
import { fromB64, toB64 } from "./codec.ts";
import type { Identity } from "./identity.ts";
import { getSodium } from "./sodium.ts";

export class FriendError extends Error {}

/** A peer's public identity. The keys are the root of trust; label/wg0 are notes. */
export interface PeerPub {
  ed25519: string; // base64 — verify this peer's signatures
  x25519: string; // base64 — seal messages/files to this peer
  label: string; // human note only
  wg0: string; // wg0 address — routing/note only
}

export interface FriendToken {
  v: 1;
  from: PeerPub;
  nonce: string; // single-use
  issued: string; // ISO 8601
  expires: string; // ISO 8601
  sig: string; // base64 Ed25519 over the token without `sig`
}

export interface FriendAccept {
  v: 1;
  from: PeerPub;
  ref: string; // the token nonce being accepted
  issued: string; // ISO 8601
  sig: string; // base64 Ed25519 over the accept without `sig`
}

export type FriendState = "offered" | "pending" | "friends";

export interface FriendRecord {
  peer: PeerPub;
  state: FriendState;
  nonce: string; // ties an offer to its accept
  since: string; // ISO 8601
}

// ---- canonical signable views (drop the `sig` field) -----------------------

function peerPubJson(p: PeerPub): { [k: string]: Json } {
  return { ed25519: p.ed25519, x25519: p.x25519, label: p.label, wg0: p.wg0 };
}

function tokenSignable(t: Omit<FriendToken, "sig">): { [k: string]: Json } {
  return { v: t.v, from: peerPubJson(t.from), nonce: t.nonce, issued: t.issued, expires: t.expires };
}

function acceptSignable(a: Omit<FriendAccept, "sig">): { [k: string]: Json } {
  return { v: a.v, from: peerPubJson(a.from), ref: a.ref, issued: a.issued };
}

// ---- low-level sign/verify -------------------------------------------------

async function sign(obj: { [k: string]: Json }, secretKey: Uint8Array): Promise<string> {
  const s = await getSodium();
  return toB64(s.crypto_sign_detached(canonicalBytes(obj), secretKey));
}

async function verify(obj: { [k: string]: Json }, sigB64: string, pubB64: string): Promise<boolean> {
  const s = await getSodium();
  return s.crypto_sign_verify_detached(await fromB64(sigB64), canonicalBytes(obj), await fromB64(pubB64));
}

async function newNonce(): Promise<string> {
  const s = await getSodium();
  return toB64(s.randombytes_buf(16));
}

export async function peerPubOf(id: Identity, label: string, wg0: string): Promise<PeerPub> {
  return {
    ed25519: await toB64(id.ed25519.publicKey),
    x25519: await toB64(id.x25519.publicKey),
    label,
    wg0,
  };
}

// ---- token / accept construction + verification ----------------------------

export async function makeToken(
  id: Identity,
  label: string,
  wg0: string,
  ttlSeconds: number,
  now: Date = new Date(),
): Promise<FriendToken> {
  const body = {
    v: 1 as const,
    from: await peerPubOf(id, label, wg0),
    nonce: await newNonce(),
    issued: now.toISOString(),
    expires: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  return { ...body, sig: await sign(tokenSignable(body), id.ed25519.secretKey) };
}

export async function verifyToken(t: FriendToken, now: Date = new Date()): Promise<PeerPub> {
  if (t.v !== 1) throw new FriendError("unsupported token version");
  if (!(await verify(tokenSignable(t), t.sig, t.from.ed25519))) {
    throw new FriendError("bad token signature");
  }
  if (Date.parse(t.expires) < now.getTime()) throw new FriendError("token expired");
  return t.from;
}

/** Receiver side: build the ACCEPT, signed by us and sealed to the giver. Returns base64. */
export async function makeAccept(
  id: Identity,
  label: string,
  wg0: string,
  token: FriendToken,
  now: Date = new Date(),
): Promise<string> {
  const s = await getSodium();
  const body = {
    v: 1 as const,
    from: await peerPubOf(id, label, wg0),
    ref: token.nonce,
    issued: now.toISOString(),
  };
  const accept: FriendAccept = { ...body, sig: await sign(acceptSignable(body), id.ed25519.secretKey) };
  const sealed = s.crypto_box_seal(
    new TextEncoder().encode(JSON.stringify(accept)),
    await fromB64(token.from.x25519),
  );
  return toB64(sealed);
}

/** Giver side: open + verify an ACCEPT blob. Throws FriendError on any problem. */
export async function openAccept(id: Identity, blobB64: string): Promise<FriendAccept> {
  const s = await getSodium();
  let inner: Uint8Array;
  try {
    inner = s.crypto_box_seal_open(await fromB64(blobB64), id.x25519.publicKey, id.x25519.privateKey);
  } catch {
    throw new FriendError("cannot open accept (not sealed to us)");
  }
  let accept: FriendAccept;
  try {
    accept = JSON.parse(new TextDecoder().decode(inner));
  } catch {
    throw new FriendError("malformed accept");
  }
  if (accept.v !== 1) throw new FriendError("unsupported accept version");
  if (!(await verify(acceptSignable(accept), accept.sig, accept.from.ed25519))) {
    throw new FriendError("bad accept signature");
  }
  return accept;
}

// ---- the per-node state machine + store ------------------------------------

interface BookData {
  offered: Record<string, FriendToken>; // by nonce
  pending: Record<string, { token: FriendToken; received: string }>; // by giver ed25519
  friends: Record<string, FriendRecord>; // by peer ed25519
  consumed: string[]; // consumed nonces (replay protection, survives restart)
}

export class FriendBook {
  private offered = new Map<string, FriendToken>();
  private pending = new Map<string, { token: FriendToken; received: string }>();
  private friends = new Map<string, FriendRecord>();
  private consumed = new Set<string>();

  constructor(
    private readonly id: Identity,
    private readonly label: string,
    private readonly wg0: string,
  ) {}

  private async selfEd(): Promise<string> {
    return toB64(this.id.ed25519.publicKey);
  }

  /** Giver: mint a token (handed out-of-band) and record it as offered. */
  async issueToken(ttlSeconds: number, now: Date = new Date()): Promise<FriendToken> {
    const token = await makeToken(this.id, this.label, this.wg0, ttlSeconds, now);
    this.offered.set(token.nonce, token);
    return token;
  }

  /** Receiver: verify an incoming token and record it as a pending request. */
  async receive(token: FriendToken, now: Date = new Date()): Promise<PeerPub> {
    const from = await verifyToken(token, now); // throws on bad/expired
    if (this.consumed.has(token.nonce)) throw new FriendError("token already used");
    if (from.ed25519 === (await this.selfEd())) throw new FriendError("cannot friend yourself");
    this.pending.set(from.ed25519, { token, received: now.toISOString() });
    return from;
  }

  /** Receiver: accept a pending request -> friends; returns the accept blob for the giver. */
  async accept(giverEd25519: string, now: Date = new Date()): Promise<string> {
    const p = this.pending.get(giverEd25519);
    if (!p) throw new FriendError("no pending request from that peer");
    const blob = await makeAccept(this.id, this.label, this.wg0, p.token, now);
    this.pending.delete(giverEd25519);
    this.consumed.add(p.token.nonce);
    this.friends.set(giverEd25519, {
      peer: p.token.from,
      state: "friends",
      nonce: p.token.nonce,
      since: now.toISOString(),
    });
    return blob;
  }

  /** Giver: confirm an accept blob -> friends. */
  async confirm(blobB64: string, now: Date = new Date()): Promise<FriendRecord> {
    const accept = await openAccept(this.id, blobB64);
    if (!this.offered.has(accept.ref)) throw new FriendError("accept does not match any open offer");
    if (this.consumed.has(accept.ref)) throw new FriendError("offer already consumed");
    this.offered.delete(accept.ref);
    this.consumed.add(accept.ref);
    const rec: FriendRecord = {
      peer: accept.from,
      state: "friends",
      nonce: accept.ref,
      since: now.toISOString(),
    };
    this.friends.set(accept.from.ed25519, rec);
    return rec;
  }

  /** One-sided, immediate. This is the ONLY way a friendship ends (admin delete uses it). */
  revoke(peerEd25519: string): boolean {
    return this.friends.delete(peerEd25519);
  }

  listFriends(): FriendRecord[] {
    return [...this.friends.values()];
  }
  listPending(): { peer: PeerPub; received: string }[] {
    return [...this.pending.values()].map((p) => ({ peer: p.token.from, received: p.received }));
  }
  listOffered(): FriendToken[] {
    return [...this.offered.values()];
  }
  isFriend(peerEd25519: string): boolean {
    return this.friends.has(peerEd25519);
  }
  friend(peerEd25519: string): FriendRecord | undefined {
    return this.friends.get(peerEd25519);
  }
  /** Resolve a friend by their wg0 address (WireGuard pins each peer's IP to its key). */
  friendByWg0(wg0: string): FriendRecord | undefined {
    for (const r of this.friends.values()) if (r.peer.wg0 === wg0) return r;
    return undefined;
  }

  /**
   * A synchronous verify-key resolver for the envelope layer: returns a friend's raw
   * Ed25519 public key by their id, or null. Only FRIENDS resolve — so opening a
   * message/file from a non-friend fails closed. Decodes upfront so the returned
   * lookup is sync (matches envelope's VerifyKeyFor).
   */
  async verifyKeyResolver(): Promise<(ed25519: string) => Uint8Array | null> {
    const keys = new Map<string, Uint8Array>();
    for (const r of this.friends.values()) keys.set(r.peer.ed25519, await fromB64(r.peer.ed25519));
    return (ed25519) => keys.get(ed25519) ?? null;
  }

  toJSON(): BookData {
    return {
      offered: Object.fromEntries(this.offered),
      pending: Object.fromEntries(this.pending),
      friends: Object.fromEntries(this.friends),
      consumed: [...this.consumed],
    };
  }

  static fromJSON(id: Identity, label: string, wg0: string, data: BookData): FriendBook {
    const book = new FriendBook(id, label, wg0);
    book.offered = new Map(Object.entries(data.offered ?? {}));
    book.pending = new Map(Object.entries(data.pending ?? {}));
    book.friends = new Map(Object.entries(data.friends ?? {}));
    book.consumed = new Set(data.consumed ?? []);
    return book;
  }
}

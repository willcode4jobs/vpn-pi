// Messaging — direct, end-to-end, friend↔friend. No hub, no vega.
//
// A message is just an envelope (core/envelope.ts): signed by the sender, sealed to
// the recipient's X25519 key. The sender delivers the sealed blob straight to the
// recipient node's /api/messages/inbound over wg0. The recipient opens it, verifies
// the signature against its FRIEND keys only (a non-friend fails closed), and appends
// it to an append-only per-peer log. Each side keeps its own log, so a thread is the
// merge of what you sent (out) and received (in).

import { fromB64, toB64 } from "./codec.ts";
import { openVerify, sealSign, VerificationError, type VerifyKeyFor } from "./envelope.ts";
import type { PeerPub } from "./friends.ts";
import type { Identity } from "./identity.ts";

/** The signed payload that crosses the wire (inside the seal). */
export interface Message {
  id?: string; // unique per message (uuid); always set on the wire, used for replay dedup
  from: string; // sender Ed25519 public (base64)
  to: string; // recipient Ed25519 public (base64)
  body: string;
  ts: string; // ISO 8601
}

// Freshness window for guarded inbound messages: a replayed capture whose signed
// `ts` is too old (or from the future) is rejected outright, so the seen-id set
// only ever needs to remember ids inside this horizon.
const MAX_MSG_AGE_MS = 15 * 60 * 1000; // reject blobs older than 15 min
const MAX_MSG_SKEW_MS = 5 * 60 * 1000; // tolerate 5 min of clock skew into the future

/** Replay guard: remembers message ids already ingested. markSeen returns false
 *  on a duplicate. MessageBook implements this (persisted alongside the logs). */
export interface SeenIds {
  markSeen(id: string, tsMs: number): boolean;
}

/** A message as stored in a node's local log. */
export interface StoredMessage extends Message {
  dir: "in" | "out";
}

/** Sender side: seal+sign a message to `recipient`. Returns base64 to POST to them. */
export async function sealMessage(
  self: Identity,
  recipient: PeerPub,
  body: string,
  now: Date = new Date(),
): Promise<string> {
  const payload = {
    typ: "message", // domain separation: openMessage rejects any other envelope kind
    id: crypto.randomUUID(), // the recipient dedups replays on this
    node: await toB64(self.ed25519.publicKey), // envelope verifies against payload.node
    to: recipient.ed25519,
    body,
    ts: now.toISOString(),
  };
  const blob = await sealSign(payload, self.ed25519.secretKey, await fromB64(recipient.x25519));
  return toB64(blob);
}

/** Recipient side: open+verify a message blob. Throws (VerificationError) if the
 *  sender isn't a trusted friend, the seal isn't to us, the signature is bad, the
 *  payload isn't a message addressed to this node, or — when a `seen` replay guard
 *  is supplied (the /api/messages/inbound path) — the signed `ts` is outside the
 *  freshness window or the signed `id` was already ingested (a replayed blob). */
export async function openMessage(
  self: Identity,
  blobB64: string,
  verifyKeyFor: VerifyKeyFor,
  seen?: SeenIds,
): Promise<Message> {
  const payload = await openVerify(
    await fromB64(blobB64),
    self.x25519.publicKey,
    self.x25519.privateKey,
    verifyKeyFor,
  );
  // Domain separation: a friend's OTHER sealed+signed envelopes (handshake blobs,
  // canaries, …) verify too — only payloads stamped as messages may land here.
  if (payload.typ !== "message") {
    throw new VerificationError("not a message envelope");
  }
  // The seal binds our X25519 key; also bind the asserted recipient to OUR Ed25519
  // key so a blob addressed to someone else can't be stored as ours.
  if (payload.to !== (await toB64(self.ed25519.publicKey))) {
    throw new VerificationError("message not addressed to this node");
  }
  if (seen) {
    const tsMs = Date.parse(String(payload.ts));
    const age = Date.now() - tsMs;
    if (Number.isNaN(tsMs) || age > MAX_MSG_AGE_MS || age < -MAX_MSG_SKEW_MS) {
      throw new VerificationError("message timestamp missing or outside freshness window");
    }
    if (typeof payload.id !== "string" || payload.id === "" || !seen.markSeen(payload.id, tsMs)) {
      throw new VerificationError("duplicate or missing message id (replay)");
    }
  }
  return {
    id: typeof payload.id === "string" ? payload.id : undefined,
    from: String(payload.node),
    to: String(payload.to),
    body: String(payload.body),
    ts: String(payload.ts),
  };
}

interface MsgData {
  logs: Record<string, StoredMessage[]>; // by peer ed25519
  seen?: Record<string, number>; // ingested message id -> ts (epoch ms), replay dedup
}

const MAX_PER_PEER = 500; // per-peer log cap: oldest beyond this are dropped
const MAX_SEEN_IDS = 4096; // hard cap on the replay set, over and above ts pruning

/** Per-node append-only message logs, keyed by peer. */
export class MessageBook implements SeenIds {
  private logs = new Map<string, StoredMessage[]>();
  private seen = new Map<string, number>(); // message id -> ts (epoch ms)

  append(peerEd25519: string, m: StoredMessage): void {
    const log = this.logs.get(peerEd25519) ?? [];
    log.push(m);
    if (log.length > MAX_PER_PEER) log.splice(0, log.length - MAX_PER_PEER);
    this.logs.set(peerEd25519, log);
  }

  /** Record an ingested message id; false if already seen (a replay). Bounded:
   *  ids older than the freshness window are pruned (a replay that old is
   *  rejected by the ts check anyway), plus a hard size cap. */
  markSeen(id: string, tsMs: number): boolean {
    if (this.seen.has(id)) return false;
    const cutoff = Date.now() - MAX_MSG_AGE_MS - MAX_MSG_SKEW_MS;
    for (const [old, ts] of this.seen) if (ts < cutoff) this.seen.delete(old);
    while (this.seen.size >= MAX_SEEN_IDS) {
      this.seen.delete(this.seen.keys().next().value!); // oldest-inserted first
    }
    this.seen.set(id, tsMs);
    return true;
  }

  /** The conversation with one peer, oldest-first by timestamp. */
  thread(peerEd25519: string): StoredMessage[] {
    return [...(this.logs.get(peerEd25519) ?? [])].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  peers(): string[] {
    return [...this.logs.keys()];
  }

  toJSON(): MsgData {
    return { logs: Object.fromEntries(this.logs), seen: Object.fromEntries(this.seen) };
  }

  static fromJSON(data: MsgData): MessageBook {
    const book = new MessageBook();
    book.logs = new Map(Object.entries(data.logs ?? {}));
    book.seen = new Map(Object.entries(data.seen ?? {}));
    return book;
  }
}

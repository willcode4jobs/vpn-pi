// Messaging — direct, end-to-end, friend↔friend. No hub, no vega.
//
// A message is just an envelope (core/envelope.ts): signed by the sender, sealed to
// the recipient's X25519 key. The sender delivers the sealed blob straight to the
// recipient node's /api/messages/inbound over wg0. The recipient opens it, verifies
// the signature against its FRIEND keys only (a non-friend fails closed), and appends
// it to an append-only per-peer log. Each side keeps its own log, so a thread is the
// merge of what you sent (out) and received (in).

import { fromB64, toB64 } from "./codec.ts";
import { openVerify, sealSign, type VerifyKeyFor } from "./envelope.ts";
import type { PeerPub } from "./friends.ts";
import type { Identity } from "./identity.ts";

/** The signed payload that crosses the wire (inside the seal). */
export interface Message {
  from: string; // sender Ed25519 public (base64)
  to: string; // recipient Ed25519 public (base64)
  body: string;
  ts: string; // ISO 8601
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
    node: await toB64(self.ed25519.publicKey), // envelope verifies against payload.node
    to: recipient.ed25519,
    body,
    ts: now.toISOString(),
  };
  const blob = await sealSign(payload, self.ed25519.secretKey, await fromB64(recipient.x25519));
  return toB64(blob);
}

/** Recipient side: open+verify a message blob. Throws (VerificationError) if the
 *  sender isn't a trusted friend, the seal isn't to us, or the signature is bad. */
export async function openMessage(
  self: Identity,
  blobB64: string,
  verifyKeyFor: VerifyKeyFor,
): Promise<Message> {
  const payload = await openVerify(
    await fromB64(blobB64),
    self.x25519.publicKey,
    self.x25519.privateKey,
    verifyKeyFor,
  );
  return {
    from: String(payload.node),
    to: String(payload.to),
    body: String(payload.body),
    ts: String(payload.ts),
  };
}

interface MsgData {
  logs: Record<string, StoredMessage[]>; // by peer ed25519
}

/** Per-node append-only message logs, keyed by peer. */
export class MessageBook {
  private logs = new Map<string, StoredMessage[]>();

  append(peerEd25519: string, m: StoredMessage): void {
    const log = this.logs.get(peerEd25519) ?? [];
    log.push(m);
    this.logs.set(peerEd25519, log);
  }

  /** The conversation with one peer, oldest-first by timestamp. */
  thread(peerEd25519: string): StoredMessage[] {
    return [...(this.logs.get(peerEd25519) ?? [])].sort((a, b) => a.ts.localeCompare(b.ts));
  }

  peers(): string[] {
    return [...this.logs.keys()];
  }

  toJSON(): MsgData {
    return { logs: Object.fromEntries(this.logs) };
  }

  static fromJSON(data: MsgData): MessageBook {
    const book = new MessageBook();
    book.logs = new Map(Object.entries(data.logs ?? {}));
    return book;
  }
}

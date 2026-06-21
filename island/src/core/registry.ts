// The friend-code registry — revived polaris's job (control-plane directory only,
// never in the data path). It maps a short `ISL-…` code to a node's identity so you
// can friend by code instead of pasting a long invite.
//
// Two properties keep it honest (see docs/phase-two/FRIEND-CODES.md):
//   - polaris CANNOT MITM: the code is a fingerprint of the key, and resolve()
//     re-derives it and checks the match. A swapped key fails the check.
//   - polaris CANNOT be squatted: announce() carries a SELF-signature, so you can
//     only register your own key's code.

import { Database } from "bun:sqlite";
import { canonicalBytes, type Json } from "./canonical.ts";
import { fromB64, toB64 } from "./codec.ts";
import { fingerprint } from "./friendcode.ts";
import type { Identity } from "./identity.ts";
import { getSodium } from "./sodium.ts";

export class RegistryError extends Error {}

export interface RegistryRecord {
  ed25519: string; // identity — the code is its fingerprint
  x25519: string; // seal messages/files to this peer
  wg0: string; // where to reach them (mesh handshake, I-4)
  label: string;
}

// the exact bytes that get self-signed (canonical sorts the keys)
function signable(r: RegistryRecord): { [k: string]: Json } {
  return { ed25519: r.ed25519, label: r.label, wg0: r.wg0, x25519: r.x25519 };
}

/** Node side: build your own signed record (proves you hold the ed25519 key). */
export async function signRecord(id: Identity, wg0: string, label: string): Promise<{ record: RegistryRecord; sig: string }> {
  const s = await getSodium();
  const record: RegistryRecord = {
    ed25519: await toB64(id.ed25519.publicKey),
    x25519: await toB64(id.x25519.publicKey),
    wg0,
    label,
  };
  const sig = await toB64(s.crypto_sign_detached(canonicalBytes(signable(record)), id.ed25519.secretKey));
  return { record, sig };
}

/** Registry side: verify the self-signature (the announcer controls record.ed25519). */
export async function verifyAnnounce(record: RegistryRecord, sig: string): Promise<boolean> {
  const s = await getSodium();
  try {
    return s.crypto_sign_verify_detached(await fromB64(sig), canonicalBytes(signable(record)), await fromB64(record.ed25519));
  } catch {
    return false;
  }
}

/** Resolver side: the anti-MITM check — the resolved key must hash to the code. */
export async function assertCodeCommits(record: RegistryRecord, code: string): Promise<void> {
  if ((await fingerprint(record.ed25519)) !== code.trim().toUpperCase()) {
    throw new RegistryError("registry returned a key that does not match the code");
  }
}

// --- the store (polaris) ---------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS registry (
  code      TEXT PRIMARY KEY,
  ed25519   TEXT NOT NULL,
  x25519    TEXT NOT NULL,
  wg0       TEXT NOT NULL,
  label     TEXT NOT NULL,
  sig       TEXT NOT NULL,
  announced TEXT NOT NULL
);`;

export class RegistryStore {
  private db: Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.run(SCHEMA);
  }
  upsert(code: string, r: RegistryRecord, sig: string, announced: string): void {
    this.db
      .query(
        "INSERT INTO registry (code,ed25519,x25519,wg0,label,sig,announced) VALUES (?,?,?,?,?,?,?) " +
          "ON CONFLICT(code) DO UPDATE SET ed25519=excluded.ed25519, x25519=excluded.x25519, " +
          "wg0=excluded.wg0, label=excluded.label, sig=excluded.sig, announced=excluded.announced",
      )
      .run(code, r.ed25519, r.x25519, r.wg0, r.label, sig, announced);
  }
  get(code: string): RegistryRecord | null {
    return (this.db
      .query("SELECT ed25519,x25519,wg0,label FROM registry WHERE code = ?")
      .get(code) as RegistryRecord | null) ?? null;
  }
}

/** Registry side: process an announce — verify, derive the code, upsert, return it. */
export async function registerAnnounce(
  store: RegistryStore,
  record: RegistryRecord,
  sig: string,
  now: Date = new Date(),
): Promise<string> {
  if (!(await verifyAnnounce(record, sig))) throw new RegistryError("bad self-signature");
  const code = await fingerprint(record.ed25519);
  store.upsert(code, record, sig, now.toISOString());
  return code;
}

// --- the client (any node) --------------------------------------------------

/** Announce yourself to the registry; returns your `ISL-…` code. */
export async function announce(baseUrl: string, id: Identity, wg0: string, label: string): Promise<string> {
  const { record, sig } = await signRecord(id, wg0, label);
  const r = await fetch(`${baseUrl}/registry/announce`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ record, sig }),
  });
  if (!r.ok) throw new RegistryError(`announce failed: ${r.status}`);
  return ((await r.json()) as { code: string }).code;
}

/** Resolve a friend code to its record, verifying the code commits to the key. */
export async function resolve(baseUrl: string, code: string): Promise<RegistryRecord> {
  const norm = code.trim().toUpperCase();
  const r = await fetch(`${baseUrl}/registry/resolve/${encodeURIComponent(norm)}`);
  if (r.status === 404) throw new RegistryError("code not found");
  if (!r.ok) throw new RegistryError(`resolve failed: ${r.status}`);
  const record = (await r.json()) as RegistryRecord;
  await assertCodeCommits(record, norm);
  return record;
}

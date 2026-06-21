// Node identity — the long-lived keypairs that ARE a node's identity.
//
//   ed25519  signing keypair  -> authenticity (who said this)
//   x25519   box keypair      -> confidentiality (sealed to this node)
//
// Real deployments LOAD keys that William generated on the host (project rule:
// the daemon never mints real key material). loadIdentity() reads them; the
// generate/save helpers exist only for --mock and tests, which use ephemeral keys.
//
// On-disk format (base64 of raw bytes, == Phase One b64()):
//   ed25519.key  Ed25519 32-byte seed        x25519.key  X25519 32-byte private
//   ed25519.pub  Ed25519 32-byte public      x25519.pub  X25519 32-byte public

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromB64, toB64 } from "./codec.ts";
import { getSodium } from "./sodium.ts";

export interface Identity {
  ed25519: { seed: Uint8Array; publicKey: Uint8Array; secretKey: Uint8Array };
  x25519: { publicKey: Uint8Array; privateKey: Uint8Array };
}

/** Load a node identity from a directory of base64 key files. */
export async function loadIdentity(dir: string): Promise<Identity> {
  const s = await getSodium();

  const seed = await fromB64(await readFile(join(dir, "ed25519.key"), "utf8"));
  const ed = s.crypto_sign_seed_keypair(seed); // derive public + 64-byte secret

  const xPriv = await fromB64(await readFile(join(dir, "x25519.key"), "utf8"));
  const xPub = s.crypto_scalarmult_base(xPriv); // derive, don't trust the .pub file

  return {
    ed25519: { seed, publicKey: ed.publicKey, secretKey: ed.privateKey },
    x25519: { publicKey: xPub, privateKey: xPriv },
  };
}

/**
 * Generate an ephemeral identity. DEV/MOCK/TESTS ONLY — real nodes load
 * William's keys via loadIdentity(). Kept here so --mock has an identity to run.
 */
export async function generateIdentity(): Promise<Identity> {
  const s = await getSodium();
  const ed = s.crypto_sign_keypair();
  const x = s.crypto_box_keypair();
  return {
    ed25519: { seed: ed.privateKey.slice(0, 32), publicKey: ed.publicKey, secretKey: ed.privateKey },
    x25519: { publicKey: x.publicKey, privateKey: x.privateKey },
  };
}

/** Persist an identity as base64 key files. DEV/MOCK/TESTS ONLY. */
export async function saveIdentity(dir: string, id: Identity): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "ed25519.key"), await toB64(id.ed25519.seed)),
    writeFile(join(dir, "ed25519.pub"), await toB64(id.ed25519.publicKey)),
    writeFile(join(dir, "x25519.key"), await toB64(id.x25519.privateKey)),
    writeFile(join(dir, "x25519.pub"), await toB64(id.x25519.publicKey)),
  ]);
}

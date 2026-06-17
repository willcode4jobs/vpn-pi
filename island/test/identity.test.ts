import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVerify, sealSign } from "../src/core/envelope.ts";
import { generateIdentity, loadIdentity, saveIdentity } from "../src/core/identity.ts";

test("save -> load round-trips the keys and stays usable as an envelope identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "island-id-"));
  try {
    const id = await generateIdentity();
    await saveIdentity(dir, id);
    const loaded = await loadIdentity(dir);

    expect(loaded.ed25519.publicKey).toEqual(id.ed25519.publicKey);
    expect(loaded.ed25519.secretKey).toEqual(id.ed25519.secretKey);
    expect(loaded.x25519.publicKey).toEqual(id.x25519.publicKey);
    expect(loaded.x25519.privateKey).toEqual(id.x25519.privateKey);

    // the loaded identity must still seal/open against itself
    const payload = { node: "self", seq: 1 };
    const blob = await sealSign(payload, loaded.ed25519.secretKey, loaded.x25519.publicKey);
    const got = await openVerify(
      blob,
      loaded.x25519.publicKey,
      loaded.x25519.privateKey,
      () => loaded.ed25519.publicKey,
    );
    expect(got).toEqual(payload);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("x25519 public key is derived from the private key, not trusted from disk", async () => {
  // loadIdentity recomputes the X25519 public via scalarmult_base; corrupting the
  // stored .pub must not change what gets loaded.
  const dir = await mkdtemp(join(tmpdir(), "island-id-"));
  try {
    const id = await generateIdentity();
    await saveIdentity(dir, id);
    await Bun.write(join(dir, "x25519.pub"), "AAAA"); // garbage
    const loaded = await loadIdentity(dir);
    expect(loaded.x25519.publicKey).toEqual(id.x25519.publicKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

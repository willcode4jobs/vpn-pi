import { expect, test } from "bun:test";
import { toB64 } from "../src/core/codec.ts";
import { fingerprint } from "../src/core/friendcode.ts";
import { generateIdentity } from "../src/core/identity.ts";
import {
  assertCodeCommits,
  registerAnnounce,
  RegistryError,
  RegistryStore,
  type RegistryRecord,
  signRecord,
  verifyAnnounce,
} from "../src/core/registry.ts";

test("a self-signed record verifies; tampering or a foreign signer does not", async () => {
  const id = await generateIdentity();
  const { record, sig } = await signRecord(id, "10.42.0.5", "sirius");
  expect(await verifyAnnounce(record, sig)).toBe(true);

  expect(await verifyAnnounce({ ...record, wg0: "10.42.0.9" }, sig)).toBe(false); // tampered
  expect(await verifyAnnounce({ ...record, label: "evil" }, sig)).toBe(false);

  const other = await signRecord(await generateIdentity(), "10.42.0.5", "sirius");
  expect(await verifyAnnounce(record, other.sig)).toBe(false); // someone else's sig
});

test("registerAnnounce stores under code = fingerprint(key), rejects bad sigs", async () => {
  const store = new RegistryStore(":memory:");
  const id = await generateIdentity();
  const { record, sig } = await signRecord(id, "10.42.0.5", "sirius");

  const code = await registerAnnounce(store, record, sig);
  expect(code).toBe(await fingerprint(record.ed25519));
  expect(store.get(code)).toEqual(record);

  expect(registerAnnounce(store, record, "AAAA")).rejects.toThrow(RegistryError);
});

test("re-announcing updates the record under the same code (e.g. new wg0)", async () => {
  const store = new RegistryStore(":memory:");
  const id = await generateIdentity();

  const a = await signRecord(id, "10.42.0.5", "sirius");
  const code = await registerAnnounce(store, a.record, a.sig);
  const b = await signRecord(id, "10.42.0.99", "sirius-new");
  expect(await registerAnnounce(store, b.record, b.sig)).toBe(code); // same code
  expect(store.get(code)!.wg0).toBe("10.42.0.99");
});

test("assertCodeCommits catches a key that doesn't match the code (anti-MITM)", async () => {
  const id = await generateIdentity();
  const record: RegistryRecord = {
    ed25519: await toB64(id.ed25519.publicKey),
    x25519: await toB64(id.x25519.publicKey),
    wg0: "10.42.0.5",
    label: "sirius",
  };
  const realCode = await fingerprint(record.ed25519);
  await assertCodeCommits(record, realCode); // ok

  const impostor = await generateIdentity();
  const swapped = { ...record, ed25519: await toB64(impostor.ed25519.publicKey) };
  expect(assertCodeCommits(swapped, realCode)).rejects.toThrow(RegistryError); // swapped key fails
});

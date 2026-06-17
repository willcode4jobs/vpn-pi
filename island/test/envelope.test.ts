import { expect, test } from "bun:test";
import { openVerify, sealSign, VerificationError } from "../src/core/envelope.ts";
import { generateIdentity } from "../src/core/identity.ts";

test("round-trip: a sealed+signed payload opens and verifies", async () => {
  const sender = await generateIdentity();
  const recipient = await generateIdentity();
  const payload = { node: "sirius", seq: 1, msg: "hello island" };

  const blob = await sealSign(payload, sender.ed25519.secretKey, recipient.x25519.publicKey);
  const got = await openVerify(
    blob,
    recipient.x25519.publicKey,
    recipient.x25519.privateKey,
    (n) => (n === "sirius" ? sender.ed25519.publicKey : null),
  );

  expect(got).toEqual(payload);
});

test("the blob is opaque — no plaintext leaks to a buffering relay", async () => {
  const sender = await generateIdentity();
  const recipient = await generateIdentity();
  const blob = await sealSign(
    { node: "sirius", secret: "open-the-gate" },
    sender.ed25519.secretKey,
    recipient.x25519.publicKey,
  );
  expect(new TextDecoder().decode(blob)).not.toContain("open-the-gate");
});

test("unknown sender is rejected (fail-closed)", async () => {
  const sender = await generateIdentity();
  const recipient = await generateIdentity();
  const blob = await sealSign(
    { node: "sirius" },
    sender.ed25519.secretKey,
    recipient.x25519.publicKey,
  );
  expect(
    openVerify(blob, recipient.x25519.publicKey, recipient.x25519.privateKey, () => null),
  ).rejects.toThrow(VerificationError);
});

test("wrong signing key is rejected (forgery attempt)", async () => {
  const sender = await generateIdentity();
  const impostor = await generateIdentity();
  const recipient = await generateIdentity();
  const blob = await sealSign(
    { node: "sirius" },
    sender.ed25519.secretKey,
    recipient.x25519.publicKey,
  );
  // register the IMPOSTOR's key for "sirius" -> signature must fail
  expect(
    openVerify(
      blob,
      recipient.x25519.publicKey,
      recipient.x25519.privateKey,
      () => impostor.ed25519.publicKey,
    ),
  ).rejects.toThrow(VerificationError);
});

test("tampered ciphertext is rejected", async () => {
  const sender = await generateIdentity();
  const recipient = await generateIdentity();
  const blob = await sealSign(
    { node: "sirius" },
    sender.ed25519.secretKey,
    recipient.x25519.publicKey,
  );
  blob[blob.length >> 1] ^= 0xff; // flip a byte

  expect(
    openVerify(
      blob,
      recipient.x25519.publicKey,
      recipient.x25519.privateKey,
      () => sender.ed25519.publicKey,
    ),
  ).rejects.toThrow(VerificationError);
});

test("a different recipient cannot open the box", async () => {
  const sender = await generateIdentity();
  const recipient = await generateIdentity();
  const eavesdropper = await generateIdentity();
  const blob = await sealSign(
    { node: "sirius" },
    sender.ed25519.secretKey,
    recipient.x25519.publicKey,
  );
  expect(
    openVerify(
      blob,
      eavesdropper.x25519.publicKey,
      eavesdropper.x25519.privateKey,
      () => sender.ed25519.publicKey,
    ),
  ).rejects.toThrow(VerificationError);
});

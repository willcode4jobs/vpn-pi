import { expect, test } from "bun:test";
import {
  codeMatches,
  decodeInvite,
  decodeReply,
  encodeInvite,
  encodeReply,
  fingerprint,
} from "../src/core/friendcode.ts";
import { FriendBook, makeToken, verifyToken } from "../src/core/friends.ts";
import { generateIdentity } from "../src/core/identity.ts";
import { toB64 } from "../src/core/codec.ts";

test("an invite code is one clean string — not JSON, and shorter", async () => {
  const id = await generateIdentity();
  const token = await makeToken(id, "alice", "10.42.0.1", 86_400);
  const code = await encodeInvite(token);
  expect(code.startsWith("island-invite1")).toBe(true);
  expect(code).not.toContain("{"); // not raw JSON
  expect(code.length).toBeLessThan(JSON.stringify(token).length);
});

test("decode(encode(token)) reconstructs the token exactly and it still verifies", async () => {
  const id = await generateIdentity();
  const token = await makeToken(id, "sirius-box", "10.42.0.5", 3600);
  const round = await decodeInvite(await encodeInvite(token));
  expect(round).toEqual(token); // byte-for-byte object equality
  const from = await verifyToken(round); // signature still valid
  expect(from.ed25519).toBe(await toB64(id.ed25519.publicKey));
});

test("a corrupt / wrong-prefix code is rejected", async () => {
  expect(decodeInvite("not-a-code")).rejects.toThrow(/not an island invite/);
  expect(() => decodeReply("garbage")).toThrow(/not an island reply/);
});

test("reply code round-trips the accept blob", async () => {
  const blob = "QJr4bKVMAPBgQai6==";
  expect(decodeReply(encodeReply(blob))).toBe(blob);
  expect(encodeReply(blob).startsWith("island-reply1")).toBe(true);
});

test("friend code (fingerprint) is deterministic, well-formed, and verifiable", async () => {
  const a = await generateIdentity();
  const b = await generateIdentity();
  const aEd = await toB64(a.ed25519.publicKey);
  const code = await fingerprint(aEd);

  expect(code).toMatch(/^ISL-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/); // Crockford, no I/L/O/U
  expect(await fingerprint(aEd)).toBe(code); // deterministic
  expect(await fingerprint(await toB64(b.ed25519.publicKey))).not.toBe(code); // distinct keys
  expect(await codeMatches(aEd, code)).toBe(true);
  expect(await codeMatches(aEd, code.toLowerCase())).toBe(true); // case-insensitive
  expect(await codeMatches(await toB64(b.ed25519.publicKey), code)).toBe(false);
});

test("full handshake works entirely through codes", async () => {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const aliceBook = new FriendBook(alice, "alice", "10.42.0.1");
  const bobBook = new FriendBook(bob, "bob", "10.42.0.5");

  const invite = await encodeInvite(await aliceBook.issueToken(3600)); // alice -> code
  await bobBook.receive(await decodeInvite(invite)); // bob decodes + receives
  const reply = encodeReply(await bobBook.accept(await toB64(alice.ed25519.publicKey))); // bob -> reply code
  await aliceBook.confirm(decodeReply(reply)); // alice decodes + confirms

  expect(aliceBook.isFriend(await toB64(bob.ed25519.publicKey))).toBe(true);
  expect(bobBook.isFriend(await toB64(alice.ed25519.publicKey))).toBe(true);
});

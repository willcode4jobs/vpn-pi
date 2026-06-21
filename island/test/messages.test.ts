import { expect, test } from "bun:test";
import { toB64 } from "../src/core/codec.ts";
import { VerificationError } from "../src/core/envelope.ts";
import { FriendBook, peerPubOf } from "../src/core/friends.ts";
import { generateIdentity } from "../src/core/identity.ts";
import { MessageBook, openMessage, sealMessage } from "../src/core/messages.ts";

test("seal -> open round-trips a message between friends", async () => {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const bobPub = await peerPubOf(bob, "bob", "10.42.0.5");
  const aliceEd = await toB64(alice.ed25519.publicKey);

  const blob = await sealMessage(alice, bobPub, "hello bob", new Date("2026-06-17T00:00:00Z"));
  const verify = (ed: string) => (ed === aliceEd ? alice.ed25519.publicKey : null);
  const msg = await openMessage(bob, blob, verify);

  expect(msg.from).toBe(aliceEd);
  expect(msg.to).toBe(await toB64(bob.ed25519.publicKey));
  expect(msg.body).toBe("hello bob");
  expect(msg.ts).toBe("2026-06-17T00:00:00.000Z");
});

test("a message from a non-friend is rejected (resolver returns null)", async () => {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const bobPub = await peerPubOf(bob, "bob", "10.42.0.5");
  const blob = await sealMessage(alice, bobPub, "let me in");
  expect(openMessage(bob, blob, () => null)).rejects.toThrow(VerificationError);
});

test("a third party cannot open a message sealed to Bob", async () => {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const mallory = await generateIdentity();
  const aliceEd = await toB64(alice.ed25519.publicKey);
  const blob = await sealMessage(alice, await peerPubOf(bob, "bob", "10.42.0.5"), "secret");
  expect(
    openMessage(mallory, blob, (ed) => (ed === aliceEd ? alice.ed25519.publicKey : null)),
  ).rejects.toThrow(VerificationError);
});

test("the sealed blob leaks no plaintext", async () => {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const blob = await sealMessage(alice, await peerPubOf(bob, "bob", "10.42.0.5"), "TOP-SECRET-BODY");
  expect(blob).not.toContain("TOP-SECRET-BODY");
});

test("FriendBook.verifyKeyResolver resolves only friends", async () => {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  const stranger = await generateIdentity();
  const aliceBook = new FriendBook(alice, "alice", "10.42.0.1");
  const bobBook = new FriendBook(bob, "bob", "10.42.0.5");

  // make them friends
  const token = await aliceBook.issueToken(3600);
  await bobBook.receive(token);
  await aliceBook.confirm(await bobBook.accept(await toB64(alice.ed25519.publicKey)));

  const resolve = await aliceBook.verifyKeyResolver();
  expect(resolve(await toB64(bob.ed25519.publicKey))).toEqual(bob.ed25519.publicKey);
  expect(resolve(await toB64(stranger.ed25519.publicKey))).toBeNull();
});

test("MessageBook stores and threads oldest-first; survives serialize", async () => {
  const book = new MessageBook();
  const peer = "PEER_ED";
  book.append(peer, { dir: "out", from: "me", to: peer, body: "first", ts: "2026-06-17T00:00:01Z" });
  book.append(peer, { dir: "in", from: peer, to: "me", body: "reply", ts: "2026-06-17T00:00:00Z" });

  const thread = book.thread(peer);
  expect(thread.map((m) => m.body)).toEqual(["reply", "first"]); // sorted by ts
  expect(book.peers()).toEqual([peer]);

  const restored = MessageBook.fromJSON(JSON.parse(JSON.stringify(book)));
  expect(restored.thread(peer)).toHaveLength(2);
});

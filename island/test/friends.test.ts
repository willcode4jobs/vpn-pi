import { expect, test } from "bun:test";
import { toB64 } from "../src/core/codec.ts";
import {
  FriendBook,
  FriendError,
  makeToken,
  verifyToken,
} from "../src/core/friends.ts";
import { generateIdentity, type Identity } from "../src/core/identity.ts";

async function ed(id: Identity): Promise<string> {
  return toB64(id.ed25519.publicKey);
}

async function pair(): Promise<{
  alice: Identity;
  bob: Identity;
  aliceBook: FriendBook;
  bobBook: FriendBook;
}> {
  const alice = await generateIdentity();
  const bob = await generateIdentity();
  return {
    alice,
    bob,
    aliceBook: new FriendBook(alice, "alice", "10.42.0.1"),
    bobBook: new FriendBook(bob, "bob", "10.42.0.5"),
  };
}

test("full handshake: give -> receive -> accept -> confirm = mutual friends", async () => {
  const { alice, bob, aliceBook, bobBook } = await pair();

  const token = await aliceBook.issueToken(3600); // Alice gives
  await bobBook.receive(token); // Bob sees a request
  expect(bobBook.listPending().map((p) => p.peer.label)).toEqual(["alice"]);

  const acceptBlob = await bobBook.accept(await ed(alice)); // Bob accepts
  expect(bobBook.isFriend(await ed(alice))).toBe(true);
  expect(bobBook.listPending()).toHaveLength(0);

  await aliceBook.confirm(acceptBlob); // Alice confirms
  expect(aliceBook.isFriend(await ed(bob))).toBe(true);

  // both hold the other's verified keys
  expect(aliceBook.friend(await ed(bob))!.peer.x25519).toBe(await toB64(bob.x25519.publicKey));
  expect(bobBook.friend(await ed(alice))!.peer.x25519).toBe(await toB64(alice.x25519.publicKey));
});

test("expired token is rejected", async () => {
  const { aliceBook, bobBook } = await pair();
  const now = new Date("2026-01-01T00:00:00Z");
  const token = await aliceBook.issueToken(60, now);
  const later = new Date("2026-01-01T00:05:00Z"); // 5 min later, ttl was 60s
  expect(bobBook.receive(token, later)).rejects.toThrow(FriendError);
});

test("tampered token is rejected (signature covers from/label)", async () => {
  const { bobBook, aliceBook } = await pair();
  const token = await aliceBook.issueToken(3600);
  token.from.label = "not-alice"; // change signed content
  expect(bobBook.receive(token)).rejects.toThrow(/bad token signature/);
});

test("a token is single-use: replay is rejected", async () => {
  const { alice, aliceBook, bobBook } = await pair();
  const token = await aliceBook.issueToken(3600);
  await bobBook.receive(token);
  await bobBook.accept(await ed(alice)); // consumes the nonce
  expect(bobBook.receive(token)).rejects.toThrow(/already used/);
});

test("an offer can only be confirmed once", async () => {
  const { alice, aliceBook, bobBook } = await pair();
  const token = await aliceBook.issueToken(3600);
  await bobBook.receive(token);
  const blob = await bobBook.accept(await ed(alice));
  await aliceBook.confirm(blob);
  expect(aliceBook.confirm(blob)).rejects.toThrow(FriendError);
});

test("you cannot friend yourself", async () => {
  const alice = await generateIdentity();
  const book = new FriendBook(alice, "alice", "10.42.0.1");
  const ownToken = await book.issueToken(3600);
  expect(book.receive(ownToken)).rejects.toThrow(/yourself/);
});

test("accepting a non-pending peer fails", async () => {
  const { bob, aliceBook } = await pair();
  expect(aliceBook.accept(await ed(bob))).rejects.toThrow(/no pending request/);
});

test("an accept sealed to Alice cannot be opened/confirmed by a third party", async () => {
  const { alice, bob, aliceBook, bobBook } = await pair();
  const mallory = await generateIdentity();
  const malloryBook = new FriendBook(mallory, "mallory", "10.42.0.9");

  const token = await aliceBook.issueToken(3600);
  await bobBook.receive(token);
  const blob = await bobBook.accept(await ed(alice)); // sealed to Alice

  // Mallory never offered anything and can't open a box sealed to Alice
  expect(malloryBook.confirm(blob)).rejects.toThrow(FriendError);
});

test("the accept blob is opaque — no plaintext label leaks", async () => {
  const { alice, aliceBook, bobBook } = await pair();
  const token = await aliceBook.issueToken(3600);
  await bobBook.receive(token);
  const blob = await bobBook.accept(await ed(alice));
  // base64 of a sealed box — decoding must not reveal "bob"
  expect(blob).not.toContain("bob");
});

test("revoke removes a friendship (one-sided)", async () => {
  const { alice, bob, aliceBook, bobBook } = await pair();
  const token = await aliceBook.issueToken(3600);
  await bobBook.receive(token);
  await aliceBook.confirm(await bobBook.accept(await ed(alice)));

  expect(aliceBook.revoke(await ed(bob))).toBe(true);
  expect(aliceBook.isFriend(await ed(bob))).toBe(false);
  // Bob still considers Alice a friend until he revokes too (one-sided)
  expect(bobBook.isFriend(await ed(alice))).toBe(true);
});

test("there is NO API to force/create a friendship", async () => {
  const { aliceBook } = await pair();
  // structural guarantee: only the verified handshake mutates `friends`
  expect((aliceBook as unknown as Record<string, unknown>).addFriend).toBeUndefined();
  expect((aliceBook as unknown as Record<string, unknown>).forceFriend).toBeUndefined();
  expect((aliceBook as unknown as Record<string, unknown>).setFriend).toBeUndefined();
});

test("standalone makeToken/verifyToken round-trip", async () => {
  const alice = await generateIdentity();
  const token = await makeToken(alice, "alice", "10.42.0.1", 3600);
  const from = await verifyToken(token);
  expect(from.ed25519).toBe(await toB64(alice.ed25519.publicKey));
});

test("book serializes and restores (friends survive a restart)", async () => {
  const { alice, bob, aliceBook, bobBook } = await pair();
  const token = await aliceBook.issueToken(3600);
  await bobBook.receive(token);
  await aliceBook.confirm(await bobBook.accept(await ed(alice)));

  const restored = FriendBook.fromJSON(alice, "alice", "10.42.0.1", JSON.parse(JSON.stringify(aliceBook)));
  expect(restored.isFriend(await ed(bob))).toBe(true);
});

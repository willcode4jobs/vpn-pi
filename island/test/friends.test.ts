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

// ---- mutual removal: signed revoke notices ----------------------------------

async function friends() {
  const p = await pair();
  const token = await p.aliceBook.issueToken(3600);
  await p.bobBook.receive(token);
  await p.aliceBook.confirm(await p.bobBook.accept(await ed(p.alice)));
  return p;
}

test("issueRevoke + receiveRevoke: both sides drop the friendship", async () => {
  const { alice, bob, aliceBook, bobBook } = await friends();
  const r = (await aliceBook.issueRevoke(await ed(bob)))!;
  expect(r.wg0).toBe("10.42.0.5"); // where to deliver: bob's stored wg0
  expect(aliceBook.isFriend(await ed(bob))).toBe(false); // local removal is immediate
  const removed = await bobBook.receiveRevoke(r.notice);
  expect(removed.peer.label).toBe("alice");
  expect(bobBook.isFriend(await ed(alice))).toBe(false); // and now mutual
});

test("issueRevoke returns null for a non-friend (route 404s)", async () => {
  const { aliceBook } = await pair();
  expect(await aliceBook.issueRevoke("not-a-friend-key")).toBeNull();
});

test("receiveRevoke rejects a notice from a non-friend (nothing to destroy)", async () => {
  const { bob, bobBook } = await friends();
  const mallory = await generateIdentity();
  // mallory can't MINT one via the API (not friends with bob), so forge the shape by
  // hand — correctly addressed to bob, but `from` matches no stored friend record.
  const forged = {
    v: 1 as const,
    from: await ed(mallory),
    target: await ed(bob),
    nonce: "n",
    at: new Date().toISOString(),
    sig: "AAAA",
  };
  expect(bobBook.receiveRevoke(forged as never)).rejects.toThrow(/not a friend/);
});

test("receiveRevoke rejects a tampered notice (signature covers all fields)", async () => {
  const { bob, aliceBook, bobBook } = await friends();
  const r = (await aliceBook.issueRevoke(await ed(bob)))!;
  const tampered = { ...r.notice, at: new Date(Date.now() + 60_000).toISOString() };
  expect(bobBook.receiveRevoke(tampered)).rejects.toThrow(/bad revoke signature/);
});

test("receiveRevoke rejects a notice addressed to someone else", async () => {
  const { alice, bob, aliceBook, bobBook } = await friends();
  // carol also friends bob... simplest: alice mints a revoke for bob, carol replays it to herself.
  // Here: bob receives a notice whose target is NOT bob.
  const r = (await aliceBook.issueRevoke(await ed(bob)))!;
  const misaddressed = { ...r.notice, target: await ed(alice) }; // breaks sig too, but target check fires first
  expect(bobBook.receiveRevoke(misaddressed)).rejects.toThrow(/not addressed/);
});

test("a revoke notice is single-use (nonce joins the consumed set)", async () => {
  const { alice, bob, aliceBook, bobBook } = await friends();
  const r = (await aliceBook.issueRevoke(await ed(bob)))!;
  await bobBook.receiveRevoke(r.notice);
  // re-friend, then replay the captured notice
  const token = await aliceBook.issueToken(3600);
  await bobBook.receive(token);
  await aliceBook.confirm(await bobBook.accept(await ed(alice)));
  expect(bobBook.receiveRevoke(r.notice)).rejects.toThrow(/already used/);
});

test("a revoke minted before the current friendship began is stale (era replay)", async () => {
  const { alice, bob, aliceBook, bobBook } = await friends();
  const old = new Date("2026-01-01T00:00:00Z");
  const r = (await aliceBook.issueRevoke(await ed(bob), old))!;
  // bob never saw it; the pair re-friends much later
  const token = await aliceBook.issueToken(3600);
  await bobBook.receive(token);
  await aliceBook.confirm(await bobBook.accept(await ed(alice)));
  expect(bobBook.receiveRevoke(r.notice)).rejects.toThrow(/stale revoke/);
});

test("revoke state survives a restart (consumed nonce persists)", async () => {
  const { alice, bob, aliceBook, bobBook } = await friends();
  const r = (await aliceBook.issueRevoke(await ed(bob)))!;
  await bobBook.receiveRevoke(r.notice);
  const restored = FriendBook.fromJSON(bob, "bob", "10.42.0.5", JSON.parse(JSON.stringify(bobBook)));
  expect(restored.isFriend(await ed(alice))).toBe(false);
  expect(restored.receiveRevoke(r.notice)).rejects.toThrow(FriendError); // replay still dead after restart
});

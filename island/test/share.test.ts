import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileNotFound,
  type FileShare,
  MemoryFileShare,
  SqliteFileShare,
} from "../src/core/share.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

// Run the same contract against both the in-memory and SQLite implementations.
const impls: [string, () => FileShare][] = [
  ["MemoryFileShare", () => new MemoryFileShare()],
  ["SqliteFileShare", () => new SqliteFileShare(":memory:")],
];

for (const [name, make] of impls) {
  test(`${name}: add returns a SharedFile with size + adder`, async () => {
    const share = make();
    const f = await share.add("notes.txt", bytes("hello island"), "PUBKEY_ALICE", "text/plain");
    expect(f.id).toBeGreaterThan(0);
    expect(f.name).toBe("notes.txt");
    expect(f.size).toBe("hello island".length);
    expect(f.node).toBe("PUBKEY_ALICE");
    expect(typeof f.modified).toBe("string");
  });

  test(`${name}: list is newest-first and carries root/bind labels`, async () => {
    const share = make();
    await share.add("a", bytes("a"), "n1");
    await share.add("b", bytes("b"), "n1");
    const snap = await share.list();
    expect(snap.files.map((f) => f.name)).toEqual(["b", "a"]);
    expect(typeof snap.root).toBe("string");
    expect(typeof snap.bind).toBe("string");
  });

  test(`${name}: get returns the exact bytes back`, async () => {
    const share = make();
    const f = await share.add("blob.bin", bytes("round-trip"), "n1", "application/octet-stream");
    const got = await share.get(f.id);
    expect(new TextDecoder().decode(got.content)).toBe("round-trip");
    expect(got.name).toBe("blob.bin");
    expect(got.contentType).toBe("application/octet-stream");
  });

  test(`${name}: get/remove of an unknown id throws FileNotFound`, async () => {
    const share = make();
    expect(share.get(999)).rejects.toThrow(FileNotFound);
    expect(share.remove(999)).rejects.toThrow(FileNotFound);
  });

  test(`${name}: remove deletes the file`, async () => {
    const share = make();
    const f = await share.add("gone.txt", bytes("x"), "n1");
    await share.remove(f.id);
    expect(share.get(f.id)).rejects.toThrow(FileNotFound);
    expect((await share.list()).files).toHaveLength(0);
  });
}

test("SqliteFileShare persists across reopen (vega's DB survives a restart)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "island-share-"));
  const path = join(dir, "island.db");
  try {
    const first = new SqliteFileShare(path);
    const f = await first.add("keepme.txt", bytes("durable"), "PUBKEY_BOB", "text/plain");

    const reopened = new SqliteFileShare(path); // simulate a restart
    const got = await reopened.get(f.id);
    expect(new TextDecoder().decode(got.content)).toBe("durable");
    expect((await reopened.list()).files[0]!.node).toBe("PUBKEY_BOB");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

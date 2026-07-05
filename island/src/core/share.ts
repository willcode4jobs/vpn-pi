// The universal file share — vega's existing SQLite DB, reused.
//
// Mirrors the Phase One file-store convention (gui-and-app/backend/app/store.py +
// db.py): one FileShare interface with three implementations selected by env, the
// same `files` table, and the same SharedFile / FilesSnapshot wire models — so the
// API and the data carry over unchanged.
//
//   MemoryFileShare  — in-memory, the --mock/dev default (≈ PlaceholderFileStore)
//   SqliteFileShare  — durable, runs ON VEGA: ISLAND_SHARE=sqlite (≈ SqliteFileStore)
//   RemoteFileShare  — a node's view of vega's share: ISLAND_SHARE=remote
//                      ISLAND_SHARE_URL=http://<vega-wg0>:8787 (≈ RemoteFileStore)
//
// Phase Two change vs. Phase One: the share is island-wide and "fully shared" among
// friended members, and `node` (attribution) is the adder's verified identity, not a
// wg0 IP. Access control is enforced at the route layer (friendship), not here.

import { Database } from "bun:sqlite";

/** One entry in the island file share. `id` is the row id used to download/delete. */
export interface SharedFile {
  id: number;
  name: string;
  size: number; // bytes
  node: string; // who contributed it (verified adder identity)
  modified: string; // ISO 8601 UTC
}

/** Everything the Files panel needs for one render. */
export interface FilesSnapshot {
  root: string; // share root label, e.g. "vega:island.db"
  bind: string; // where the share listens, e.g. "wg0:8787"
  files: SharedFile[]; // newest first
}

export interface FileContent {
  name: string;
  contentType: string | undefined;
  content: Uint8Array;
}

export class FileNotFound extends Error {}

/** The island file-share surface. All three implementations satisfy it. */
export interface FileShare {
  list(): Promise<FilesSnapshot>;
  add(name: string, content: Uint8Array, node: string, contentType?: string): Promise<SharedFile>;
  get(id: number): Promise<FileContent>;
  remove(id: number): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Reduce an untrusted upload filename to a safe stored name: basename only (no `../`
 *  save-path hints), no control chars / CR / LF / double-quotes (they'd corrupt a quoted
 *  Content-Disposition header), length-capped. Every backend's add() applies this, so a
 *  hostile name never reaches the DB or a response header. */
function sanitizeFileName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "_").trim().slice(0, 160);
  return clean && clean !== "." && clean !== ".." ? clean : "unnamed";
}

// --- in-memory (mock/dev) ---------------------------------------------------

export class MemoryFileShare implements FileShare {
  private rows = new Map<number, SharedFile & { contentType?: string; content: Uint8Array }>();
  private nextId = 1;

  async list(): Promise<FilesSnapshot> {
    const files = [...this.rows.values()]
      .map(({ id, name, size, node, modified }) => ({ id, name, size, node, modified }))
      .sort((a, b) => b.id - a.id);
    return { root: "memory", bind: "mock", files };
  }

  async add(name: string, content: Uint8Array, node: string, contentType?: string): Promise<SharedFile> {
    const id = this.nextId++;
    const rec = { id, name: sanitizeFileName(name), size: content.length, node, modified: nowIso(), contentType, content };
    this.rows.set(id, rec);
    return { id, name: rec.name, size: rec.size, node: rec.node, modified: rec.modified };
  }

  async get(id: number): Promise<FileContent> {
    const r = this.rows.get(id);
    if (!r) throw new FileNotFound(`no file ${id}`);
    return { name: r.name, contentType: r.contentType, content: r.content };
  }

  async remove(id: number): Promise<void> {
    if (!this.rows.delete(id)) throw new FileNotFound(`no file ${id}`);
  }
}

// --- SQLite (vega, durable) — reuses the Phase One `files` schema -----------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  size          INTEGER NOT NULL,
  node          TEXT    NOT NULL,
  content_type  TEXT,
  content       BLOB    NOT NULL,
  modified      TEXT    NOT NULL
);`;

export class SqliteFileShare implements FileShare {
  private db: Database;

  constructor(
    path: string,
    private readonly rootLabel = "vega:island.db",
    private readonly bind = "wg0:8787",
  ) {
    this.db = new Database(path);
    this.db.run(SCHEMA);
  }

  async list(): Promise<FilesSnapshot> {
    const files = this.db
      .query("SELECT id, name, size, node, modified FROM files ORDER BY id DESC")
      .all() as SharedFile[];
    return { root: this.rootLabel, bind: this.bind, files };
  }

  async add(name: string, content: Uint8Array, node: string, contentType?: string): Promise<SharedFile> {
    const safeName = sanitizeFileName(name);
    const modified = nowIso();
    const row = this.db
      .query(
        "INSERT INTO files (name, size, node, content_type, content, modified) " +
          "VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(safeName, content.length, node, contentType ?? null, content, modified) as { id: number };
    return { id: row.id, name: safeName, size: content.length, node, modified };
  }

  async get(id: number): Promise<FileContent> {
    const r = this.db
      .query("SELECT name, content_type, content FROM files WHERE id = ?")
      .get(id) as { name: string; content_type: string | null; content: Uint8Array } | null;
    if (!r) throw new FileNotFound(`no file ${id}`);
    return { name: r.name, contentType: r.content_type ?? undefined, content: new Uint8Array(r.content) };
  }

  async remove(id: number): Promise<void> {
    const res = this.db.query("DELETE FROM files WHERE id = ?").run(id);
    if (res.changes === 0) throw new FileNotFound(`no file ${id}`);
  }
}

// --- remote (a node forwarding to vega's share) -----------------------------

function filenameFromDisposition(cd: string | null): string {
  const m = cd?.match(/filename="?([^"]+)"?/);
  return m?.[1] ?? "download";
}

export class RemoteFileShare implements FileShare {
  constructor(private readonly base: string) {
    if (!base) throw new Error("RemoteFileShare needs ISLAND_SHARE_URL");
  }

  async list(): Promise<FilesSnapshot> {
    const r = await fetch(`${this.base}/api/files`);
    if (!r.ok) throw new Error(`remote list failed: ${r.status}`);
    return (await r.json()) as FilesSnapshot;
  }

  // `node` is intentionally ignored: vega attributes the file to THIS node's
  // verified identity (from the request), exactly as Phase One did.
  async add(name: string, content: Uint8Array, _node: string, contentType?: string): Promise<SharedFile> {
    const form = new FormData();
    // vega's store sanitizes again on its own add(); cleaning here too keeps the wire name safe.
    form.append("file", new Blob([content], { type: contentType ?? "application/octet-stream" }), sanitizeFileName(name));
    const r = await fetch(`${this.base}/api/files`, { method: "POST", body: form });
    if (!r.ok) throw new Error(`remote add failed: ${r.status}`);
    return (await r.json()) as SharedFile;
  }

  async get(id: number): Promise<FileContent> {
    const r = await fetch(`${this.base}/api/files/${id}/download`);
    if (r.status === 404) throw new FileNotFound(`no file ${id}`);
    if (!r.ok) throw new Error(`remote get failed: ${r.status}`);
    return {
      name: filenameFromDisposition(r.headers.get("content-disposition")),
      contentType: r.headers.get("content-type") ?? undefined,
      content: new Uint8Array(await r.arrayBuffer()),
    };
  }

  async remove(id: number): Promise<void> {
    const r = await fetch(`${this.base}/api/files/${id}`, { method: "DELETE" });
    if (r.status === 404) throw new FileNotFound(`no file ${id}`);
    if (!r.ok) throw new Error(`remote remove failed: ${r.status}`);
  }
}

/** Select the share implementation from env (mirrors Phase One build_store). */
export function buildShare(env: Record<string, string | undefined> = process.env): FileShare {
  const kind = env.ISLAND_SHARE ?? "memory";
  switch (kind) {
    case "memory":
      return new MemoryFileShare();
    case "sqlite":
      return new SqliteFileShare(env.ISLAND_DB_PATH ?? "/var/lib/islandd/island.db");
    case "remote":
      return new RemoteFileShare(env.ISLAND_SHARE_URL ?? "");
    default:
      throw new Error(`unknown ISLAND_SHARE: ${kind}`);
  }
}

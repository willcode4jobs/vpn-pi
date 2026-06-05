import { useCallback, useEffect, useRef, useState } from "react";
import type { FilesSnapshot, IdsEvent, NodeIdentity, SharedFile } from "./types";

// Result of a polled endpoint. `stale` true once a fetch has failed since the
// last success — the silent-node signal the screen is built around: when the
// data stops, that absence is itself the alarm, not a quiet empty table.
export interface Poll<T> {
  data: T | null;
  stale: boolean;
  lastOk: Date | null;
  error: string | null;
}

async function getJSON<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

// Poll a JSON endpoint on an interval. Keeps the last good data on the screen
// while flagging staleness, rather than blanking out — an admin needs the last
// known state even when the feed drops. Returns a `refetch` so a mutation (e.g.
// an upload) can refresh immediately instead of waiting for the next tick.
function usePoll<T>(url: string, intervalMs: number): Poll<T> & { refetch: () => void } {
  const [state, setState] = useState<Poll<T>>({
    data: null,
    stale: false,
    lastOk: null,
    error: null,
  });
  const lastOk = useRef<Date | null>(null);
  const alive = useRef(true);
  const ctrl = useRef<AbortController | null>(null);

  const tick = useCallback(async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    try {
      const data = await getJSON<T>(url, c.signal);
      if (!alive.current) return;
      lastOk.current = new Date();
      setState({ data, stale: false, lastOk: lastOk.current, error: null });
    } catch (e) {
      if (!alive.current || c.signal.aborted) return;
      setState((prev) => ({
        ...prev,
        stale: true,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive.current = false;
      ctrl.current?.abort();
      clearInterval(id);
    };
  }, [tick, intervalMs]);

  return { ...state, refetch: tick };
}

export const useNode = (intervalMs = 2000) =>
  usePoll<NodeIdentity>("/api/node", intervalMs);

export const useFiles = (intervalMs = 2000) =>
  usePoll<FilesSnapshot>("/api/files", intervalMs);

export const useIds = (intervalMs = 2000) =>
  usePoll<IdsEvent[]>("/api/ids", intervalMs);

// --- File-share mutations (the polaris SQLite store) ---

export async function uploadFile(file: File, node?: string): Promise<SharedFile> {
  const body = new FormData();
  body.append("file", file);
  if (node) body.append("node", node);
  const res = await fetch("/api/files", { method: "POST", body });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as SharedFile;
}

export async function deleteFile(id: number): Promise<void> {
  const res = await fetch(`/api/files/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: ${res.status} ${res.statusText}`);
}

export const downloadUrl = (id: number) => `/api/files/${id}/download`;

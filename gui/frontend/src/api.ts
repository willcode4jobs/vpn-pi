import { useEffect, useRef, useState } from "react";
import type { FilesSnapshot, IdsEvent, NodeIdentity } from "./types";

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
// known state even when the feed drops.
function usePoll<T>(url: string, intervalMs: number): Poll<T> {
  const [state, setState] = useState<Poll<T>>({
    data: null,
    stale: false,
    lastOk: null,
    error: null,
  });
  const lastOk = useRef<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();

    const tick = async () => {
      try {
        const data = await getJSON<T>(url, ctrl.signal);
        if (!alive) return;
        lastOk.current = new Date();
        setState({ data, stale: false, lastOk: lastOk.current, error: null });
      } catch (e) {
        if (!alive || ctrl.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          stale: true,
          error: e instanceof Error ? e.message : String(e),
        }));
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(id);
    };
  }, [url, intervalMs]);

  return state;
}

export const useNode = (intervalMs = 2000) =>
  usePoll<NodeIdentity>("/api/node", intervalMs);

export const useFiles = (intervalMs = 2000) =>
  usePoll<FilesSnapshot>("/api/files", intervalMs);

export const useIds = (intervalMs = 2000) =>
  usePoll<IdsEvent[]>("/api/ids", intervalMs);

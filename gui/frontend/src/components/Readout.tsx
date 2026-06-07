import type { ReactNode } from "react";
import type { Poll } from "../api";

// The shared "awaiting / empty / content" ladder every polled list panel uses:
// data null -> first read pending; empty array -> the panel's empty message;
// otherwise render content from the non-null list. (Files keeps its own body —
// it's a snapshot wrapper with an upload control, not a bare list.)
export function Readout<T>({
  poll,
  empty,
  children,
}: {
  poll: Poll<T[]>;
  empty: string;
  children: (data: T[]) => ReactNode;
}) {
  if (poll.data === null) return <div className="empty">awaiting first read…</div>;
  if (poll.data.length === 0) return <div className="empty">{empty}</div>;
  return <>{children(poll.data)}</>;
}

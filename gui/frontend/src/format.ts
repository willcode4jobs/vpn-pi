// Render an ISO timestamp as a compact handshake age: "12s", "3m04s", "1h02m".
// null/never -> "never". This is the column an admin scans first.
export function age(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "never";
  const secs = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

// Wall-clock HH:MM:SS for the IDS feed timestamps.
export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

// Byte count as a compact size: "2.1K", "18.4M", "482K". Right-aligned column.
export function bytes(n: number): string {
  if (n < 1024) return `${n}B`;
  const units = ["K", "M", "G", "T"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
}

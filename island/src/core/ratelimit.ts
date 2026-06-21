// Brute-force protection for the token-guarded surfaces (admin + operator).
//
// The token check is already constant-time and SERVER-SIDE (editing the frontend can't
// bypass it), but without a limit an attacker could spam guesses. This caps FAILED
// attempts per source IP in a sliding window; once over the limit the caller is locked
// out (HTTP 429) until the failures age out. A successful auth clears the counter, so a
// legitimate admin is never throttled.

export class AttemptLimiter {
  private hits = new Map<string, number[]>(); // key (IP) -> recent failure timestamps

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length) this.hits.set(key, kept);
    else this.hits.delete(key);
    return kept;
  }

  /** True if this key has too many recent failures and should be rejected now. */
  locked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  /** Record a failed attempt. */
  fail(key: string): void {
    const a = this.recent(key);
    a.push(this.now());
    this.hits.set(key, a);
  }

  /** Clear a key's failures (call on a successful auth). */
  reset(key: string): void {
    this.hits.delete(key);
  }
}

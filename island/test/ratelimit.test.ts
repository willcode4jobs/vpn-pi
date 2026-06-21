import { expect, test } from "bun:test";
import { AttemptLimiter } from "../src/core/ratelimit.ts";

test("locks out after max failures, per key", () => {
  let t = 1000;
  const lim = new AttemptLimiter(3, 60_000, () => t);
  expect(lim.locked("1.2.3.4")).toBe(false);
  lim.fail("1.2.3.4");
  lim.fail("1.2.3.4");
  expect(lim.locked("1.2.3.4")).toBe(false); // 2 < 3
  lim.fail("1.2.3.4");
  expect(lim.locked("1.2.3.4")).toBe(true); // 3 >= 3
  expect(lim.locked("5.6.7.8")).toBe(false); // a different IP is unaffected
});

test("a successful auth (reset) clears the counter", () => {
  let t = 1000;
  const lim = new AttemptLimiter(3, 60_000, () => t);
  lim.fail("ip"); lim.fail("ip"); lim.fail("ip");
  expect(lim.locked("ip")).toBe(true);
  lim.reset("ip");
  expect(lim.locked("ip")).toBe(false);
});

test("failures age out of the sliding window", () => {
  let t = 1000;
  const lim = new AttemptLimiter(3, 60_000, () => t);
  lim.fail("ip"); lim.fail("ip"); lim.fail("ip");
  expect(lim.locked("ip")).toBe(true);
  t += 61_000; // window passes
  expect(lim.locked("ip")).toBe(false);
});

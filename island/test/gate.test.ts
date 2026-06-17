import { expect, test } from "bun:test";
import type { Canary } from "../src/core/canary.ts";
import { CanaryError } from "../src/core/canary.ts";
import { Gate, type LlamaClient, MockLlama, NoopGateExec } from "../src/core/gate.ts";

const canary = (nonce: string): Canary => ({
  admin: "ADMIN_ED",
  keyword: "GREEN18",
  text: "GREEN18 open the gate",
  nonce,
  issued: "2026-06-17T00:00:00.000Z",
});

const denyLlama: LlamaClient = { async decide() {
  return { approve: false, reason: "policy: denied" };
} };

test("default state is island (closed)", () => {
  const gate = new Gate(new MockLlama(), new NoopGateExec(), 2700);
  expect(gate.state().state).toBe("island");
});

test("an approved canary opens egress, sets a close time, logs it", async () => {
  const exec = new NoopGateExec();
  const gate = new Gate(new MockLlama(), exec, 2700);
  const now = new Date("2026-06-17T00:00:00Z");
  const res = await gate.open(canary("n1"), now);

  expect(res.opened).toBe(true);
  expect(gate.state().state).toBe("internet");
  expect(gate.state().closesAt).toBe("2026-06-17T00:45:00.000Z"); // +45 min
  expect(exec.opens).toBe(1);
  expect(gate.log().at(-1)).toMatchObject({ action: "open", admin: "ADMIN_ED" });
  await gate.close("cleanup"); // clear the timer
});

test("a denied canary does NOT open egress (LLM is a refusal layer)", async () => {
  const exec = new NoopGateExec();
  const gate = new Gate(denyLlama, exec, 2700);
  const res = await gate.open(canary("n2"));
  expect(res.opened).toBe(false);
  expect(gate.state().state).toBe("island");
  expect(exec.opens).toBe(0);
  expect(gate.log().at(-1)).toMatchObject({ action: "deny" });
});

test("a canary nonce is single-use (replay rejected)", async () => {
  const gate = new Gate(new MockLlama(), new NoopGateExec(), 2700);
  await gate.open(canary("n3"));
  expect(gate.open(canary("n3"))).rejects.toThrow(CanaryError);
  await gate.close("cleanup");
});

test("manual close returns to island and runs exec.close", async () => {
  const exec = new NoopGateExec();
  const gate = new Gate(new MockLlama(), exec, 2700);
  await gate.open(canary("n4"));
  const st = await gate.close("manual");
  expect(st.state).toBe("island");
  expect(st.closesAt).toBeNull();
  expect(exec.closes).toBe(1);
});

test("egress auto-recloses after the TTL", async () => {
  const exec = new NoopGateExec();
  const gate = new Gate(new MockLlama(), exec, 0.05); // 50ms
  await gate.open(canary("n5"));
  expect(gate.state().state).toBe("internet");
  await new Promise((r) => setTimeout(r, 90));
  expect(gate.state().state).toBe("island");
  expect(exec.closes).toBe(1);
});

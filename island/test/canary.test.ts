import { expect, test } from "bun:test";
import { CanaryError, makeCanary, verifyCanary } from "../src/core/canary.ts";
import { toB64 } from "../src/core/codec.ts";
import { VerificationError } from "../src/core/envelope.ts";
import { generateIdentity, type Identity } from "../src/core/identity.ts";

const KW = "GREEN18";

async function setup() {
  const admin = await generateIdentity();
  const vega = await generateIdentity();
  const adminEd = await toB64(admin.ed25519.publicKey);
  const vegaX = await toB64(vega.x25519.publicKey);
  const allow = (ed: string) => (ed === adminEd ? admin.ed25519.publicKey : null);
  return { admin, vega, adminEd, vegaX, allow };
}

test("a valid canary verifies", async () => {
  const { admin, vega, adminEd, vegaX, allow } = await setup();
  const blob = await makeCanary(admin, KW, "GREEN18 open the gate", vegaX);
  const c = await verifyCanary(vega, blob, allow, KW, 120);
  expect(c.admin).toBe(adminEd);
  expect(c.text).toBe("GREEN18 open the gate");
  expect(c.nonce).toBeTruthy();
});

test("a non-admin signer is rejected", async () => {
  const { vega, vegaX } = await setup();
  const stranger = await generateIdentity();
  const blob = await makeCanary(stranger, KW, "GREEN18 open the gate", vegaX);
  expect(verifyCanary(vega, blob, () => null, KW, 120)).rejects.toThrow(VerificationError);
});

test("missing keyword (not the first token) is rejected", async () => {
  const { admin, vega, vegaX, allow } = await setup();
  const blob = await makeCanary(admin, KW, "please GREEN18 open", vegaX);
  expect(verifyCanary(vega, blob, allow, KW, 120)).rejects.toThrow(CanaryError);
});

test("a stale canary is rejected", async () => {
  const { admin, vega, vegaX, allow } = await setup();
  const issued = new Date("2026-06-17T00:00:00Z");
  const blob = await makeCanary(admin, KW, "GREEN18 open the gate", vegaX, issued);
  const later = new Date("2026-06-17T00:10:00Z"); // 10 min > 120s freshness
  expect(verifyCanary(vega, blob, allow, KW, 120, later)).rejects.toThrow(/stale/);
});

test("a canary sealed to vega cannot be opened by another node", async () => {
  const { admin, adminEd, vegaX } = await setup();
  const other = await generateIdentity();
  const blob = await makeCanary(admin, KW, "GREEN18 open the gate", vegaX);
  const allow = (ed: string) => (ed === adminEd ? admin.ed25519.publicKey : null);
  expect(verifyCanary(other, blob, allow, KW, 120)).rejects.toThrow(VerificationError);
});

test("the blob is opaque — the request text doesn't leak", async () => {
  const { admin, vegaX } = await setup();
  const blob = await makeCanary(admin, KW, "GREEN18 SECRET-INTENT", vegaX);
  expect(blob).not.toContain("SECRET-INTENT");
});

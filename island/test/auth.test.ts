import { expect, test } from "bun:test";
import { manageOk, operatorOk, tokenOk } from "../src/core/auth.ts";

test("tokenOk: exact match only; blanks never match", () => {
  expect(tokenOk("hunter2", "hunter2")).toBe(true);
  expect(tokenOk("nope", "hunter2")).toBe(false);
  expect(tokenOk("", "hunter2")).toBe(false);
  expect(tokenOk("hunter2", "")).toBe(false);
});

test("operatorOk: --mock allows anyone", () => {
  expect(operatorOk("203.0.113.9", "", { mock: true, opToken: "" })).toBe(true);
});

test("operatorOk: loopback is always the operator", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    expect(operatorOk(ip, "", { mock: false, opToken: "tok" })).toBe(true);
  }
});

test("operatorOk: a remote caller needs the op-token (headless management)", () => {
  const cfg = { mock: false, opToken: "tok" };
  expect(operatorOk("10.42.0.5", "tok", cfg)).toBe(true); // right token
  expect(operatorOk("10.42.0.5", "wrong", cfg)).toBe(false); // wrong token
  expect(operatorOk("10.42.0.5", "", cfg)).toBe(false); // no token
});

test("operatorOk: with no op-token configured, only loopback/mock get in", () => {
  const cfg = { mock: false, opToken: "" };
  expect(operatorOk("10.42.0.5", "anything", cfg)).toBe(false);
  expect(operatorOk("127.0.0.1", "", cfg)).toBe(true);
});

test("manageOk: the admin token also authorizes operator actions (admin ⊇ operator)", () => {
  const cfg = { mock: false, opToken: "op", adminToken: "adm" };
  // remote caller with the ADMIN token, no op-token -> allowed
  expect(manageOk("10.42.0.5", "", "adm", cfg)).toBe(true);
  // op-token alone still works
  expect(manageOk("10.42.0.5", "op", "", cfg)).toBe(true);
  // neither -> denied
  expect(manageOk("10.42.0.5", "", "", cfg)).toBe(false);
  // wrong admin token -> denied
  expect(manageOk("10.42.0.5", "", "nope", cfg)).toBe(false);
});

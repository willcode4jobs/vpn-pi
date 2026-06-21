import { expect, test } from "bun:test";
import { canonicalize } from "../src/core/canonical.ts";

// Golden vectors generated from CPython:
//   json.dumps(x, sort_keys=True, separators=(",", ":"))
// If these fail, signatures will NOT verify across the Python<->TS boundary.
test("matches Python json.dumps golden vectors", () => {
  expect(canonicalize({ node: "sirius", seq: 1, msg: "hi" })).toBe(
    '{"msg":"hi","node":"sirius","seq":1}',
  );
  expect(canonicalize({ b: true, a: null, z: [3, 2, 1], nested: { y: 2, x: 1 } })).toBe(
    '{"a":null,"b":true,"nested":{"x":1,"y":2},"z":[3,2,1]}',
  );
  // ensure_ascii: non-ASCII becomes \uXXXX
  expect(canonicalize({ unicode: "café—ü", ascii: "plain" })).toBe(
    '{"ascii":"plain","unicode":"caf\\u00e9\\u2014\\u00fc"}',
  );
});

test("escapes control chars and DEL exactly like Python", () => {
  expect(canonicalize("\x1f")).toBe('"\\u001f"');
  expect(canonicalize("\x7f")).toBe('"\\u007f"'); // DEL is escaped
  expect(canonicalize("\x80")).toBe('"\\u0080"');
  expect(canonicalize("\t")).toBe('"\\t"'); // short form
  expect(canonicalize("/")).toBe('"/"'); // slash NOT escaped
  expect(canonicalize('a"b\\c')).toBe('"a\\"b\\\\c"');
});

test("rejects non-integer numbers (no floats on the wire)", () => {
  expect(() => canonicalize(1.5)).toThrow();
});

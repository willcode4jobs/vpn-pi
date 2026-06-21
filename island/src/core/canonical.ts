// Canonical JSON — the exact bytes that get signed.
//
// MUST be byte-identical to Phase One's Python producer:
//   json.dumps(payload, sort_keys=True, separators=(",", ":"))
// with the default ensure_ascii=True. If these bytes differ by even one
// character, a signature made on one side won't verify on the other. The Python
// reference is gui-and-app/backend/app/ids_crypto.py (_canonical).
//
// Rules, matched to CPython's json encoder:
//   - object keys sorted (lexicographic by UTF-16 code unit, == Python's sort for
//     the str/int/ISO keys we use), separators "," and ":" with no whitespace.
//   - ensure_ascii: every code point < 0x20 OR >= 0x7f is \uXXXX-escaped
//     (lowercase hex); ", \, and the short escapes \b \t \n \f \r are escaped;
//     "/" is NOT escaped.
//   - numbers must be integers (no floats) so the round-trip is byte-stable.

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export function canonicalize(value: Json): string {
  return encode(value);
}

export function canonicalBytes(value: Json): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function encode(v: Json): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isInteger(v)) {
        throw new Error(`canonical: only integers allowed, got ${v}`);
      }
      return String(v);
    case "string":
      return encodeString(v);
    case "object":
      if (Array.isArray(v)) {
        return "[" + v.map(encode).join(",") + "]";
      }
      return (
        "{" +
        Object.keys(v)
          .sort()
          .map((k) => encodeString(k) + ":" + encode(v[k]!))
          .join(",") +
        "}"
      );
    default:
      throw new Error(`canonical: unsupported value of type ${typeof v}`);
  }
}

function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    switch (code) {
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += "\\\\";
        break;
      case 0x08:
        out += "\\b";
        break;
      case 0x09:
        out += "\\t";
        break;
      case 0x0a:
        out += "\\n";
        break;
      case 0x0c:
        out += "\\f";
        break;
      case 0x0d:
        out += "\\r";
        break;
      default:
        if (code < 0x20 || code >= 0x7f) {
          out += "\\u" + code.toString(16).padStart(4, "0");
        } else {
          out += s[i];
        }
    }
  }
  return out + '"';
}

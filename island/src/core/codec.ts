// Base64 (de)serialisation for raw key/byte material. ORIGINAL variant = standard
// base64 WITH padding and +/ alphabet — byte-identical to Python's
// base64.b64encode (Phase One stored keys this way), so keys and signatures
// round-trip across the two implementations.

import { getSodium } from "./sodium.ts";

export async function toB64(raw: Uint8Array): Promise<string> {
  const s = await getSodium();
  return s.to_base64(raw, s.base64_variants.ORIGINAL);
}

export async function fromB64(text: string): Promise<Uint8Array> {
  const s = await getSodium();
  return s.from_base64(text.trim(), s.base64_variants.ORIGINAL);
}

// libsodium init seam. libsodium-wrappers must be `await sodium.ready` before any
// call; every crypto module gets its handle through getSodium() so initialisation
// happens exactly once and callers never touch a half-ready library.
//
// This is the same primitive set Phase One used via PyNaCl (which wraps libsodium),
// so envelopes stay byte-compatible across the migration — see core/envelope.ts.
//
// Loaded via require() (CJS) on purpose: libsodium-wrappers' ESM build has a
// broken relative import (`./libsodium.mjs`, which actually lives in the separate
// `libsodium` package), so the `import` condition fails under Bun. The CJS entry
// resolves `libsodium` correctly. A literal require() (Bun supports it in ESM)
// also lets `bun build --compile` statically trace and embed the dep, so the
// single-binary build is self-contained. Full types kept via `typeof import(...)`.

const sodium: typeof import("libsodium-wrappers") = require("libsodium-wrappers");

let initialized = false;

export async function getSodium(): Promise<typeof sodium> {
  if (!initialized) {
    await sodium.ready;
    initialized = true;
  }
  return sodium;
}

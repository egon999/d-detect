/**
 * The published sealing keys.
 *
 * A seal carries a `keyId`; this is where that id resolves to the public key that checks the
 * signature. It is a plain compiled-in map rather than a fetched document, because the thing
 * it is used for is reading a bundle a stranger emailed you — possibly offline, certainly
 * without an account on this project. A verifier that had to call the server to learn which
 * keys to trust would be asking the signer's own infrastructure to vouch for the signer.
 *
 * ## This file is public, and that is the design
 *
 * Every value below ships inside the Android build and inside the verify page. A public key
 * is not a credential: it can check a signature and cannot make one. The private half is in
 * Secret Manager, reachable only by the `sealCase` function, and is not in this repository —
 * see `scripts/crucible-keygen.mjs` for the one path it travels.
 *
 * ## Append-only, forever
 *
 * Removing an entry does not retire a key. It breaks every seal that key ever made: the
 * signature is still correct and still on the record, but nothing left in the app can check
 * it, so a sealed case that verified last month reports `UNKNOWN_KEY` instead — the exact
 * reading a reader would get from a forgery. A retired key stays here so its past work keeps
 * standing; only `ACTIVE_SEAL_KEY_ID` moves.
 */

/** Key id → 64-hex Ed25519 public key. Add; never edit or remove. */
export const SEAL_PUBLIC_KEYS = {
  v1: '9e39891a4583e29931f12e255d81ac40d34ae525ec1b06de3d0f279b5b3ee582',
  dev1: '5fe94ed59df6e2e24a78fe3ba6e95abc9d7d54a3e308631dc2dcef4ac96d7751',
} as const satisfies Record<string, string>;

/** The ids this build can check. Widens by one on every rotation. */
export type SealKeyId = keyof typeof SEAL_PUBLIC_KEYS;

/**
 * Key ids whose private half is not held by a deployed server.
 *
 * `dev1` exists because the self-hosted `functions/local-server.js` runs the same `sealCase`
 * the Cloud Function does, reads its key from `functions/.env.local`, and — when a developer
 * is looking at the web build — runs on the very machine that produced the records. A seal it
 * makes is cryptographically indistinguishable from one a deployed server made with the same
 * key, which is exactly the problem: signing local records with the production key would
 * manufacture the one claim a seal is for, that the signature could not have come from here.
 *
 * So the development signer gets its own id, and the id is on every seal it makes. The copy
 * reads it and says what such a seal does and does not establish — see `sealNotice` in
 * `@features/crucible/seal-copy`. Distinguishing them in the registry rather than by
 * environment flag is deliberate: the flag is gone by the time a stranger opens the export,
 * and the key id travels with the seal.
 *
 * This is not a list of untrusted keys. A `dev1` signature is a correct signature; it simply
 * attests to less, and the difference is the reader's to know rather than ours to hide.
 */
export const DEVELOPMENT_SEAL_KEY_IDS: readonly string[] = ['dev1'];

/**
 * Whether a stored seal's key id belongs to a development signer.
 *
 * Takes a plain `string` for the same reason `sealPublicKey` does: the input is whatever a
 * seal claimed. An unrecognised id answers `false` — it is not a development key, and it is
 * not a published one either; `sealPublicKey` returning `null` is what reports that.
 */
export function isDevelopmentSealKey(keyId: string): boolean {
  return DEVELOPMENT_SEAL_KEY_IDS.includes(keyId);
}

/**
 * The key new seals are signed with.
 *
 * Read by the server, and by nothing else: a verifier must use the id on the seal it is
 * checking, never the current one, or rotating a key would invalidate the entire history.
 *
 * Typed as `SealKeyId` so that pointing this at an unpublished key is a compile error here
 * rather than a project that signs happily and verifies nothing.
 */
export const ACTIVE_SEAL_KEY_ID: SealKeyId = 'v1';

/**
 * The public key for a stored seal, or `null` if this build does not hold it.
 *
 * Takes a plain `string`, not a `SealKeyId`, because the input is whatever a stranger's
 * bundle claimed. `null` is a real answer and the caller must render it as one — an older app
 * meeting a seal made by a key added after it shipped is not looking at a forgery, it is
 * looking at something it cannot check. `verifySealedHistory` reports that case as
 * `UNKNOWN_KEY` and declines to count the seal, which is the only safe reading: unable to
 * verify is never evidence of authenticity, and never evidence of tampering either.
 */
export function sealPublicKey(keyId: string): string | null {
  return (SEAL_PUBLIC_KEYS as Record<string, string | undefined>)[keyId] ?? null;
}

/**
 * Generates the Crucible sealing key.
 *
 *   node scripts/crucible-keygen.mjs
 *
 * Produces one Ed25519 keypair and puts each half where it belongs: the public key printed
 * for `src/domain/crucible/keys.ts`, the private key written to a gitignored file for one
 * upload into Secret Manager.
 *
 * ## The private key never belongs anywhere else
 *
 * A seal's entire worth to a hostile reader is the claim *this could not have been produced
 * on the device that produced the record*. The key is what makes that claim true, so every
 * copy of it is somewhere that claim could have been manufactured. It is therefore never
 * printed to the terminal — scrollback and shell history are files, and neither is one
 * anybody audits — never committed, and never bundled into the app. The generated file is
 * meant to be uploaded once and then deleted from the machine.
 *
 * This is also why the script refuses to overwrite an existing key file rather than
 * regenerating helpfully. Replacing a key that has already signed something does not
 * invalidate those signatures — it orphans them: the seals stay on the records, the
 * verifier no longer holds the key that made them, and every sealed case in the project
 * starts reporting `UNKNOWN_KEY`. Rotation is an append: a new key id beside the old one in
 * the registry, with the old public key left in place forever so its seals keep verifying.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const SECRET_NAME = 'CRUCIBLE_SEAL_KEY';
const KEY_PATH = resolve(process.cwd(), 'crucible-seal.key');

// The key id is what a stored seal carries and what the verifier looks up, so it is chosen
// here rather than derived: a fingerprint of the public key would change if the same key
// were ever re-encoded, and a timestamp would tell a reader nothing they can act on.
const keyId = process.argv[2] ?? 'v1';

if (!/^[a-z0-9]{1,20}$/.test(keyId)) {
  console.error(`Refusing to use "${keyId}" as a key id: use lowercase letters and digits, e.g. v1.`);
  process.exit(1);
}

if (existsSync(KEY_PATH)) {
  console.error(
    [
      `A key already exists at ${KEY_PATH}.`,
      '',
      'Refusing to overwrite it. If that key has signed anything, replacing it does not',
      'invalidate those seals — it orphans them, and every sealed case starts reporting an',
      'unknown key. To rotate, move that file aside deliberately, run this with a new id',
      `(\`node scripts/crucible-keygen.mjs v2\`), and *add* the new public key to the`,
      'registry beside the old one rather than replacing it.',
    ].join('\n'),
  );
  process.exit(1);
}

const secretKey = ed25519.utils.randomSecretKey();
const publicKey = bytesToHex(ed25519.getPublicKey(secretKey));

// No trailing newline. Secret Manager stores bytes verbatim, so a newline here becomes part
// of the secret and the signer would reject it as a malformed key — fail-closed, but with a
// message pointing at the code rather than at this file. The server trims anyway.
writeFileSync(KEY_PATH, bytesToHex(secretKey), { encoding: 'utf8', mode: 0o600 });

console.log(
  [
    `Generated an Ed25519 sealing key with id "${keyId}".`,
    '',
    `1. Add the public key to src/domain/crucible/keys.ts:`,
    '',
    `     ${keyId}: '${publicKey}',`,
    '',
    '2. Upload the private key, once:',
    '',
    `     npx firebase functions:secrets:set ${SECRET_NAME} --data-file crucible-seal.key`,
    '',
    '3. Delete the local copy:',
    '',
    `     rm crucible-seal.key`,
    '',
    `The private key was written to ${KEY_PATH} and deliberately not printed. It is covered`,
    'by the `*.key` line in .gitignore; check that before committing anything.',
  ].join('\n'),
);

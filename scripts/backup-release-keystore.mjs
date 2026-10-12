import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const BACKUP = path.join(ROOT, '.keystore-backup');

const ITEMS = [
  { from: 'android/app/ddetect-release.jks', to: 'ddetect-release.jks' },
  { from: 'android/keystore.properties', to: 'keystore.properties' },
];

const digest = (filename) => createHash('sha256').update(readFileSync(filename)).digest('hex');

export function backupReleaseKeystore() {
  const missing = ITEMS.filter(({ from }) => !existsSync(path.join(ROOT, from))).map(({ from }) => from);
  if (missing.length > 0) {
    throw new Error(
      `Nothing to back up — these are already gone: ${missing.join(', ')}\n` +
        'If a prebuild has already run, this key may no longer exist anywhere on this machine.\n' +
        'Check the project owner\'s off-machine copy before building anything for release: an\n' +
        'APK signed with a new key cannot update any phone that already has this app.',
    );
  }

  mkdirSync(BACKUP, { recursive: true });
  const results = [];
  for (const { from, to } of ITEMS) {
    const source = path.join(ROOT, from);
    const target = path.join(BACKUP, to);

    if (existsSync(target) && digest(target) !== digest(source)) {
      throw new Error(
        `${path.join('.keystore-backup', to)} already exists and does not match ${from}.\n` +
          'One of these two signed the APK that users have installed. Work out which before\n' +
          'overwriting either — this script will not choose for you.',
      );
    }

    copyFileSync(source, target);

    if (digest(target) !== digest(source)) throw new Error(`The copy of ${from} failed verification.`);
    results.push({ to, bytes: statSync(target).size });
  }
  return results;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const results = backupReleaseKeystore();
    console.log('Release signing key backed up to .keystore-backup/ (gitignored):');
    for (const { to, bytes } of results) console.log(`  ${to}  ${bytes} B  verified`);
    console.log('\nThis survives `expo prebuild --clean`. It does not survive this machine.');
    console.log('Copy .keystore-backup/ somewhere off this computer — losing it means no');
    console.log('already-installed copy of D-Detect can ever be updated again.');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

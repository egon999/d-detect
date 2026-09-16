/**
 * Applies the Android security configuration to the checked-in native project.
 *
 * ## Why this script has to exist
 *
 * `plugins/with-android-security.js` is a config plugin, and config plugins run during
 * `expo prebuild`. This repository checks `android/` in and does not re-run prebuild, so the
 * plugin had never once executed against the tree that actually gets built. The effect was a
 * shipped APK with `android:allowBackup="true"` and no `networkSecurityConfig` at all, while
 * `app.json` declared `"allowBackup": false` and `tests/android-security.test.ts` passed —
 * because that test exercises the plugin's functions in isolation and says nothing about
 * whether anyone ever called them.
 *
 * On a phone holding someone else's bank statements, `allowBackup="true"` means the OS may
 * copy the app's private directory into a cloud backup or hand it to a vendor device-transfer
 * tool. That is the opposite of what this app promises, and it had been true of every build.
 *
 * ## Why it reuses the plugin rather than editing the manifest itself
 *
 * `secureManifest` and `writeSecurityResources` are the tested code. Hand-writing the same
 * five attributes here would mean two definitions of "secure" that drift apart, and the one
 * with the tests behind it would be the one not in use — which is the exact failure this
 * script is repairing. It imports the plugin and calls it against `android/` directly.
 *
 * Idempotent, and asserted to be so by the plugin's own test, so the build runs it every time
 * rather than asking anyone to remember.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const androidRoot = path.join(projectRoot, 'android');

const { AndroidConfig } = require('expo/config-plugins');
const { secureManifest, writeSecurityResources } = require(
  path.join(projectRoot, 'plugins/with-android-security.js'),
);

const MANIFEST = path.join(androidRoot, 'app/src/main/AndroidManifest.xml');

/** The attributes the plugin guarantees. Read back afterwards, so a silent no-op is caught. */
const EXPECTED = {
  'android:allowBackup': 'false',
  'android:usesCleartextTraffic': 'false',
  'android:networkSecurityConfig': '@xml/ddetect_network_security_config',
  'android:fullBackupContent': '@xml/ddetect_backup_rules',
  'android:dataExtractionRules': '@xml/ddetect_data_extraction_rules',
};

export async function applyAndroidSecurity() {
  const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(MANIFEST);
  secureManifest(manifest);
  await AndroidConfig.Manifest.writeAndroidManifestAsync(MANIFEST, manifest);
  await writeSecurityResources(androidRoot);

  // Read the file back rather than trusting the object that was just written. The whole
  // reason this script exists is that a security step can appear to be in place while having
  // no effect on the artifact, and a check against the in-memory value would repeat that.
  const written = await AndroidConfig.Manifest.readAndroidManifestAsync(MANIFEST);
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(written);
  const wrong = Object.entries(EXPECTED).filter(([key, value]) => application.$[key] !== value);
  if (wrong.length > 0) {
    throw new Error(
      `AndroidManifest.xml did not take the security attributes: ${wrong
        .map(([key, value]) => `${key} should be ${value}, found ${application.$[key] ?? 'nothing'}`)
        .join('; ')}`,
    );
  }
  return Object.keys(EXPECTED).length;
}

// Runnable on its own (`node scripts/apply-android-security.mjs`) as well as importable by the
// build. `process.argv[1]` is the invoked path, so this is false when imported.
if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  applyAndroidSecurity().then(
    (count) => {
      console.log(`Android security configuration applied (${count} manifest attributes, 3 resource files).`);
    },
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}

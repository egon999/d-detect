import fs from 'node:fs/promises';
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
const RELEASE_NETWORK_CONFIG = path.join(androidRoot, 'app/src/main/res/xml/ddetect_network_security_config.xml');

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

  const releaseConfig = await fs.readFile(RELEASE_NETWORK_CONFIG, 'utf8');
  if (/<base-config[^>]*cleartextTrafficPermitted\s*=\s*"true"/.test(releaseConfig)) {
    throw new Error(
      'The release network security config permits cleartext traffic in its base-config, which ' +
        'overrides android:usesCleartextTraffic="false". A dev-server exception belongs in ' +
        'android/app/src/debug/res/xml/, not in the main source set.',
    );
  }
  return Object.keys(EXPECTED).length;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  applyAndroidSecurity().then(
    (count) => {
      console.log(`Android security configuration applied (${count} manifest attributes, 4 resource files).`);
    },
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}

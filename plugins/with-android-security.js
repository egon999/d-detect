const fs = require('node:fs/promises');
const path = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

// The shipped server is HTTPS, so the release resource forbids cleartext outright. A
// base-config of `true` here would silently defeat `android:usesCleartextTraffic="false"`:
// when both are present the resource wins, so the manifest flag reads as a protection that
// is not actually in force. This exact mistake is what the previous version of this file
// shipped — every release APK accepted plain HTTP to anywhere, which lets anyone on the
const RELEASE_NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">localhost</domain>
    <domain includeSubdomains="true">127.0.0.1</domain>
    <domain includeSubdomains="true">10.0.2.2</domain>
    <domain includeSubdomains="true">10.0.3.2</domain>
  </domain-config>
</network-security-config>
`;

// Debug builds talk to a dev server on the developer's machine, reached either through
// `adb reverse` (localhost) or, on an emulator, the host-loopback alias 10.0.2.2 (or 10.0.3.2
// on Genymotion). The exception is scoped to those loopback hosts rather than opened globally.
const DEBUG_NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">localhost</domain>
    <domain includeSubdomains="true">127.0.0.1</domain>
    <domain includeSubdomains="true">10.0.2.2</domain>
    <domain includeSubdomains="true">10.0.3.2</domain>
  </domain-config>
</network-security-config>
`;

const BACKUP_DOMAINS = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'];
const exclusions = (indent) => BACKUP_DOMAINS.map((domain) => `${indent}<exclude domain="${domain}" path="." />`).join('\n');
const BACKUP_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
${exclusions('  ')}
</full-backup-content>
`;
// Android 12+ vendors can still transfer app data when allowBackup=false; exclude both paths.
const EXTRACTION_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup disableIfNoEncryptionCapabilities="true">
${exclusions('    ')}
  </cloud-backup>
  <device-transfer>
${exclusions('    ')}
  </device-transfer>
</data-extraction-rules>
`;

function secureManifest(manifest) {
  const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
  application.$['android:allowBackup'] = 'false';
  application.$['android:usesCleartextTraffic'] = 'false';
  application.$['android:networkSecurityConfig'] = '@xml/ddetect_network_security_config';
  application.$['android:fullBackupContent'] = '@xml/ddetect_backup_rules';
  application.$['android:dataExtractionRules'] = '@xml/ddetect_data_extraction_rules';
  return manifest;
}

async function writeSecurityResources(androidRoot) {
  const directory = path.join(androidRoot, 'app/src/main/res/xml');
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, 'ddetect_network_security_config.xml'), RELEASE_NETWORK_SECURITY_XML, 'utf8'),
    fs.writeFile(path.join(directory, 'ddetect_backup_rules.xml'), BACKUP_RULES_XML, 'utf8'),
    fs.writeFile(path.join(directory, 'ddetect_data_extraction_rules.xml'), EXTRACTION_RULES_XML, 'utf8'),
  ]);

  // Resources in a variant source set replace the main one of the same name, so a debug build
  // resolves `@xml/ddetect_network_security_config` to the file below while release keeps the
  // strict one. Granting the dev-server exception this way means it cannot leak into a release
  // APK by accident: there is no flag to forget to flip, because the permissive file is never
  // compiled into the release variant at all.
  const debugDirectory = path.join(androidRoot, 'app/src/debug/res/xml');
  await fs.mkdir(debugDirectory, { recursive: true });
  await fs.writeFile(path.join(debugDirectory, 'ddetect_network_security_config.xml'), DEBUG_NETWORK_SECURITY_XML, 'utf8');

  // Expo's debug templates set `usesCleartextTraffic="true"` with a `tools:replace` that
  // overrides the main manifest. Android ignores that attribute whenever a network security
  // config is present, so leaving it would not open a hole — but it would leave the manifest
  // asserting the opposite of the policy actually in force, which is how someone later
  // "simplifies" the config away and ships cleartext without noticing.
  for (const variant of ['debug', 'debugOptimized']) {
    const filename = path.join(androidRoot, 'app/src', variant, 'AndroidManifest.xml');
    try {
      await fs.access(filename);
      const manifest = await AndroidConfig.Manifest.readAndroidManifestAsync(filename);
      for (const application of manifest.manifest.application || []) {
        delete application.$['android:usesCleartextTraffic'];
        const replacements = (application.$['tools:replace'] || '').split(',').map((value) => value.trim()).filter((value) => value && value !== 'android:usesCleartextTraffic');
        if (replacements.length) application.$['tools:replace'] = replacements.join(',');
        else delete application.$['tools:replace'];
      }
      await AndroidConfig.Manifest.writeAndroidManifestAsync(filename, manifest);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function withAndroidSecurity(config) {
  config = withAndroidManifest(config, (mod) => { mod.modResults = secureManifest(mod.modResults); return mod; });
  return withDangerousMod(config, ['android', async (mod) => {
    await writeSecurityResources(mod.modRequest.platformProjectRoot);
    return mod;
  }]);
}

module.exports = withAndroidSecurity;
module.exports.secureManifest = secureManifest;
module.exports.writeSecurityResources = writeSecurityResources;

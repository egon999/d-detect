const fs = require('node:fs/promises');
const path = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

// ADB reverse keeps the API on the PC's loopback interface. No LAN/public HTTP exception.
const NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
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
    fs.writeFile(path.join(directory, 'ddetect_network_security_config.xml'), NETWORK_SECURITY_XML, 'utf8'),
    fs.writeFile(path.join(directory, 'ddetect_backup_rules.xml'), BACKUP_RULES_XML, 'utf8'),
    fs.writeFile(path.join(directory, 'ddetect_data_extraction_rules.xml'), EXTRACTION_RULES_XML, 'utf8'),
  ]);
  // Expo's debug templates otherwise override the main manifest with global cleartext.
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

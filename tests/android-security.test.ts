import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { parseStringPromise } = require('xml2js');
const { secureManifest, writeSecurityResources } = require('../plugins/with-android-security.js');
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('Android evidence data and transport boundaries', () => {
  it('disables backup and points the manifest at scoped security resources without changing identity', () => {
    const manifest = { manifest: { application: [{ $: { 'android:name': '.MainApplication', 'android:allowBackup': 'true', 'android:label': 'Ddetect' } }] } };
    secureManifest(manifest);
    const once = JSON.stringify(manifest);
    secureManifest(manifest);
    expect(JSON.stringify(manifest)).toBe(once);
    expect(manifest.manifest.application[0]!.$).toMatchObject({ 'android:allowBackup': 'false', 'android:usesCleartextTraffic': 'false', 'android:networkSecurityConfig': '@xml/ddetect_network_security_config', 'android:fullBackupContent': '@xml/ddetect_backup_rules', 'android:dataExtractionRules': '@xml/ddetect_data_extraction_rules', 'android:name': '.MainApplication', 'android:label': 'Ddetect' });
  });

  it('allows cleartext only for exact loopback names and excludes every backup domain on both Android formats', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ddetect-android-security-')); temporary.push(directory);
    await mkdir(join(directory, 'app/src/debug'), { recursive: true });
    await writeFile(join(directory, 'app/src/debug/AndroidManifest.xml'), '<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools"><application android:usesCleartextTraffic="true" tools:replace="android:usesCleartextTraffic,android:theme" android:theme="@style/AppTheme" /></manifest>');
    await writeSecurityResources(directory);
    const xml = async (file: string) => parseStringPromise(await readFile(join(directory, 'app/src/main/res/xml', file), 'utf8'));
    const network = (await xml('ddetect_network_security_config.xml'))['network-security-config'];
    expect(network['base-config'][0].$.cleartextTrafficPermitted).toBe('false');
    expect(network['domain-config']).toHaveLength(1);
    expect(network['domain-config'][0].$.cleartextTrafficPermitted).toBe('true');
    expect(network['domain-config'][0].domain).toEqual([{ _: 'localhost', $: { includeSubdomains: 'false' } }, { _: '127.0.0.1', $: { includeSubdomains: 'false' } }]);
    const domains = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'];
    const legacy = (await xml('ddetect_backup_rules.xml'))['full-backup-content'];
    const current = (await xml('ddetect_data_extraction_rules.xml'))['data-extraction-rules'];
    for (const rules of [legacy, current['cloud-backup'][0], current['device-transfer'][0]]) {
      expect(rules.include).toBeUndefined();
      expect(rules.exclude.map((item: { $: { domain: string } }) => item.$.domain).sort()).toEqual([...domains].sort());
      expect(rules.exclude.every((item: { $: { path: string } }) => item.$.path === '.')).toBe(true);
    }
    const debug = await parseStringPromise(await readFile(join(directory, 'app/src/debug/AndroidManifest.xml'), 'utf8'));
    expect(debug.manifest.application[0].$['android:usesCleartextTraffic']).toBeUndefined();
    expect(debug.manifest.application[0].$['tools:replace']).toBe('android:theme');
  });
});

/**
 * The two tests above prove the plugin does the right thing when it runs. For most of this
 * project's life it did not run at all: config plugins execute during `expo prebuild`,
 * `android/` is checked in, and prebuild is never re-run — so every release APK shipped with
 * `android:allowBackup="true"` and no network security config while these tests passed. On a
 * phone holding someone else's bank statements that meant the OS was free to copy the app's
 * private directory into a cloud backup.
 *
 * These assertions are about the tree that Gradle actually compiles. `npm run apk` applies the
 * configuration on every build and reads it back out of the packaged APK, but that is the last
 * line of defence; failing here costs seconds instead of a full Gradle run.
 */
describe('the checked-in Android project', () => {
  const android = (...parts: string[]) => join(__dirname, '..', 'android', ...parts);

  it('carries the security attributes Gradle will compile', async () => {
    const manifest = await parseStringPromise(await readFile(android('app/src/main/AndroidManifest.xml'), 'utf8'));
    expect(manifest.manifest.application[0].$).toMatchObject({ 'android:allowBackup': 'false', 'android:usesCleartextTraffic': 'false', 'android:networkSecurityConfig': '@xml/ddetect_network_security_config', 'android:fullBackupContent': '@xml/ddetect_backup_rules', 'android:dataExtractionRules': '@xml/ddetect_data_extraction_rules' });
  });

  it('has the resources those attributes name', async () => {
    // A manifest referring to a missing `@xml/...` fails at build time, but only for resources
    // the merger resolves strictly; a typo that happens to match a library resource would not.
    for (const file of ['ddetect_network_security_config.xml', 'ddetect_backup_rules.xml', 'ddetect_data_extraction_rules.xml']) {
      expect(await readFile(android('app/src/main/res/xml', file), 'utf8')).toContain('<?xml');
    }
  });

  it('does not let a debug variant hand back blanket cleartext', async () => {
    // Expo's debug template sets `usesCleartextTraffic="true"` with a `tools:replace`, which wins
    // the merge and undoes the main manifest. Metro still works: the network security config
    // permits loopback, which is where `adb reverse` puts it.
    for (const variant of ['debug', 'debugOptimized']) {
      const source = await readFile(android('app/src', variant, 'AndroidManifest.xml'), 'utf8').catch(() => null);
      if (source === null) continue;
      expect(source).not.toContain('android:usesCleartextTraffic');
    }
  });
});

/**
 * Release APK build, with the checks that make the result trustworthy.
 *
 *   npm run apk
 *
 * ## Why this is a script and not a Gradle invocation in a README
 *
 * Three things went wrong repeatedly when this was done by hand, and each one produces an
 * APK that looks finished:
 *
 * 1. **Building over a broken tree.** Metro bundles whatever TypeScript is there; type
 *    errors do not stop it. You get an APK that installs and crashes on the screen the
 *    error was on. So `tsc --noEmit` and the test suite run first and a failure stops the
 *    build — there is no flag here to skip them.
 * 2. **Shipping the debug key.** The React Native template signs release builds with the
 *    debug keystore, whose password is 'android' and which ships with the SDK. The APK
 *    installs, so nothing tells you. This script reads the signing certificate back out of
 *    the finished APK and fails if it is the debug one.
 * 3. **Reporting a path that is stale.** A failed build leaves the previous APK sitting in
 *    `outputs/`, and quoting it reads as success. The output is deleted before the build,
 *    and its timestamp is checked after.
 * 4. **Shipping without the security configuration.** `plugins/with-android-security.js`
 *    only runs during `expo prebuild`, and `android/` is checked in, so every build before
 *    this line was added shipped `allowBackup="true"` and no network security config — while
 *    `app.json` said otherwise and the plugin's unit tests passed. The configuration is now
 *    applied on every build, and read back out of the finished APK's manifest.
 *
 * Nothing here prints a result it did not read off disk.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const ANDROID = resolve(ROOT, 'android');
const APK = resolve(ANDROID, 'app/build/outputs/apk/release/app-release.apk');

/** From app.json, which is what the native project is generated from. */
const APP_PACKAGE = JSON.parse(readFileSync(resolve(ROOT, 'app.json'), 'utf8')).expo?.android?.package ?? '';

/** The stock debug certificate's SHA-256, as apksigner prints it (no separators). */
const DEBUG_CERT_SHA256 = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';

/**
 * Java for the Android toolchain.
 *
 * `JAVA_HOME` on a developer machine routinely points at a JDK that has since been
 * uninstalled — apksigner then fails with "invalid directory" and nothing else. Gradle
 * downloads its own JDK under ~/.gradle/jdks for exactly this reason, so prefer whatever
 * Gradle is already using and only fall back to the environment.
 */
function javaHome() {
  const gradleJdks = resolve(process.env.USERPROFILE ?? process.env.HOME ?? '', '.gradle/jdks');
  if (existsSync(gradleJdks)) {
    const jdk17 = readdirSync(gradleJdks)
      .filter((name) => /-17-/.test(name))
      .map((name) => resolve(gradleJdks, name))
      .find((path) => existsSync(resolve(path, 'bin/java.exe')) || existsSync(resolve(path, 'bin/java')));
    if (jdk17) return jdk17;
  }
  const fromEnv = process.env.JAVA_HOME;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return null;
}

const JAVA_HOME = javaHome();
const ENV = JAVA_HOME ? { ...process.env, JAVA_HOME } : process.env;

function heading(text) {
  console.log(`\n=== ${text} ===`);
}

/** Runs a command, streaming its output, and throws with a readable message on failure. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: ENV,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'a signal'}`);
  }
}

/** Run the signer JAR without a shell so workspace paths with spaces stay intact. */
function apksignerPath() {
  return buildToolsFile('lib/apksigner.jar');
}

/** aapt2, for reading the manifest back out of the packaged APK. */
function aapt2Path() {
  return buildToolsFile(process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
}

/**
 * Finds a file inside the newest installed build-tools.
 *
 * Versions are sorted numerically per component, so 36.1.0 beats 36.0.0 and 9.0.0 does not
 * beat 36.0.0 — which a plain string sort gets wrong.
 */
function buildToolsFile(relative) {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? sdkFromLocalProperties();
  if (!sdk) return null;
  const buildTools = resolve(sdk, 'build-tools');
  if (!existsSync(buildTools)) return null;

  const versions = readdirSync(buildTools)
    .filter((name) => /^\d/.test(name))
    .sort((a, b) => {
      const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
      const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      }
      return 0;
    });

  for (const version of versions) {
    const candidate = resolve(buildTools, version, relative);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sdkFromLocalProperties() {
  const path = resolve(ANDROID, 'local.properties');
  if (!existsSync(path)) return null;
  // `sdk.dir` is written with Java-properties escaping: C\:\\Users\\...
  const match = /^sdk\.dir=(.+)$/m.exec(readFileSync(path, 'utf8'));
  return match ? match[1].replace(/\\:/g, ':').replace(/\\\\/g, '\\').trim() : null;
}

/**
 * Reads the signing certificate out of the built APK.
 *
 * Deliberately done by inspecting the artifact rather than by trusting the Gradle config:
 * the question is what was actually signed, and a config can be right while a stale build
 * directory hands back something signed earlier.
 */
function assertNotDebugSigned() {
  const apksigner = apksignerPath();
  if (!apksigner) {
    throw new Error(
      'apksigner was not found in the Android SDK build-tools, so the signature could not be verified.\n' +
        'Set ANDROID_HOME, or install build-tools through the SDK manager.',
    );
  }

  const java = JAVA_HOME ? resolve(JAVA_HOME, process.platform === 'win32' ? 'bin/java.exe' : 'bin/java') : 'java';
  const output = execFileSync(java, ['-jar', apksigner, 'verify', '--print-certs', APK], {
    encoding: 'utf8',
    shell: false,
    env: ENV,
  });

  // apksigner labels each signature scheme separately ("V2 Signer: certificate DN: ...").
  const sha256 = /certificate SHA-256 digest:\s*([0-9a-f]+)/i.exec(output)?.[1]?.toLowerCase() ?? '';
  const sha1 = /certificate SHA-1 digest:\s*([0-9a-f]+)/i.exec(output)?.[1]?.toLowerCase() ?? '';
  const subject = /certificate DN:\s*(.+)/i.exec(output)?.[1]?.trim() ?? 'unknown';

  if (/CN=Android Debug/i.test(subject) || sha256 === DEBUG_CERT_SHA256) {
    throw new Error(
      'The APK is signed with the Android debug key.\n' +
        'android/keystore.properties is missing or was not picked up — restore it from .keystore-backup/.',
    );
  }

  return { subject, sha1, sha256 };
}

/**
 * Checks that Google will recognise the certificate this APK is signed with.
 *
 * Google Sign-In authenticates the *app* by the SHA-1 of its signing certificate, which has to
 * be registered against the Android OAuth client in the Firebase console. Nothing in the build
 * enforces that, and the failure has an unusually bad shape: debug builds are signed with the
 * debug key, which is normally the fingerprint someone registers first, so sign-in works
 * throughout development and then fails on the installed release APK — as `DEVELOPER_ERROR`,
 * a code that names nothing. `src/services/auth/google.ts` catches it and steers the user to
 * email sign-in, so the app stays usable, but the Google button silently stops being real.
 *
 * A warning rather than a failure. The fix is a console setting and a re-downloaded
 * `google-services.json`, neither of which a build can do, and refusing to produce an APK over
 * it would withhold a working app to protest one broken button.
 */
function checkSigningFingerprintRegistered(sha1) {
  const configPath = resolve(ANDROID, 'app/google-services.json');
  if (!existsSync(configPath) || !sha1) return null;

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const app = APP_PACKAGE
    ? config.client?.find((entry) => entry.client_info?.android_client_info?.package_name === APP_PACKAGE)
    : undefined;
  if (!app) return null;

  // Only a type-1 (Android) client carries a certificate. Type 3 is the web client, which is
  // the token audience and has no fingerprint of its own.
  const registered = (app.oauth_client ?? [])
    .filter((client) => client.client_type === 1)
    .map((client) => client.android_info?.certificate_hash?.toLowerCase())
    .filter(Boolean);

  if (registered.includes(sha1)) return null;

  const grouped = sha1.toUpperCase().match(/.{2}/g)?.join(':') ?? sha1;
  return (
    'Google Sign-In will fail in this APK with DEVELOPER_ERROR.\n' +
    `  This APK is signed with SHA-1  ${grouped}\n` +
    `  google-services.json registers ${registered.length > 0 ? registered.map((hash) => hash.toUpperCase().match(/.{2}/g).join(':')).join('\n' + ' '.repeat(33)) : '(no Android client)'}\n` +
    '  Add the first fingerprint in the Firebase console under Project settings -> Your apps ->\n' +
    `  ${APP_PACKAGE} -> Add fingerprint, then download google-services.json again and replace\n` +
    '  both android/app/google-services.json and the copy in the project root.\n' +
    '  Until then the Google button reports that sign-in could not be completed and offers\n' +
    '  email and password, which does work. Everything else in the app is unaffected.'
  );
}

/**
 * The application attributes the security configuration is responsible for.
 *
 * `false` means the attribute must read exactly that. `'reference'` means it must point at a
 * resource — aapt2 prints resolved references as ids (`@0x7f160008`), so the name the source
 * manifest used is not recoverable here and presence is the strongest available claim. It is
 * still the claim that matters: the regression this guards against was total absence.
 */
const REQUIRED_MANIFEST = {
  allowBackup: 'false',
  usesCleartextTraffic: 'false',
  networkSecurityConfig: 'reference',
  fullBackupContent: 'reference',
  dataExtractionRules: 'reference',
};

/**
 * Reads the security configuration back out of the packaged APK.
 *
 * Against the APK rather than `android/app/src/main/AndroidManifest.xml`, for the same reason
 * the signature is: the source manifest is an input, and what ships is the *merged* manifest —
 * every library's manifest folded in, each of which can contribute an `android:allowBackup`
 * and win. Checking the input would have passed happily on the builds that shipped without
 * any of this, because `app.json` had been correct all along.
 */
function assertManifestSecured() {
  const aapt2 = aapt2Path();
  if (!aapt2) {
    throw new Error(
      'aapt2 was not found in the Android SDK build-tools, so the shipped manifest could not be verified.\n' +
        'Set ANDROID_HOME, or install build-tools through the SDK manager.',
    );
  }

  const tree = execFileSync(aapt2, ['dump', 'xmltree', APK, '--file', 'AndroidManifest.xml'], {
    encoding: 'utf8',
    shell: false,
    env: ENV,
    maxBuffer: 32 * 1024 * 1024,
  });

  // Attributes of `<application>` are the `A:` lines between it and the next element.
  const lines = tree.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*E: application\b/.test(line));
  if (start === -1) throw new Error('The packaged manifest has no <application> element.');
  const attributes = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*E: /.test(lines[i])) break;
    if (/^\s*A: /.test(lines[i])) attributes.push(lines[i]);
  }
  const block = attributes.join('\n');

  const wrong = [];
  for (const [name, expected] of Object.entries(REQUIRED_MANIFEST)) {
    const found = new RegExp(`android:${name}\\(0x[0-9a-f]+\\)=(\\S+)`).exec(block)?.[1];
    if (found === undefined) wrong.push(`${name} is absent`);
    else if (expected === 'reference' && !found.startsWith('@')) wrong.push(`${name} is ${found}, not a resource`);
    else if (expected !== 'reference' && found !== expected) wrong.push(`${name} is ${found}, not ${expected}`);
  }
  if (wrong.length > 0) {
    throw new Error(
      `The APK shipped without its security configuration: ${wrong.join('; ')}.\n` +
        'Run `node scripts/apply-android-security.mjs`, and check whether a dependency\'s manifest is\n' +
        'overriding the application element during merge.',
    );
  }

  return Object.keys(REQUIRED_MANIFEST).length;
}

function main() {
  heading('Typecheck');
  run('npx', ['tsc', '--noEmit'], { cwd: ROOT });

  heading('Tests');
  run('npx', ['vitest', 'run'], { cwd: ROOT });

  heading('Signing configuration');
  if (!existsSync(resolve(ANDROID, 'keystore.properties'))) {
    throw new Error(
      'android/keystore.properties is missing, so this would produce a debug-signed APK.\n' +
        'Copy it and ddetect-release.jks back from .keystore-backup/, or run `npx expo prebuild`.',
    );
  }
  console.log('android/keystore.properties present.');

  heading('Security configuration');
  // Idempotent, and run unconditionally: the point is that nobody has to remember it.
  run('node', ['scripts/apply-android-security.mjs'], { cwd: ROOT });

  // Preserve previous bytes before removing the default output used to detect stale builds.
  if (existsSync(APK)) {
    const archive = resolve(ROOT, 'artifacts/android/archive');
    mkdirSync(archive, { recursive: true });
    const previous = resolve(archive, `app-release-before-${Date.now()}.apk`);
    copyFileSync(APK, previous);
    const digest = (filename) => createHash('sha256').update(readFileSync(filename)).digest('hex');
    if (digest(APK) !== digest(previous)) throw new Error('The previous APK backup failed checksum verification.');
    console.log(`Previous APK preserved: ${previous}`);
    rmSync(APK);
  }

  heading('Gradle assembleRelease');
  const buildStartedAt = Date.now();
  // `.\gradlew.bat`, not `gradlew.bat`. `spawnSync` runs this through `cmd.exe` (shell: true
  // on Windows), and cmd does not search the current directory for a bare command name — it
  // reports "'gradlew.bat' is not recognized" and exits 1 before Gradle ever starts. The
  // explicit relative path is what makes cmd run the script sitting right next to it.
  const gradlew = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  run(gradlew, ['assembleRelease', '--no-daemon'], { cwd: ANDROID });

  if (!existsSync(APK)) throw new Error('Gradle reported success but no APK was written.');
  if (statSync(APK).mtimeMs < buildStartedAt - 2000) throw new Error('The APK timestamp predates this build.');

  heading('Signature');
  const { subject, sha1, sha256 } = assertNotDebugSigned();
  console.log(`Signed by:  ${subject}`);
  console.log(`Certificate SHA-256: ${sha256}`);

  heading('Packaged manifest');
  console.log(`Security attributes verified in the APK: ${assertManifestSecured()}.`);

  const { size, mtime } = statSync(APK);
  heading('Done');
  console.log(`APK:   ${APK}`);
  console.log(`Size:  ${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Built: ${mtime.toISOString()}`);
  console.log(`APK SHA-256: ${createHash('sha256').update(readFileSync(APK)).digest('hex')}`);

  // Last, so it is the thing still on screen. A warning printed before a wall of Gradle output
  // is a warning nobody reads.
  const unregistered = checkSigningFingerprintRegistered(sha1);
  if (unregistered) {
    heading('Warning');
    console.log(unregistered);
  }
}

/**
 * The two artifact inspections are exported so they can be run against an APK that is already
 * on disk, without a Gradle run:
 *
 *     node -e "import('./scripts/build-apk.mjs').then(m => console.log(m.assertManifestSecured()))"
 *
 * `main` is guarded rather than called at import time, which is what makes that possible.
 * `npm run apk` is unaffected: it invokes this file directly, so `argv[1]` is this file.
 */
export { assertManifestSecured, assertNotDebugSigned, checkSigningFingerprintRegistered };

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`\nBuild failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

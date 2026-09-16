# Development and verification

## Prerequisites

Use Node 22 and npm. The client uses Expo SDK 55 and React Native 0.83. Read the versioned Expo documentation before changing native APIs: https://docs.expo.dev/versions/v55.0.0/.

Install client and backend dependencies from their lockfiles:

    npm ci
    npm --prefix functions ci

### The expo-asset pin in package.json

package.json holds an `overrides` block pinning `expo-asset` to `~55.0.20`. Do not remove it, and do
not let a dependency bump quietly drop it.

`expo-asset` is not a direct dependency of this app; it arrives through other packages.
`expo@55` wants 55.0.20, while `expo-audio@55.0.18` asks for `expo-asset@57`. Without the override,
npm hoists the 57 copy to the top of node_modules and leaves the correct 55 copy nested under
node_modules/expo. Android autolinking reads the hoisted one, so the release APK ships expo-asset 57
against expo-modules-core 55. Version 57 of that module resolves
`expo.modules.kotlin.types.AnyTypeCache`, a class that does not exist in core 55, so
`AssetModule.definition` throws `NoClassDefFoundError` while the module registry is being built.
That happens before any JavaScript runs, which means the app dies on the splash screen and no
JavaScript error boundary can catch it.

Two things make this easy to reintroduce. `npx expo install --check` reports "Dependencies are up to
date" because it only inspects declared dependencies and expo-asset is not one. And package.json
cannot carry comments, so the override looks like clutter someone can tidy away. After changing any
Expo package, confirm the resolution held:

    npm ls expo-asset

Every entry, hoisted and nested, must read 55.x.

## Configuration

Root .env contains public client configuration only: the Firebase application identifiers, Google web client ID, and EXPO_PUBLIC_API_BASE_URL. For the browser on this computer, the local API address is http://127.0.0.1:8787.

The provider credential belongs in the ignored functions/.env.local as GROQ_API_KEY. Optional server values include FIREBASE_PROJECT_ID, GROQ_TEXT_MODEL, API_HOST, PORT, DATA_DIRECTORY and WEB_ORIGINS. The backend loads that file on startup; restart it after changing values. Never copy the key into an EXPO_PUBLIC variable, frontend settings, a screenshot or test fixture. Image/PDF OCR uses local Tesseract.js English and Hindi language data, downloaded on first use and cached in functions/.cache/ocr; first-use download failure is surfaced as a processing failure.

The Firebase project must have the intended sign-in methods enabled. Browser origins must be authorized in Firebase Authentication. Android Google Sign-In also requires the real package name, registered signing-certificate fingerprint and web OAuth client ID. Native Google sign-in requires a development/native build; a browser smoke test does not validate an Android APK.

## Run the actual application

Use separate terminals or supervised local processes:

    npm --prefix functions run local
    npm run web

The backend local/start scripts build the shared deterministic domain extractor before launching. If launching node functions/local-server.js directly, first run npm --prefix functions run build. Restart a previously running server after changing backend source; a passing build does not reload that process.

The API health endpoint is GET http://127.0.0.1:8787/health. It confirms the process is available, not that authentication, extraction or AI access succeeds. Protected routes require a real Firebase ID token.

The current Android release uses this PC's local backend through USB. Keep the server bound to loopback and EXPO_PUBLIC_API_BASE_URL=http://localhost:8787. A native build also requires EXPO_PUBLIC_API_ALLOW_LOOPBACK=1: on a phone `localhost` is the phone, so src/services/api-client.ts discards a loopback address unless the build states that it is tethered. Without that flag the APK ignores the address and silently falls back to the device-local adapter, which is indistinguishable from the backend being down. The flag must be exactly `1`, and it permits only a loopback host — cleartext to a public host stays rejected. Connect an authorized Android device with USB debugging enabled, then run the following on this PC:

    adb reverse tcp:8787 tcp:8787

If adb is not on PATH on Windows, use & "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe" reverse tcp:8787 tcp:8787 from PowerShell.

The reverse tunnel makes the phone's localhost:8787 reach this PC's localhost:8787 without exposing the backend to the LAN. Keep the PC awake, backend running and USB connection present. Firebase sign-in and backend Groq requests still need an internet connection. Reconnect the reverse tunnel after device/ADB restarts. This is not an independent cloud service or an APK that performs all processing on the phone.

plugins/with-android-security.js denies cleartext by default and permits only the exact localhost and 127.0.0.1 names; it does not permit LAN HTTP or disable TLS validation. Public deployments need a real HTTPS endpoint and a new client configuration/build. The same plugin sets allowBackup=false and excludes app storage from legacy backups plus Android 12+ cloud/device transfer. Uninstalling the app can therefore lose its offline workspace and device preferences; the PC backend is backed up separately.

For a native development build (not required to run the release APK):

    npm run android

Changes to public environment values or native configuration can require an Expo restart or native rebuild. Do not treat a stale installed APK as evidence that newly changed source was exercised.

## Local signed Android artifact

Keep .keystore-backup and android/keystore.properties private. Regenerate native configuration without --clean to preserve the current generated tree, then use the checked build entry point:

    npx expo prebuild --platform android --no-install
    npm run apk

The APK command runs typecheck and tests, preserves the previous APK in artifacts/android/archive with a checksum check, removes the default output, assembles the release and verifies its signature/fresh timestamp. The signer runs through Java directly so workspace paths containing spaces work on Windows. The generated artifact path is android/app/build/outputs/apk/release/app-release.apk. Certificate fingerprints identify the signing key; a file SHA-256 identifies the exact APK bytes and is reported separately. A successful signed build does not validate Google account authorization, device networking, screen rendering or user journeys on a physical phone.

## Test commands

    npm run typecheck
    npm test
    npm --prefix functions test
    npm --prefix functions run build

Targeted examples:

    npm test -- tests/account-profile.test.ts tests/search-index.test.ts
    npm test -- tests/remote-repository.test.ts
    npm --prefix functions test

Test output is the evidence for a particular run; this guide does not embed a permanently claimed pass count.

## End-to-end verification

Use a clearly identified test case and your own non-sensitive fixture files. Verify the rendered UI and inspect backend persistence, not merely component code.

1. Sign in, inspect provider/name/photo, and refresh.
2. Create a case with a claim and custom category; confirm that reload preserves it.
3. Upload an original, wait for the actual extraction state, open the stored file and source text.
4. Run case analysis, inspect exact citations and missing information, navigate away and return.
5. Inspect graph links and search for text occurring only inside the evidence.
6. Edit the profile, inspect real case history, clear recent search queries and verify they stay cleared.
7. Test invalid files, missing claims, no evidence, unavailable provider, interrupted request and retry.
8. Verify another account cannot read, modify or download the first account's records.
9. Inspect narrow Android layout, keyboard behavior, back navigation, accessible labels and large text.
10. Review previous cloud cases, import only a missing test case, verify old records remain unchanged and originals require re-upload, then retry to confirm no overwrite.
11. Export a saved assessment and inspect citations, stale/incomplete warnings, HTML escaping and original-file separation in the actual print/PDF result.

Do not modify a real account password or send a reset email solely to perform an automated smoke test. Those actions need a dedicated authorized test account.

## Persistence and recovery

The default local store is functions/.data/database.json and its originals directory. Stop the backend before taking a consistent manual copy of both. Restore them together. The current store serializes transactions and renames a pending JSON file; it is not a multi-process database. A corrupt store causes startup to fail rather than silently resetting real cases.

Do not run two server instances against the same data directory. A public service needs scheduled backup/restore exercises, storage monitoring and graceful process supervision before deployment.

Previous Firestore data is not automatically migrated when the remote API is configured. Profile → Previous cloud cases provides an explicit review/import workflow under the same Firebase account. Cases already present cannot be overwritten. Old source text is recovered as unverified notes, while old originals and AI reports remain in the historical workspace. Imports above 400 records are rejected before writing; read-only review still works. If legacy Firestore rules deny these reads, restore the intended owner-scoped access rather than bypassing authentication or making the collection public.

## Security rules

`rules/firestore.rules` is the only boundary between one account's evidence and another's.
The Firebase web config shipped in the APK is a public project identifier, so anyone can
authenticate as themselves and talk to the project directly; the ownership checks in
`src/data/repository.ts` run on that caller's device and protect nothing. The rules are
what protect it, and they are only actually verified when Firestore evaluates them:

    npx firebase emulators:start --only firestore --project ddetect-rules-test
    npx vitest run tests/firestore-rules.test.ts

**That needs a JDK 21 or newer on PATH.** firebase-tools 15 refuses to start the emulator on
anything older, with `firebase-tools no longer supports Java version before Java 21`. The
JDK Gradle downloads for the Android build (`~/.gradle/jdks/eclipse_adoptium-17-…`) is 17
and will not do, so a machine that builds the APK successfully can still be unable to run
these tests — and `JAVA_HOME` pointing at a JDK that was uninstalled looks identical to
having one. Check with `java -version`, not with `JAVA_HOME`.

Without the emulator that file skips every case, prints why, and the suite stays green.
That is deliberate, but a skipped security test proves nothing. `tests/firestore-rules-shape.test.ts`
is the companion that always runs: it reads the rules as text and checks the mechanical,
high-consequence properties that can be checked that way — every collection is deletable by
its owner, no rule grants `write` (which silently refuses every delete), no helper resolves
a document while authorising a write, and the append-only collections permit no edit.

Do not deploy rules as a way of testing them.

## Optional Firebase infrastructure

functions/index.js and rules/ are retained for the Firebase deployment alternative. Deploying Cloud Functions requires the Blaze billing plan. It is not necessary for the active local-server workflow and is not implicitly authorized by a local repair. Emulator testing does not count as deployment or a live cloud verification.

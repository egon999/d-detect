# Security

Every claim below was checked against this tree on 2026-09-17. Where a control a reader would
reasonably expect is missing, this document says so rather than leaving it out. Nothing here is a
legal claim, and nothing here has been reviewed by anyone outside the project.

## What the app is

Ddetect is an Expo / React Native app with **no server of its own** (`src/services/ai/credentials.ts:4`,
`src/services/storage/evidence-storage.ts:6`). There is no backend process to compromise and no
operator holding user data or credentials.

- **Evidence bytes stay on the device**, in the app's private directory
  (`src/services/storage/evidence-storage.ts:17-25`, written by `uploadEvidenceFile` at `:222`).
  They are not uploaded.
- **Records** — cases, claims, extracted text, audit entries — go to Firestore when signed in, or
  to AsyncStorage on the device when not (`src/services/repository-provider.tsx:90-158`).
- **The Firebase project is on the Spark (free) plan.** No Cloud Functions are deployed;
  `FIREBASE_SEAL_CALLABLE_DEPLOYED` is a compiled-in `false` (`src/services/crucible/request-seal.ts:104`).
  Firebase Storage is not used — `firebase/storage` is imported nowhere in `src/` or `app/`, and
  `rules/storage.rules` is configuration for a product this app never calls.
- **The hand-written platform API is unreachable.** `EXPO_PUBLIC_API_BASE_URL` is empty (`.env:80`),
  so `apiBaseUrl()` returns `null` and the `remote` adapter is never selected. Everything under
  `functions/` — the Node server, its Groq handling, its upload, quota and connection limits — is
  outside the running path. Earlier versions of this document described those controls as if they
  protected users. They do not, because nothing reaches them.

## The boundary that actually matters

`rules/firestore.rules` is the only enforced boundary between one account's evidence and another's.

The Firebase web config ships inside the APK (`app.json:82-89`) and is a public project identifier,
so anyone can authenticate against the project and talk to it with their own client. The
`assertOwnership` check in `src/data/repository.ts:314` runs on the caller's own device; its
docblock says plainly that it "cannot replace" the rules and is "advice, not enforcement" (`:309-312`).

Read as text, the rules say:

- Every document carries `ownerId`; read, update and delete require it to equal the caller's uid
  (`ownsExisting()`, `rules/firestore.rules:76`).
- `ownerId` cannot be reassigned on update (`ownerUnchanged()`, `:94`).
- No collection grants `allow write`. That matters: `write` covers delete, and every predicate here
  reads `request.resource`, which is null on a delete — so `allow write` would grant create and
  update while silently refusing every delete. Create, update and delete are granted separately.
- Collections that record what happened — `auditLogs`, `processingJobs`, `caseAnalyses` — permit an
  update only when the incoming document is byte-identical to the stored one (`unchanged()`, `:171`).
- No client may create or update a seal (`:588`).
- Unmatched paths are denied (`:606`).

### These rules are not being executed anywhere

`tests/firestore-rules.test.ts` is the suite that runs them against the Firestore emulator. The
emulator needs **JDK 21 or newer** — `firebase-tools@15` refuses to start on anything older — and
**no JDK is installed on this machine at all.** `JAVA_HOME` names
`C:\Program Files\Eclipse Adoptium\jdk-21.0.8.9-hotspot`, which does not exist; there is no
`Eclipse Adoptium` directory, and `java` is not on `PATH`. The only JDK present is the 17 Gradle
downloads for the Android build, which does not qualify. Check with `java -version`, never with
`JAVA_HOME`.

So every case in that file skips and the suite still reports success:

    $ npx vitest run tests/firestore-rules.test.ts tests/firestore-rules-shape.test.ts
    Test Files  1 passed | 1 skipped (2)
         Tests  9 passed | 58 skipped (67)

**A skipped security test proves nothing.** Fifty-eight assertions about the only boundary in this
product are currently not being made, and the green result says nothing about them.

`tests/firestore-rules-shape.test.ts` is the companion that always runs. It reads the rules as text
and checks the mechanical properties listed above — a delete rule for every stored collection, no
`allow write`, no document resolution while authorising a write, no client-created seal, a
catch-all deny. Those nine checks are real and they caught real defects, but they describe the
file's shape. They cannot tell you the policy is correct; only Firestore evaluating it can.

There is no CI in this repository (no `.github/workflows`), so nothing runs the emulator on any
machine, ever.

## What leaves the device

- **Text and audio sent for analysis.** Model calls go from the handset straight to
  `https://api.groq.com/openai/v1` or `https://api.x.ai/v1` (`src/services/ai/groq-client.ts:74-76`);
  speech goes to Groq's transcription endpoint (`src/services/ingestion/transcribe.ts:50`). The
  extracted source text being analysed goes with them. This is not end-to-end encryption — the
  provider can read it, and their terms govern what they do with it.
- **The key is the user's own.** It is pasted in Settings and written to the platform keystore via
  `expo-secure-store` — Android Keystore, iOS Keychain (`src/services/ai/credentials.ts:179-201`).
  No provider key is compiled into the bundle and no server holds one. A user with no key gets no
  AI, and the app says so.
- **Image text recognition does not leave.** OCR is ML Kit, running on-device
  (`src/services/ingestion/ocr.ts:1-10`).
- **Nothing else.** Original files are not transmitted. The Cloudinary mirror in
  `src/services/storage/cloudinary.ts` is opt-in and the storage module never calls it
  (`evidence-storage.ts:29-31`).

## Android build configuration

`plugins/with-android-security.js` sets, and `tests/android-security.test.ts` exercises:

- `usesCleartextTraffic=false` with a network security config whose base policy is
  `cleartextTrafficPermitted="false"`. Only the exact names `localhost` and `127.0.0.1` are
  excepted, for an ADB reverse tunnel (`:6-13`). There is no LAN or public HTTP exception.
- `allowBackup=false`, with every app-data domain excluded from legacy backup and from Android 12+
  cloud backup and device transfer (`:16-33`).

That closes those backup paths. It does nothing about a rooted or compromised device.

**Google Sign-In fails in every release build.** `android/keystore.properties:12-16` records the
release certificate's SHA-1 as `29:16:A3:94:7C:7A:A2:8A:9B:8E:F8:59:CE:FA:B3:31:75:17:B6:9A`. The
only fingerprint registered with Firebase is `5e8f16062ea3cd2c4a0d547876baa6f38cabf625`
(`google-services.json:21`), the debug key's. They do not match, so Google Sign-In returns
`DEVELOPER_ERROR` on any release APK. The app degrades to email and password rather than failing
silently (`src/services/auth/google.ts:155-162`, surfaced at `app/sign-in.tsx:283-284`). Only the
project owner can fix this, by adding the release fingerprint in the Firebase console. Note that
the fingerprint in `keystore.properties` is a written note rather than a reading taken from the
keystore — `keytool` cannot run here to confirm it against the key itself.

## The seal, and what it would establish

`src/domain/analysis/audit-chain.ts` derives a SHA-256 hash chain over a case's audit entries at
render time, storing nothing. `src/domain/crucible/seal.ts` signs that chain head with Ed25519.

Stated exactly:

- The chain is **tamper-evident**. Re-deriving it and getting the same head means no covered entry
  was altered, inserted, reordered or dropped. It is not resistant to rewriting: anyone who can
  rewrite the stored entries can recompute a consistent chain over their rewrite, because the
  digests are derived rather than signed (`audit-chain.ts:25-32`).
- A seal is an **existence proof over the entries it covers** — that this record existed, in this
  order, by the moment a signer's clock says. It is not a claim that the contents are true, that a
  document is authentic or unedited, or that any of it is admissible anywhere (`seal.ts:20-37`).
- A reader checks a seal's signature against the public key published in
  `src/domain/crucible/keys.ts` for the key id carried on that seal. An unrecognised key id is
  reported as unable-to-check — never as a pass, and never as evidence of tampering (`keys.ts:88`).

**No seal can currently be made.** The signer is a Cloud Function or the platform server, and
neither is reachable: Spark has no Functions, and the platform API has no address. `sealAvailability`
therefore answers `device-only` or `no-service` for every workspace this build can produce
(`request-seal.ts:114`), and the UI says which rather than offering a button that fails.

## Absent

Controls a reader might reasonably assume are present, and are not:

- **No encryption at rest beyond what the OS provides.** Evidence files sit in the app's private
  directory and records sit in AsyncStorage as plain JSON. The protection is the Android app
  sandbox plus whatever full-disk encryption the handset has. The app adds none of its own. The AI
  provider key is the single exception — it is in the platform keystore.
- **Erase is not a secure wipe.** `eraseEverything` removes records, stored originals and provider
  keys, then drops the Firestore cache — but Firebase's documentation is explicit that clearing
  that cache does not overwrite the data. It ends the app's access to those copies; it does not
  defeat a forensic tool on a device someone is holding (`src/services/erase.ts:44-52`).
- **Per-item deletion keeps the bytes.** Discarding one case or one document writes a `deletedAt`
  tombstone. Only the account-wide erase removes anything.
- **No revoked-token checking, no rate limiting, no abuse controls.** The rules check the token's
  uid; nothing checks whether that token was revoked. There is no quota, throttle or connection cap
  anywhere in the running path — the `functions/` server that had those is unreachable.
- **No sharing model.** One owner per document, no roles, no grants, no admin path. Participant
  names on a case are metadata, not access.
- **Not audited.** No third party has reviewed this code, these rules, or the provider data
  handling. The test suite is evidence about a particular run of the unit tests and nothing else —
  not about infrastructure, not about a real handset.

### Recently closed

- **Sign-out clearing the Firestore cache.** Firestore is initialised with `persistentLocalCache`
  (`src/data/firebase/firebase-repository.ts:653-654`), which keeps an on-disk copy of every
  document read — `extraction.sourceText`, the full extracted text of a user's evidence, included.
  Signing out of Auth does not touch that copy, so on a shared or handed-on device one account's
  source text could survive a sign-out and be readable by the next person. This was open when the
  audit began. A fix landed in the working tree during it: `signOut`
  (`src/services/session-provider.tsx:671`) now calls `runSignOutTeardown`, which awaits
  `repository.dropLocalCache?.()` at `src/services/session-provider.tsx:176`, with coverage in
  `tests/sign-out-remanence.test.ts`. Treat this as newly changed code — it has not yet been
  exercised on a device.

## Reporting a vulnerability

This is a single-developer project. There is no security team, no bounty and no SLA, and it would
be dishonest to print one here.

Report privately to the repository owner — open a GitHub security advisory on the repository, or
contact the owner directly. Please do not open a public issue for something exploitable.

Worth including: the file or Firestore collection affected, what an attacker needs to begin (an
account? the APK? physical access to an unlocked phone?), what they get, and the smallest
reproduction you can manage.

**Never include real case material.** No provider keys, no Firebase ID tokens, no evidence files,
no screenshots of someone's dispute. Synthetic fixtures only.

Expect a reply in days rather than hours.

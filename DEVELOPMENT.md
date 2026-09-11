# Development

## Requirements
Node 22 LTS (22.15 inspected; prefer latest patched 22), npm, Git, Android Studio with JDK 17+ compatible with Expo 55, Android SDK platform/build tools requested by prebuild, emulator image or USB debugging device. Java 21 is recommended for current Firebase emulators. EAS builds can run remotely without a local Android toolchain. No VPS is required.

## Install and local demonstration
```sh
npm ci
npm run start
# press a for Android on an attached device/emulator, or:
npm run web
```
The welcome screen has an explicit local demo action. It uses synthetic freelancer records and the same domain and screens, but does NOT verify Firebase, cloud processing or authentication. Local file processing supports text/manual transcriptions; server PDF parsing is cloud-only.

## Firebase setup
Create a Firebase project and a Web app to obtain SDK configuration. Enable email/password Authentication, Cloud Firestore and Cloud Storage. Choose region intentionally (default us-central1). Upgrade to Blaze for deployed Functions and current Storage provisioning, even when usage fits no-cost quotas. Copy `.env.example` to `.env.local`; fill public Firebase values. Restart Metro after changes.

```sh
npm --prefix functions ci
npm run functions:build
npx firebase login
npx firebase use --add
npx firebase deploy --only firestore:rules,firestore:indexes,storage,functions --project YOUR_PROJECT_ID
```
Deployment is an explicit developer action and can incur charges. Enable Cloud Functions, Cloud Build, Artifact Registry, Cloud Run, Eventarc, Pub/Sub and Secret Manager APIs as requested by Firebase. Choose the Storage bucket from the console, not an inferred suffix.

## Optional Gemini
The deterministic upload pipeline does not require Gemini. To enable explicit AI suggestion requests, configure Secret Manager:
```sh
npx firebase functions:secrets:set GEMINI_API_KEY --project YOUR_PROJECT_ID
```
Use an official Google AI API key; enable the Gemini API and confirm model availability/quota. Server `GEMINI_MODEL` defaults to a documented configurable model. Key never belongs in EXPO_PUBLIC variables. Deploy the suggestion function with the secret. Errors leave extraction and manual review available.

## Emulators
```sh
npm run functions:build
npm run emulators
```
Use the deliberately non-production `demo-casegraph` project. Set `EXPO_PUBLIC_USE_EMULATORS=true`, host `10.0.2.2` for Android emulator, `127.0.0.1` for web, or LAN machine IP for a physical phone. Set public project ID `demo-casegraph` and nonsecret emulator dummy values. Auth 9099, Firestore 8080, Storage 9199, Functions 5001, UI 4000. Do not connect emulators after SDK requests have started. Emulator AI is unavailable unless a deliberate `.secret.local` is supplied (gitignored). Do not send real sensitive evidence in development.

## Validation and Android build
```sh
npm run typecheck
npm test
npm run functions:build
npm run test:rules
npx expo-doctor
npm run export:android
npx expo run:android
# or after configuring your EAS account/project:
npx eas-cli build --platform android --profile preview
```
Java/SDK are needed for local APK builds; Metro Android export is only JavaScript bundling, not proof of an APK build or runtime stability. See VERIFICATION.md for actual results. `eas.json` provides a development-client profile and installable preview APK profile. No native OCR module is included until build compatibility is verified; use manual transcription for image evidence.

## Costs
Auth and Firestore have quotas; Firestore bills reads/writes/storage, listeners can generate repeat reads. Functions, build artifacts, Eventarc and Storage may bill under Blaze. Gemini has tier/model-dependent quotas, pricing and data-use terms. App has bounded uploads and maxInstances but this is not a billing cap. Set budgets/alerts in Google Cloud (alerts do not stop billing). Local demo and deterministic unit tests need no cloud services. Emulator downloads and EAS builds need network and may have service quotas.

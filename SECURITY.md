# Security model and current deployment boundary

The current supported deployment is a local Node backend with authenticated clients. The repository contains controls for private evidence handling, but it is not a completed public multi-tenant security certification.

## Implemented controls

- Firebase ID tokens are verified server-side against the configured project. The token UID determines the account; body fields do not grant access.
- Owned case and evidence checks run before processing or file access. Commit validation checks final-batch ownership, case membership and referenced objects.
- Clients cannot replace stored original paths/hashes, extraction results, jobs, saved AI reports or server analysis timestamps through normal mutation endpoints.
- Original filenames do not determine arbitrary filesystem paths. Server-generated account/case/evidence paths are resolved beneath the configured original directory.
- Original downloads require authentication and ownership, use attachment disposition, and disable caching/content sniffing.
- Upload streaming enforces 100 MB, computes SHA-256, stages a temporary file and prevents changed bytes replacing a published original.
- Known image/PDF signatures are checked during extraction. DOCX expansion is capped at 40 MB declared expanded content and 3,000 entries. DOCX parsing, PDF rendering and image OCR use credential-free child processes with 256 MB V8 old-space limits and bounded output. Deadlines are 30 seconds for DOCX/OCR and 45 seconds for PDF rendering. Images are capped at 30 MB/24 megapixels; PDF processing limits pages, rendered pixels and OCR work. These V8/process controls do not bound all native/WASM memory or provide an OS sandbox.
- Case/job/report requests and model responses are schema validated. Source citations must match exact supplied segment text and offsets.
- Prompt instructions treat source documents as untrusted data. Quoted instructions inside evidence do not receive system-message authority.
- Groq credentials are backend-only. Public Expo configuration is not a secret store. The Profile screen contains no provider key or diagnostics controls.
- Browser origins are explicitly allowed; the default API host is loopback. Native clients still require bearer authentication even when no Origin header exists.
- Processing jobs have duplicate locks, leases and per-account hourly request limits. Account limits cap originals at 2 GB, cases at 500 and evidence at 500 per case; the server caps connections at 40. Job errors expose only explicitly safe domain messages.
- Recent searches are account-scoped on the device; sign-out retains the local identity necessary to reopen that device's existing cases.
- Previous-cloud recovery reads under the same Firebase account and uses an atomic absent-case/absent-record precondition. It cannot overwrite live records or turn historical file URLs, extraction, hashes or AI states into trusted current results.
- Report HTML escapes all user/model text before printing. The report contains sensitive case content; original files stay separate and sharing uses the system flow.
- The Android Expo security plugin denies general cleartext and permits only exact localhost/127.0.0.1 for a USB ADB reverse tunnel to the PC. It sets allowBackup=false and excludes all app-data domains from legacy backup plus Android 12+ cloud/device transfer. This protects data from those backup paths, not from a compromised/rooted device.

## Threats not eliminated by these controls

A valid quote can still be misinterpreted. OCR and transcription can be wrong. A screenshot can be edited before upload. SHA-256 detects identical bytes, not truth or authenticity. A hash chain recomputed from stored audit records is not an external, immutable notarization service. Do not describe these controls as proof of guilt, payment settlement or sender identity.

Speech audio and selected extracted text are sent to the configured provider for transcription/analysis. Image/PDF OCR runs locally on the backend. This is not end-to-end encryption where only the user can read the content. Review provider data terms and the intended use before a public launch. No model-provider key is needed in an end-user account.

## Public deployment gates

| Area | Current limitation / required next step |
| --- | --- |
| Transport | Current Android HTTP access is loopback through USB only; PC/backend/tunnel must remain available. Terminate TLS and use HTTPS for a public service |
| Disk and request abuse | Basic per-account quotas and a connection cap exist; add concurrency fairness, whole-server capacity monitoring and operator alerts |
| Parsing | Document subprocess/time/heap limits exist; add OS sandboxing, whole-process resource controls and malware scanning as appropriate |
| Persistence | JSON store is single-process and rewrites the dataset; migrate for multi-worker scale and stronger durability |
| Host privacy | POSIX mode requests do not establish Windows ACL policy; restrict the data directory with actual OS permissions and disk encryption |
| Recovery | Schedule encrypted backups of metadata plus originals and test restoration |
| Authentication | Default verifyIdToken validates token integrity/expiry; it does not enable per-request revoked-token checking |
| Authorization | Cases currently have one owner. Participant names are not shared-account access grants |
| Lifecycle | A readable assessment export exists; original-file package export and a retention policy remain incomplete. An account-wide erase does exist (`src/services/erase.ts`, reached from the profile screen) and is total for the owner across records, stored originals and provider keys — it throws rather than half-succeeding when the repository cannot honour it. Per-item deletion is still a tombstone: discarding one case or one document does not shred its bytes |
| Search | Full-owner workspace loading needs pagination/indexing for larger accounts |
| Observability | Add operational metrics, queue/disk alerts and safe structured error logging without evidence or secrets |
| Native release | Signed release APK and its packaged manifest are verified by `npm run apk`, which applies `plugins/with-android-security.js` to the checked-in `android/` and reads `allowBackup`, `usesCleartextTraffic` and the network security config back out of the built APK. Accessibility and real-device lifecycle are still unvalidated. Google Sign-In additionally needs the release certificate's SHA-1 registered in the Firebase console; until it is, the build warns and the button falls back to email sign-in |

Auth emulator mode must remain loopback-only. Never expose an emulator-backed API on a shared or public interface. Never solve a permissions error by accepting a client-supplied UID.

## Reporting and verification

Report a suspected issue privately with the affected route, prerequisite, expected/actual result and a minimal synthetic reproduction. Do not paste provider keys, Firebase ID tokens or personal case contents.

Use backend tests for ownership, forged processing data, cross-case references, invalid citations, upload lifecycle and malformed documents. Use UI tests for account switching and error states. A passing unit suite is not evidence that public infrastructure, revocation policy, real Android networking or provider data handling has been audited.

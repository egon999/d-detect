# Research and implementation decisions

Research checked during the September 2026 rebuild against official documentation and the current repository. These references guide engineering decisions; they do not independently validate this application's runtime.

| Reference | Finding | Applied decision / limit |
| --- | --- | --- |
| https://docs.expo.dev/versions/v55.0.0/ | Exact installed SDK must guide native API usage | Preserve Expo 55 stack and verify Android separately |
| https://docs.expo.dev/versions/v55.0.0/sdk/auth-session/ | Provider SDKs are preferred when available; native redirect configuration matters | Retain native Google ID-token flow; use Firebase popup on web |
| https://firebase.google.com/docs/auth/web/manage-users | User/providerData exposes real provider identities/photos; sensitive password changes need reauthentication | Provider-aware profile, current-password reauth and awaited persistence |
| https://firebase.google.com/docs/auth/web/google-signin | Google ID tokens can be exchanged for Firebase credentials | Android token exchange; browser popup chooses account |
| https://firebase.google.com/docs/auth/admin/verify-id-tokens | Verify Firebase ID token on the backend; token verification is distinct from revocation checking | Authenticated UID ownership; document revocation limit |
| https://firebase.google.com/docs/functions/get-started | Cloud Functions deployment requires Blaze | Local Node API avoids a required billing upgrade; Firebase deployment remains optional |
| https://console.groq.com/docs/vision | Vision is model-dependent and accepts image inputs | Evaluated as a candidate; a real synthetic-image trial produced invented/duplicated text, so it is not used as source transcription |
| https://console.groq.com/docs/speech-to-text | Upload format/size constraints, segment timestamps, first audio track behavior | 25 MB transcript request cap, timing where returned, explicit no-frame/no-speaker guarantee |
| https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html | Validate extension/type/content, generate safe paths, restrict access and resources | Private authenticated originals, type/signature checks, quotas and parser subprocess limits; OS sandboxing/scanning remain gates |
| https://docs.expo.dev/config-plugins/mods/ | Manifest changes belong in config mods; generated native resources need reproducible generation | with-android-security plugin maintains Android manifest/XML constraints across prebuild |
| https://developer.android.com/privacy-and-security/security-config | Domain-specific cleartext opt-in can retain a global deny policy | Only exact localhost and 127.0.0.1 permitted for USB ADB reverse; no LAN/global HTTP opt-in |
| https://developer.android.com/identity/data/autobackup | allowBackup=false alone may not suppress Android 12+ vendor device transfer | Disable backup and explicitly exclude every app-data domain in legacy, cloud and device-transfer rules |

## Reasoning decisions

A citation must be an exact match in an owned supplied source segment. This makes provenance mechanically checkable. It does not make the model's interpretation mechanically true. Claim labels therefore retain uncertainty, missing information and source coverage.

Evidence text is an untrusted input, including instructions printed inside a screenshot or document. Provider prompts explicitly separate it from analysis instructions. This reduces instruction-following risk but is not a complete prompt-injection proof.

Source diversity is not a count of uploaded files. Identical hashes indicate duplicate bytes, while different files may still repeat the same account. The backend removes agreement entries based solely on one original hash/source, and native text plus OCR from the same PDF remains one source. Robust source-independence scoring still requires evaluation.

Source transcription must not be generated prose. Actual image trials exposed hallucinated text in the candidate vision model, so screenshots use local Tesseract English/Hindi OCR with explicit machine-reading limitations. The mixed-PDF path preserves page anchors and text/OCR distinctions. These implementation experiments support the choice; they are not a benchmark proving accuracy on every user's evidence.

Character offsets are computed by application code. The model names a source segment and exact quotation; a unique match supplies deterministic UTF-16 offsets before the final strict citation validation. This avoids relying on model arithmetic while preserving rejection of invented quotes and unknown sources.

A participant name is descriptive metadata. It must not silently become verified identity or authorization. Likewise, a failed-payment screenshot may contradict what the screenshot says about completion while still failing to establish the actual bank settlement state.

## Alternatives reviewed

- Direct provider calls from the app were rejected because the platform credential would become extractable and end users would need developer settings.
- Firebase Functions are retained as a deployment alternative, but are not required to run the current no-billing-upgrade local backend.
- A generic graph of counts was rejected in favor of inspectable relationships derived from real case records and citations.
- Silent local fallback for an account-backed write was rejected as a substitute for confirmed backend persistence.
- Decorative confidence percentages were rejected because no calibrated method was established.
- New notification/provider toggles without functional backend behavior were excluded from account settings.

## Unresolved research/validation work

Calibrated confidence, speaker attribution, video event recognition, manipulated-document detection, source-independence evaluation and large-case retrieval need their own datasets, error analysis and acceptance tests. The existence of a model API is not sufficient evidence that those product promises are met.

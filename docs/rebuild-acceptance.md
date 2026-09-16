# Rebuild acceptance record

Review scope: case creation, uploads, persistent processing, claim assessment, graph, search, account settings, Android experience, security and documentation. This file records source-backed implementation and validation boundaries; it is not an unconditional production acceptance.

Status meanings: **Implemented** = concrete code path exists; **Targeted test** = named automated tests exercise that behavior; **Pending runtime** = requires the actual UI/provider/device journey; **Incomplete** = requested capability is not fully implemented.

| Requirement | Implementation/evidence | Status / remaining validation |
| --- | --- | --- |
| Case save through UI/API/store | Mutation batch, remote repository, local commit validator | Implemented; live UI create/reload must be recorded by integration owner |
| Custom category, participants, claim | Case schema and intake | Implemented; participants do not grant shared-account access |
| Real originals | Authenticated stream, private path, SHA-256, immutable-content retry | Implemented; backend lifecycle tests plus live mixed-file upload |
| Persisted queue/failure/retry | Jobs, locks, lease, terminal errors | Implemented; process-kill recovery and interrupted native upload need runtime exercise |
| Images/screenshots | Local English/Hindi Tesseract OCR, PNG/JPEG/WebP, source text | Implemented; synthetic-image real OCR exercised by backend workstream; user screenshot quality still requires review |
| PDFs/documents | Native text plus bounded sparse-page OCR, page anchors, DOCX raw text, UTF-8 files | Mixed-PDF actual OCR and focused tests exercised; full table/layout reasoning incomplete |
| Audio/video | Supported audio/container transcription | Implemented speech; video frames and verified speaker identity incomplete |
| Multi-source claim assessment | Saved report with requested claims, coverage, limitations | Implemented; live conflicting-source review required |
| Source provenance | Exact segment/quote/offset validation | Backend contract tests; semantic correctness still needs review |
| Appropriate conclusion states | Six saved model-assessment statuses, stance checks | Implemented; not a factual certainty guarantee |
| Real graph | Actual records/relationships/report citations | Integration owner must verify node/edge inspection and empty state in browser/device |
| Provider keys absent from profile | Backend provider module, account screen | Implemented; built bundle and storage secret checks must be recorded |
| Google profile and linked providers | Session mapping from user/providerData; provider photo fallback | account-profile.test.ts; real Google browser/Android photo refresh still needs runtime verification |
| Password/reset flows | Password-provider controls, current-password reauthentication, reset UI | Implemented; use authorized dedicated account for live mutations |
| Real case history | Repository-backed account case list | Implemented; refresh/account-switch UI verification |
| Previous cloud cases | Same-account Firestore review, atomic missing-case-only copy, historical recovery notes | migration-plan.test.ts; live legacy rules/account access and UI import still require verification |
| Truthful Home/activity | Saved assessments, staleness/citation checks, persisted jobs/audit entries | home-activity.test.ts; no inferred all-clear from empty deterministic findings |
| Assessment export | Escaped HTML, citations, limitations, source hashes; web print/native PDF share | export-report.test.ts; real print/device flow requires visual verification; originals remain separate |
| Search real text/entities/events | Owner-filtered search index, no seeded query chips | search-index.test.ts |
| Search history privacy | Account-scoped keys; remember/clear preference | search-preferences.test.ts tests account isolation, disable/clear and legacy-key handling; device UI behavior needs runtime verification |
| Mobile quality/accessibility | Keyboard-aware forms, labels, wrapping actions, real states | Pending signed Android device/large-text/screen-reader acceptance |
| Android transport and local-data backup | Expo plugin for exact-loopback cleartext only, global deny, disabled backup and all-domain transfer exclusions | android-security.test.ts; final merged APK resources and real USB/network behavior need artifact/device verification |
| Cross-account authorization | Verified UID, batch reference checks, file/job ownership | Backend and remote-repository tests; independent authenticated negative-path smoke test |
| Multi-contributor workflow | Source labels/participant metadata only | Incomplete: no invitation/role/shared-account ACL |
| Large evidence sets | File/account/record limits, parser deadline, explicit text/page/claim/source coverage | Bounded foundation; scalable storage/search and retrieval incomplete |
| Architecture documentation | Actual local API/store/provider/jobs/contracts | Updated alongside implementation; recheck after further backend changes |
| Public production readiness | Local authenticated platform | Incomplete; deployment gates in SECURITY.md |

## Regression exercises

- Empty user sees no invented cases, graph, results or history.
- Invalid case inputs remain editable; failed persistence does not navigate to a fabricated case.
- File metadata without bytes cannot masquerade as a processed original.
- Unsupported/scanned/oversized inputs remain stored or fail explicitly with actionable status.
- All case claims appear exactly once in a saved assessment.
- Invalid quotes, wrong offsets, unknown evidence and unknown/repeated claims are rejected.
- Duplicate sources do not automatically count as independent agreement.
- Changing evidence while analysis runs prevents publishing a stale report as current.
- Foreign-owner and deleted records do not appear in search.
- Google-only account gets Google security controls; password account requires current password to change it.
- Device sign-out preserves the local identity needed to reopen existing cases.
- Previous cloud recovery never overwrites current records, copies foreign/deleted data, or elevates old extraction/AI states into verified results.
- Text and OCR from the same PDF page are one source. Excluded OCR pages and text truncation remain visible.
- HTML-like user/model text is printed literally in exports and cannot inject document markup.
- Leaving and returning to Analysis reads the saved report rather than retaining another case's component state.

## Verification record

Run npm run typecheck, npm test, npm --prefix functions test and the actual user journey. Keep console output or integration notes for that run. Do not infer provider success from mocked tests or native success from a browser render.

The integration owner owns live browser screenshots/interactions, real backend/provider requests, Android availability, and final remaining blockers. Test counts are intentionally not frozen in this document while integration is ongoing.

# CaseGraph — project specification

## Purpose
CaseGraph reconstructs a case from scattered sources. The hierarchy is **Case → Claims → Events → Evidence → Relationships**. It is an evidence organisation and analysis tool, not legal advice, legal verification, or proof of truth. Findings describe the current linked evidence, not what definitively happened.

## Submission scope
An Android-first Expo Router / React Native TypeScript application with email/password Firebase authentication; owner-scoped cases; claims and events; private evidence uploads and manual notes; deterministic extraction and normalization; explainable rules; reviewable Gemini suggestions; timeline; a tappable derived graph; and append-oriented audit history. A freelancer payment dispute is available through a clearly labelled, device-local demo using the same domain commands and screens. Cloud mode never bypasses authentication or Security Rules.

## Acceptance workflow
1. Sign in (or explicitly enter local demonstration).
2. Create a case and claim; add a dated event.
3. Upload a PDF, text export or image, or enter a note. Inspect processing and recover from failure.
4. Inspect normalized fields and provenance. Confirm only after reviewing.
5. Link evidence to claims/events with an explicit relationship type.
6. Run analysis; inspect inputs, rule identifiers and explanations; mark reviewed/dismissed.
7. Open timeline, graph and audit history.

## Boundaries
No VPS, relational database, graph database or custom document parser. Gemini is optional and never authoritative. Image OCR is a replaceable provider boundary; manual transcription remains available if native OCR is unavailable. Exact duplicates require SHA-256 byte equality. Similar identifiers imply related sources, not independent corroboration. Review state does not change evidence content.

## Initial environment (2026-09-11)
Workspace E:\\Project Evid was empty and not a Git repository. Scaffold created in `casegraph/` because the parent folder is not a URL-safe package name. Windows 11 build 26100; Git Bash; Node 22.15.0; npm 11.12.1. Expo SDK 55 is pinned rather than adopting latest SDK 57 without compatibility validation. Android SDK contains adb/emulator; Java was absent from PATH, no AVD or attached device. No project Firebase configuration or environment files supplied. Existing global Firebase login credentials were not read. See DEVELOPMENT.md and VERIFICATION.md for current setup and actual checks.

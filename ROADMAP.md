# Roadmap

## Implementation sequence
1. Inspect environment and establish documented domain/security contracts.
2. Scaffold pinned Expo Router application; implement pure normalization, extraction, rule registry and tests.
3. Add owner-checked Firebase commands, private Storage pipeline, validated AI suggestions and rules tests.
4. Build authentic case/claim/event/evidence workflows and explainable analysis.
5. Derive timeline/graph, audit view and synthetic seeded case; test and polish.

## Deliberately deferred
- Native ML Kit OCR until a maintained Expo 55/new-architecture module is Android-build validated. Manual transcription and server text/PDF extraction are honest fallbacks.
- Play Integrity/App Check enforcement pending tested native integration.
- Multi-user authorization/collaboration; owner-only is enforced initially.
- Advanced full-text search, semantic pairwise duplication, custom rule builder, extensive theme switching.
- Physical erasure/account deletion, encrypted offline evidence vault and deployment-specific retention policy.
- OCR for scanned PDFs, large/malicious document sandboxing beyond bounded MVP ingestion, high-volume case pagination, production quotas and monitoring.
- Native APK/device verification when local Java/SDK/device prerequisites or an EAS account are unavailable.

## Demonstration story
A freelance designer invoiced a client for a website. An invoice, delivery email and payment receipt provide linked but not conclusive sources. Two dates disagree, delivery has corroborating sources, and a second promised reimbursement lacks evidence. The examiner opens the case, follows a finding to its sources, adds/links a note, reruns rules, then explores the timeline, graph and audit trail. No synthetic AI responses are labelled real model output.

## Release gate
Refer to VERIFICATION.md rather than treating this roadmap as evidence of completion. A production release requires authenticated cloud smoke testing in the chosen project, rules emulator execution, tested Android APK, security review, cost limits and retention decisions.

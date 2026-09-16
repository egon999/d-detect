# Remaining engineering work

This roadmap distinguishes implemented foundations from work needed for broader use. It is not a list of features that are already available.

## Before public deployment

- Replace single-process JSON persistence with a versioned database strategy appropriate for expected load, plus object storage and tested backup/restore.
- Extend implemented account/file/connection limits with concurrency fairness, whole-server resource monitoring and operational alerts.
- Strengthen existing document subprocess isolation with OS sandboxing and malware scanning where required; verify native network/storage permissions.
- Deploy HTTPS, process supervision and a clear identity/revocation policy.
- Complete retention, original-file package export, deletion and provider-data handling policy; the current readable assessment PDF is not a complete evidence archive.
- Validate all workflows on signed Android builds and real devices, including interruptions and accessibility.

## Evidence processing

- Extend current bounded scanned/mixed-PDF OCR beyond 10 sparse pages using resumable jobs; evaluate text-rich pages with embedded images and suspicious hidden text layers.
- Add video-frame extraction and event descriptions with exact time anchors, keeping speech separate.
- Add document structure/tables and spreadsheet extraction without executing active content.
- Add retrieval/chunk selection for large evidence sets with explicit coverage and per-source limits.
- Evaluate extraction and claim reasoning against independently labelled mixed-source datasets, including manipulated screenshots and adversarial instructions.
- Add grounded entity/event normalization without merging people or events solely because labels resemble each other.
- Implement calibrated evidence-quality dimensions when a validated method exists; do not add arbitrary percentages.

## Collaborative and operational features

- Design explicit case membership, invitations, roles and contributor/source attribution before enabling multiple accounts to edit a shared dispute.
- Move search to an owner-authorized server index with pagination and source snippets.
- Add actionable notifications only when real job-event delivery and user preferences exist.
- Add schema migrations, data reconciliation, queue metrics and recovery tooling.
- Maintain human review and source provenance when adding providers, deterministic validators or specialist analyzers.

The current source-oriented report and repository boundaries allow these changes without exposing provider credentials in user profiles.

# Dispatch to M2 Explorer 3: Normalization & Verifiable Citations

You are M2 Explorer 3.
Your working directory: e:/Project Evid/detact/.agents/m2_explorer_3
Project root: e:/Project Evid/detact
Authoritative Request: e:/Project Evid/detact/.agents/ORIGINAL_REQUEST.md
Project Specification: e:/Project Evid/detact/PROJECT.md

Scope & Boundaries:
Read-only exploration.
Investigate Feature 6 (Normalization & Verifiable Citations):
1. Examine `src/domain/normalize/dates.ts`, `src/domain/normalize/money.ts`, `src/domain/normalize/text.ts`, and `src/domain/rules/provenance.ts`.
2. Check how extracted dates, currencies, and counterparties are linked to exact text offsets (`startOffset`, `endOffset`, `page`, `startMs`, `endMs`).
3. Ensure OCR-generated segments preserve citation integrity so cross-evidence comparison and claim assessment flag exact verifiable citations without drift.
4. Specify recommendations and test specifications for the Worker.

Output:
Write report to `e:/Project Evid/detact/.agents/m2_explorer_3/handoff.md` and notify orchestrator when complete.

# Original User Request

## Initial Request — 2026-09-17T15:56:12Z

Use a very large team of agents.

Reconstruct and elevate Ddetect into a complete, reliable, production-grade evidence intelligence and verification application. Deliver an end-to-end evidence proving pipeline, a decluttered modern dark royal blue & light user experience, a purposeful Evidence Prover AI reasoning assistant with session proxy support, and five groundbreaking intelligence capabilities.

Working directory: e:/Project Evid/detact
Integrity mode: development

## Verification Resources
- Test Suite: `npm test` (Vitest test suite with 1,500+ unit and integration tests across data layer, domain rules, hashing, OCR, and provenance).
- Static Type Checking: `npm run typecheck` (`tsc --noEmit`).
- Code Quality & Doctor: `npm run lint:expo` (`expo-doctor`).
- Release Packaging: `npm run apk` (Android standalone APK compilation pipeline).

## Requirements

### R1. Cloud-Native Storage & Offline-Resilient Data Architecture
Implement a hybrid cloud-and-local data engine. When authenticated, cases, metadata, and files must persist to Firebase Firestore and Cloud Storage (or Cloudinary), while maintaining instant local offline caching, optimistic UI updates, and deterministic offline rule evaluation. The app must withstand network dropouts, app restarts, and offline states with zero unhandled exceptions.

### R2. End-to-End Evidence Ingestion, Extraction & Verification Pipeline
Provide a unified evidence intake workflow supporting images, PDFs, office documents, audio recordings, and structured notes. The system must compute SHA-256 content hashes, perform on-device and cloud OCR/transcription, normalize dates, monetary values, and counterparties, and detect duplicates upon selection.

### R3. Purposeful Evidence Prover AI Assistant & Transparent Reasoning
Deploy an Evidence Prover AI Reasoning Assistant built specifically for evidence cross-examination, contradiction hunting, and claim support verification.
- Provide personal Gemini session/cookie proxy support to eliminate API credit consumption, alongside deterministic rule reasoning.
- Gracefully handle session expiration or connection dropouts without interrupting the user experience or throwing unhandled errors.
- Remove all user-facing developer jargon, latency checks, and exposed API keys from profile and settings screens.

### R4. Streamlined 3-View Case Workspace (Dark Royal & Crisp Light)
Eliminate fragmented navigation and cognitive overload by replacing the disparate sub-screens with a cohesive 3-view Case Workspace:
1. **[Evidence View]**: Ingestion queue, rich media previews (image viewer, PDF viewer, audio player), extraction progress, and status alerts.
2. **[Intelligence View]**: Core claims, automated contradiction/corroboration matrix, side-by-side comparison, and the embedded Evidence Prover Assistant.
3. **[Proof & Dossier View]**: Interactive chronological timeline, visual relationship graph, tamper-evident hash verification, and one-tap exportable formal proof dossier.

### R5. Groundbreaking Differentiated Intelligence Capabilities
Deliver five high-leverage capabilities that set the product apart:
1. **Opposing Narrative Simulator & Blind-Spot Hunter**: Anticipates the counterparty's strongest arguments and highlights missing evidence or unaddressed timelines before dispute filing.
2. **The Event Nexus (Multi-Modal Chronological Replay)**: Synchronizes multi-source evidence (photos, audio waveforms, chat excerpts, bank debits) along a unified scrubbable temporal axis.
3. **Truth Decay & Credibility Cascade**: Traces contradiction ripple effects to illustrate how a single debunked fact damages dependent claims and participant credibility.
4. **Cryptographic Proof Capsule**: Creates an interactive, tamper-evident verification portal package where counterparties, arbitrators, or courts can click claims to inspect original source excerpts and verify SHA-256 hashes.
5. **Strategic Next-Move Playbook**: Translates verified findings into concrete tactical action steps, dispute escalation templates, and negotiation guidelines.

### R6. Controlled Execution & Workspace Integrity
All source code changes, asset generation, scripts, and build artifacts must remain confined within `e:/Project Evid/detact`. Never leak credentials or write sensitive files outside the project root.

## Acceptance Criteria

### Verification & Pipeline Functionality
- [ ] Running `npm test` passes all tests with zero failures.
- [ ] Running `npm run typecheck` completes with zero TypeScript errors.
- [ ] Files (images, PDFs, documents, audio) upload, extract text/entities, and persist with verifiable SHA-256 provenance without hanging.
- [ ] Cross-evidence comparison and claim assessment flag discrepancies, corroborations, and missing facts with exact verifiable citations.

### AI & Assistant Stability
- [ ] Evidence Prover Chatbot provides deep contextual reasoning grounded strictly in uploaded case evidence.
- [ ] Personal Gemini session proxy operates cleanly with automatic fallback to deterministic extraction if the session expires.
- [ ] Zero exposed API key fields, developer diagnostics, or verbose academic copy visible to end users.

### Differentiated Feature Execution
- [ ] Event Nexus timeline displays and synchronizes multi-modal artifacts on a scrubbable chronology.
- [ ] Opposing Narrative Simulator identifies concrete evidence gaps and potential counter-arguments.
- [ ] One-tap generation of an exportable Proof Capsule and formal PDF dispute dossier.

### UI/UX, Performance & Accessibility
- [ ] Unified 3-view case workspace ([Evidence], [Intelligence], [Proof & Dossier]) fully replaces fragmented sub-routes.
- [ ] Clean visual hierarchy with zero cognitive clutter, responsive layouts, and polished micro-interactions.
- [ ] High-contrast dark royal blue theme and light theme with WCAG AA compliance.
- [ ] Zero unhandled crashes during edge cases, empty states, or network transitions.

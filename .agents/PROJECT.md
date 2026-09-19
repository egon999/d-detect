# Project: Ddetect Reconstruction & Elevation

## Architecture
- **Application Core**: React Native 0.83.10, React 19.2.0, Expo SDK ~55.0.31, Expo Router ~55.0.18, TypeScript strict mode.
- **Data & Persistence**:
  - `Repository` port with `FirebaseRepository` (Firestore with `persistentLocalCache`, 10s `LOCAL_PENDING` timeout) and `LocalRepository` (`AsyncStorage`).
  - Hybrid storage engine: local file persistence via `expo-file-system` / IndexedDB mirrored to Cloud Storage / Cloudinary when authenticated.
  - Durable offline sync queue (`@detact:v1:cloud_sync_queue`) with exponential backoff and retry drain.
  - Offline-resilient deterministic rule engine (`src/domain/rules/`) executing 16 in-memory rules with zero network dependencies.
- **Evidence Pipeline**:
  - SHA-256 content hashing (`@noble/hashes`).
  - Multimodal ingestion (`src/services/ingestion/ingest.ts`): PDF text & rasterized images, Office XML (DOCX/XLSX/PPTX via `pako`), audio/video transcription (Groq Whisper), on-device ML Kit OCR (Latin + Devanagari dual-pass), CSV, and notes. Zero unhandled exceptions or hangs.
  - Immediate pre-upload duplicate detection upon selection (`src/services/ingestion/dedup.ts`, `upload.tsx`) with visual warning chips.
  - Deterministic normalizers for dates, ISO minor currencies, counterparties, and Indic numerals with exact citation offset preservation.
- **Intelligence & AI**:
  - Evidence Prover AI Assistant with personal Gemini session/cookie proxy support.
  - Zero exposed API keys or developer latency probes in end-user settings.
  - Deterministic offline reasoning fallback.
- **User Interface**:
  - Streamlined 3-View Case Workspace: `[Evidence View]`, `[Intelligence View]`, `[Proof & Dossier View]`.
  - High-contrast Dark Royal (`#060B18`) and Crisp Light (`#F8FAFC`) palettes with WCAG AA compliance.
- **5 Differentiated Intelligence Capabilities**:
  1. Opposing Narrative Simulator & Blind-Spot Hunter
  2. The Event Nexus (Multi-Modal Chronological Replay)
  3. Truth Decay & Credibility Cascade
  4. Cryptographic Proof Capsule
  5. Strategic Next-Move Playbook

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Baseline Test Suite Hygiene | Exclude/remove scratch probe test to restore 100% clean test suite baseline | M1 (DONE) | Survey (Exp 2) |
| 2 | Cloud Storage Mirroring | Wire authenticated evidence uploads to Cloud Storage / Cloudinary with local caching | M1 (DONE) | Survey (Exp 1), R1 |
| 3 | Offline Resilience & Network Handling | Deterministic offline operation, network state transitions, zero unhandled errors | M1 (DONE) | Survey (Exp 1), R1 |
| 4 | Multimodal Evidence Ingestion | Ingestion pipeline for PDF, Office, audio, images, and notes | M2 (DONE) | Survey (Exp 1), R2 |
| 5 | Immediate Deduplication upon Selection | Instant SHA-256 duplicate detection upon file picking before save | M2 (DONE) | Survey (Exp 1), R2 |
| 6 | OCR, Transcription & Normalization | ML Kit OCR, Whisper transcription, normalized dates/amounts/counterparties | M2 (DONE) | Survey (Exp 1), R2 |
| 7 | Secure Clean Settings | Elimination of exposed API keys, console links, and `/models` latency probes | M3 | Survey (Exp 3), R3 |
| 8 | Personal Gemini Session Proxy | Cookie/session proxy support eliminating API credit consumption | M3 | Survey (Exp 3), R3 |
| 9 | Evidence Prover Conversational AI | Interactive AI assistant grounded in evidence with deterministic fallback | M3 | Survey (Exp 3), R3 |
| 10 | Streamlined 3-View Case Workspace | Replace fragmented 7+ sub-routes with [Evidence], [Intelligence], [Proof & Dossier] | M4 | Survey (Exp 3), R4 |
| 11 | Rich Media In-App Previews | In-app image viewer, full PDF viewer, waveform audio player | M4 | Survey (Exp 3), R4 |
| 12 | Opposing Narrative Simulator & Blind-Spot Hunter | Counterparty argument simulation, unaddressed timeline alerts, evidence gaps | M5 | Survey (Exp 3), R5.1 |
| 13 | The Event Nexus | Scrubbable temporal axis synchronizing multi-modal artifacts and timeline replay | M5 | Survey (Exp 3), R5.2 |
| 14 | Truth Decay & Credibility Cascade | Contradiction ripple propagation, claim vulnerability, participant credibility decay | M5 | Survey (Exp 3), R5.3 |
| 15 | Cryptographic Proof Capsule | Standalone interactive verification portal package with browser-side SHA-256 checks | M5 | Survey (Exp 3), R5.4 |
| 16 | Strategic Next-Move Playbook | Tactical action steps, dispute escalation ladders, negotiation guidelines | M5 | Survey (Exp 3), R5.5 |
| 17 | E2E Requirement Test Suite (Tiers 1-4) | Comprehensive opaque-box test suite across all 16 features | Test Track (DONE) | Dual Track, R6 |
| 18 | Final Verification & Hardening | `npm test`, `npm run typecheck`, `npx expo-doctor`, `npm run apk` | M6 | Survey (Exp 2), R6 |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| Test Track | E2E Testing Track | Design test runner, test infrastructure, and test cases across Tiers 1-4. Publish TEST_READY.md | none | DONE |
| M1 | Cloud-Native Storage & Data Layer | Restore test baseline, wire cloud storage mirroring to upload pipeline, offline resilience | none | DONE |
| M2 | Multimodal Ingestion & Immediate Deduplication | Immediate duplicate detection on file selection, robust multimodal intake, OCR & normalizers | M1 | DONE |
| M3 | Evidence Prover AI & Session Proxy | Clean settings (no exposed keys/jargon), personal Gemini session proxy, Prover assistant | M1 | IN_PROGRESS |
| M4 | Streamlined 3-View Case Workspace | Unified [Evidence], [Intelligence], [Proof & Dossier] views, rich media viewers, Dark Royal/Crisp Light | M2, M3 | PLANNED |
| M5 | Five Groundbreaking Capabilities | Opposing Narrative, Event Nexus, Truth Decay, Proof Capsule, Strategic Playbook | M4 | PLANNED |
| M6 | Final Verification & Packaging | 100% E2E test pass, adversarial hardening, typecheck, expo-doctor, standalone APK build | M5, Test Track | PLANNED |

---

## Interface Contracts

### M1 Storage ↔ M2 Ingestion
- `evidence-storage.ts`:
  - `uploadEvidenceFile(options: { ownerId: string; caseId: string; file: PickedFile; mirrorToCloud?: boolean }): Promise<{ evidence: Evidence; sha256: string; cloudUrl?: string }>`
- `key-value-store.ts` & `local-repository.ts`:
  - Maintains `Workspace` contract with offline optimistic updates.

### M2 Ingestion ↔ M4 Evidence View
- `src/services/ingestion/dedup.ts`:
  - `checkDuplicateBeforeUpload(file: PickedFile, existingEvidence: Evidence[]): Promise<{ isDuplicate: boolean; matchedEvidence?: Evidence; sha256: string }>`

### M3 Session Proxy ↔ M4 Intelligence View
- `src/services/ai/gemini-proxy.ts`:
  - `interface GeminiProxyConfig { proxyUrl?: string; sessionCookie?: string; enabled: boolean }`
  - `queryEvidenceProver(prompt: string, context: EvidenceContext, proxyConfig?: GeminiProxyConfig): Promise<ProverResponse>`
  - Automatic fallback to `deterministicReasoning(context)` when proxy is unreachable or session expires.

### M5 Capabilities ↔ M4 Case Workspace
- `OpposingNarrative`: `simulateOpposingNarrative(workspace: Workspace): OpposingNarrativeReport`
- `EventNexus`: `NexusTimelineState`, `NexusArtifact[]`, `scrubToTimestamp(ms: number)`
- `TruthDecay`: `propagateContradictionCascade(contradictionId: string, workspace: Workspace): CascadeResult`
- `ProofCapsule`: `exportProofCapsule(caseId: string, workspace: Workspace): Promise<ProofCapsulePackage>`
- `StrategicPlaybook`: `generateStrategicPlaybook(workspace: Workspace): TacticalPlaybook`

---

## Code Layout
- `src/domain/`: Pure business logic, normalizers, hashing, rules, models, enums (no React Native or DOM dependencies).
- `src/data/`: Data repository contracts, local storage (AsyncStorage), remote sync, Firebase Firestore.
- `src/services/`: Storage, file intake, ML Kit OCR, Whisper transcription, AI session proxy, repository providers.
- `src/ui/`: Design tokens (`tokens.ts`), themes, atomic UI components (cards, badges, buttons, layout).
- `src/features/`: Feature modules (workspace, evidence queue, intelligence matrix, proof timeline, playbook).
- `app/`: Expo Router application screens:
  - `app/case/[caseId]/index.tsx`: Cohesive 3-View Case Workspace with segmented controller (`[Evidence]`, `[Intelligence]`, `[Proof & Dossier]`).
- `tests/`: Vitest test suites executing in pure Node environment.

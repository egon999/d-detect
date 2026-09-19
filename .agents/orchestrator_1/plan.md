# Project Orchestration Plan: Ddetect Elevation

## 1. Objective
Complete reconstruction and elevation of Ddetect into a reliable, production-grade evidence intelligence and verification application per e:/Project Evid/detact/.agents/ORIGINAL_REQUEST.md.

## 2. High-Level Phases
- **Phase 0: Survey & Spec Extraction (Current)**
  - Spawn 3 Explorers in parallel to inspect:
    1. Explorer 1: Current data layer, storage engine, Firestore/Cloudinary/local state, and offline persistence (`src/services`, `src/store`, `src/types`, config).
    2. Explorer 2: Existing tests, test runner (`vitest`), typecheck setup, scripts, package.json, build targets, and Expo configuration.
    3. Explorer 3: Existing screens, components, routes, AI assistant implementation, evidence intake pipelines, and UX design system.
  - Consolidate findings into `PROJECT.md § Feature Inventory` and `§ Architecture`.

- **Phase 1: Dual Track Launch**
  - **E2E Testing Track**: Spawn Sub-orchestrator / Test Writer agents to construct comprehensive test harnesses, test cases (Tiers 1-4), and establish `TEST_INFRA.md` & `TEST_READY.md`.
  - **Milestone Decomposition**: Break implementation into disciplined milestones.

- **Phase 2: Implementation Milestones**
  - **Milestone 1**: Cloud-Native Storage & Offline-Resilient Architecture (Firestore, Cloud Storage/Cloudinary, local caching, deterministic offline rule evaluation).
  - **Milestone 2**: End-to-End Evidence Ingestion, Extraction & Verification Pipeline (multimodal ingestion, SHA-256 content hashing, OCR/transcription, entity normalization, deduplication).
  - **Milestone 3**: Purposeful Evidence Prover AI Assistant & Session Proxy (session/cookie proxy support, deterministic rule reasoning fallback, removal of exposed keys/diagnostics/jargon).
  - **Milestone 4**: Streamlined 3-View Case Workspace (Dark Royal & Crisp Light) ([Evidence], [Intelligence], [Proof & Dossier]).
  - **Milestone 5**: Five Groundbreaking Differentiated Capabilities (Opposing Narrative Simulator, Event Nexus, Truth Decay & Credibility Cascade, Cryptographic Proof Capsule, Strategic Next-Move Playbook).

- **Phase 3: Final Verification & Hardening**
  - Full E2E test execution (`npm test` 100% passing).
  - Strict TypeScript check (`npm run typecheck` zero errors).
  - Expo Doctor verification (`npm run lint:expo`).
  - Standalone release packaging verification (`npm run apk`).
  - Forensic integrity audit & Final report to Sentinel caller.

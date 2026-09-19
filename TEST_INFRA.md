# Detact E2E Test Infrastructure & Test Architecture

## 1. Executive Summary

This document defines the End-to-End (E2E) Test Architecture and Verification Infrastructure for **Detact** — an evidence intelligence and forensic verification application. The testing strategy employs a four-tier opaque-box methodology designed to validate requirement compliance, mathematical and cryptographic invariants, domain rule execution, and end-to-end dispute workflows without coupling to ephemeral UI presentation details.

---

## 2. Test Architecture & Environment Design

### 2.1 Execution Environment
- **Test Runner**: Vitest v5.0.0
- **Runtime Environment**: Pure Node.js (`environment: 'node'`)
- **Global Runtime Guard**: `define: { __DEV__: 'false' }` preventing lazy React Native / Expo native module evaluation failures.
- **Module Resolution & Aliasing**:
  - `@domain/` -> `src/domain/` (pure business logic, cryptographic hashing, normalization, deterministic rule engine)
  - `@data/` -> `src/data/` (repository contracts, local storage, Firebase Firestore abstraction)
  - `@services/` -> `src/services/` (storage, multimodal ingestion, OCR, AI session proxy, Groq client)
  - `@ui/` -> `src/ui/` (design tokens, epistemic color palettes, WCAG AA compliance)
  - `@features/` -> `src/features/` (workspace controllers, upload queue, case analysis)
  - `react-native` -> `react-native-web` (headless web primitives for Node test compatibility)

### 2.2 Test Principles
1. **Opaque-Box & Behavior-Driven**: Tests assert observable outcomes, state transitions, and contract adherence rather than private implementation details.
2. **Deterministic & Isolated**: Each test constructs its own state via `resetIds()`, `emptyWorkspace()`, and explicit test builders. Zero test order dependencies.
3. **Cryptographic Rigor**: Verification uses real SHA-256 digests (`@noble/hashes`) and real Ed25519 signatures (`@noble/curves/ed25519`) matching production execution.
4. **Epistemic Honesty**: Tests strictly verify that uncertain, unconfirmed, or AI-generated inputs are properly quarantined and never styled or asserted as verified truth.

---

## 3. Four-Tier Testing Methodology

```
+-----------------------------------------------------------------------+
|                       TIER 4: SCENARIOS                               |
|   Real-world dispute lifecycles: Medical bill, Landlord deposit,     |
|   Freelance breach with full Proof Capsule export & verification      |
+-----------------------------------------------------------------------+
                                   ▲
+-----------------------------------------------------------------------+
|                      TIER 3: COMBINATIONS                             |
|   Pairwise feature interactions: Ingest + Dedup, Contradiction +     |
|   Cascade, Proxy + Fallback, Proof Capsule + Tamper Detection         |
+-----------------------------------------------------------------------+
                                   ▲
+-----------------------------------------------------------------------+
|                      TIER 2: BOUNDARIES                               |
|   Boundary value analysis: 0-byte files, 100MB max limit, negative    |
|   currencies, malformed hashes, traversal attacks, unicode stress     |
+-----------------------------------------------------------------------+
                                   ▲
+-----------------------------------------------------------------------+
|                      TIER 1: FEATURE COVERAGE                         |
|   >= 5 tests per feature across all 16 features from PROJECT.md       |
|   (Minimum 80 tests covering M1 - M5 capabilities)                    |
+-----------------------------------------------------------------------+
```

---

## 4. Feature Inventory & Coverage Matrix

| Feature # | Feature Name | Description | Target File | Tier 1 Tests |
|---|---|---|---|---|
| **F01** | Baseline Test Suite Hygiene | Pure Node isolation, clean test harness, zero unhandled errors | `tier1-features.test.ts` | 5 |
| **F02** | Cloud Storage Mirroring | Opaque private paths, path traversal rejection, cloud mirror fallback | `tier1-features.test.ts` | 5 |
| **F03** | Offline Resilience & Network Handling | Deterministic in-memory rule engine, clock isolation, review persistence | `tier1-features.test.ts` | 5 |
| **F04** | Multimodal Evidence Ingestion | PDF, image, audio, video, office classification & text intake | `tier1-features.test.ts` | 5 |
| **F05** | Immediate Deduplication upon Selection | Byte-level SHA-256 duplicate detection, distinct label reporting | `tier1-features.test.ts` | 5 |
| **F06** | OCR, Transcription & Normalization | ISO/UK/US dates, ISO minor currencies, Indic numerals, party normalization | `tier1-features.test.ts` | 5 |
| **F07** | Secure Clean Settings | Key redaction (`scrubKey`), omission of private secrets from client bundle | `tier1-features.test.ts` | 5 |
| **F08** | Personal Gemini Session Proxy | Cookie/proxy config, automatic fallback to deterministic reasoning | `tier1-features.test.ts` | 5 |
| **F09** | Evidence Prover Conversational AI | Citation indexing, offset verification, grounded cross-examination | `tier1-features.test.ts` | 5 |
| **F10** | Streamlined 3-View Case Workspace | [Evidence], [Intelligence], [Proof & Dossier] state partitions & WCAG AA | `tier1-features.test.ts` | 5 |
| **F11** | Rich Media In-App Previews | Stored original access, object URL lifecycle, waveform & page navigation | `tier1-features.test.ts` | 5 |
| **F12** | Opposing Narrative Simulator | Counterparty argument simulation, timeline gaps, unsupported claims | `tier1-features.test.ts` | 5 |
| **F13** | The Event Nexus | Multi-modal chronological axis, temporal honesty, scrubbable replay | `tier1-features.test.ts` | 5 |
| **F14** | Truth Decay & Credibility Cascade | Contradiction ripple propagation, claim state transitions, independent source isolation | `tier1-features.test.ts` | 5 |
| **F15** | Cryptographic Proof Capsule | Audit hash chain, Ed25519 seal verification, tamper sensitivity | `tier1-features.test.ts` | 5 |
| **F16** | Strategic Next-Move Playbook | Redressal ladder matching, dispute escalation letter, limitation alerts | `tier1-features.test.ts` | 5 |

**Tier 1 Total: 80 tests**

---

## 5. Tier Inventory Breakdown

### Tier 1: Feature Coverage (`tests/e2e/tier1-features.test.ts`)
- **Suite Count**: 16 feature suites
- **Test Count**: 80 test cases (5 tests / feature)
- **Focus**: Verifies each individual capability against its specifications and interface contracts in `PROJECT.md`.

### Tier 2: Boundary & Corner Cases (`tests/e2e/tier2-boundaries.test.ts`)
- **Suite Count**: 5 boundary suites
  - Suite 2.1: Empty Inputs & Zero States (empty workspace, empty text file, 0-byte buffer, unlinked claims)
  - Suite 2.2: Extreme Payloads & Max-Size Limits (100 MB ceiling guard, oversize refusal, extreme string truncation)
  - Suite 2.3: Zero, Negative & Extreme Monetary Balances ($0.00, negative debt, trillion-unit amounts, currency mismatches)
  - Suite 2.4: Malformed, Corrupted & Invalid Data (corrupt SHA-256 strings, malformed UUIDs, leap-year invalid dates, traversal paths)
  - Suite 2.5: Encoding, Escaping & Adversarial Unicode (control characters, RTL markers, Devanagari numerals, HTML/SQL injection payloads)
- **Test Count**: 15 test cases
- **Focus**: Boundary value analysis, resource stress, and adversarial input resilience.

### Tier 3: Pairwise Cross-Feature Interactions (`tests/e2e/tier3-combinations.test.ts`)
- **Suite Count**: 8 interaction suites
  - Pair 1: Ingestion + Immediate Deduplication
  - Pair 2: Contradiction Detection + Truth Decay Cascade
  - Pair 3: OCR Extraction + Date Normalization + Event Nexus Timeline
  - Pair 4: AI Session Proxy + Offline Deterministic Reasoning Fallback
  - Pair 5: Audit Chain Hash + Ed25519 Crucible Seal + Proof Capsule Export
  - Pair 6: Opposing Narrative Simulator + Strategic Next-Move Playbook
  - Pair 7: Multimodal Ingestion + Secure Clean Settings
  - Pair 8: Rich Media Previews + Cryptographic Hash Verification
- **Test Count**: 12 test cases
- **Focus**: Integration contracts between modules and multi-feature state propagation.

### Tier 4: Real-World Dispute Scenarios (`tests/e2e/tier4-scenarios.test.ts`)
- **Suite Count**: 3 realistic dispute workflows
  - Scenario 1: Medical Bill Overcharge Dispute (itemized billing vs insurance EOB, amount mismatch, claim state flip, insurance ombudsman escalation, proof capsule)
  - Scenario 2: Landlord Security Deposit Withholding Dispute (lease agreement, move-out inspection, late deduction notice, 46-day timeline gap, statutory demand letter)
  - Scenario 3: Freelance Non-Payment & Deliverable Breach (consulting contract, approved deliverables, unpaid invoices, email acknowledgment contradiction, small claims filing package)
- **Test Count**: 9 test cases (3 multi-step checkpoints per scenario)
- **Focus**: Full lifecycle simulation of complex, end-to-end evidence proving disputes.

---

## 6. Total Test Summary

| Test Suite File | Tier | Focus | Test Count |
|---|---|---|---|
| `tests/e2e/tier1-features.test.ts` | Tier 1 | Feature Coverage (16 Features) | 80 |
| `tests/e2e/tier2-boundaries.test.ts` | Tier 2 | Boundary Value Analysis | 20 |
| `tests/e2e/tier3-combinations.test.ts` | Tier 3 | Cross-Feature Interactions | 14 |
| `tests/e2e/tier4-scenarios.test.ts` | Tier 4 | Real-World Application Scenarios | 9 |
| **Total E2E Test Suite** | **Tiers 1-4** | **Comprehensive E2E Verification** | **123** |

---

## 7. Execution & Verification Guide

### Running E2E Test Suites
```bash
# Run all E2E test suites cleanly
npx vitest run tests/e2e/

# Run specific tier test suite
npx vitest run tests/e2e/tier1-features.test.ts
npx vitest run tests/e2e/tier2-boundaries.test.ts
npx vitest run tests/e2e/tier3-combinations.test.ts
npx vitest run tests/e2e/tier4-scenarios.test.ts
```

### Verification Criteria
1. All tests execute in a clean Node environment without requiring native runtime shims or external networks.
2. 100% pass rate with zero test failures or unhandled rejections.
3. Tests strictly exercise domain rules, normalizers, hash chains, seals, and repositories.

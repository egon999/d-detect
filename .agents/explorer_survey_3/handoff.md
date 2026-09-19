# Survey Report: UI/UX Navigation, Evidence Prover AI Assistant, and Differentiated Capabilities

**Explorer**: Survey 3  
**Working Directory**: `e:/Project Evid/detact/.agents/explorer_survey_3`  
**Date**: 2026-09-17  
**Integrity Mode**: Development / Read-Only Investigation  

---

## 1. Observation

### 1.1 App Navigation, Routing, Screens, Tab Bars, and Headers
- **Root Layout & Boot Sequence** (`app/_layout.tsx`):
  - Line 48–59: Configures `GestureHandlerRootView`, `SafeAreaProvider`, `ThemeProvider`, `RepositoryProvider`, `SessionProvider`, `ToastProvider`, and `AppShell`.
  - Line 68–96: Employs an unconditional failsafe timer (`SPLASH_FAILSAFE_MS = 1400`) to guarantee that the native splash screen dismisses even if font decoding or network handshakes stall.
  - Line 189–206: Declares top-level Stack navigation: `index`, `onboarding`, `sign-in`, `(tabs)`, `case`, `new-case` (modal), `notifications` (modal), `search` (modal), `about`, and `+not-found` (modal).
- **Tab Shell & Floating Tab Bar** (`app/(tabs)/_layout.tsx`, `src/features/navigation/tab-bar.tsx`):
  - `app/(tabs)/_layout.tsx` (Lines 91–101): Configures 4 tabs: `index` (Home), `cases` (Cases), `insights` (Analysis), and `profile` (Profile).
  - `src/features/navigation/tab-bar.tsx` (Lines 41–51, 58–64): Builds a custom floating bar containing four route tabs and an elevated center action button (`COMPOSE_OVERHANG = 22`). Tapping the center action opens a bottom sheet (`BottomSheet`) that offers either "Add evidence" to the most recently updated case or "Create a case".
  - `tab-bar.tsx` (Lines 89–92): Exposes `useTabBarInset()` to compute exact bottom padding for tab screens (`floatHeight + LAYOUT.tabBarHeight + COMPOSE_OVERHANG + SPACING.xl`).
- **Case Stack Layout & Header Strategy** (`app/case/[caseId]/_layout.tsx`):
  - Lines 9–25, 30–36: Uses `headerShown: false` across the entire case stack. Native headers are omitted because each screen renders its own masthead, case title subtitle, and back control through `ScreenScroll`.
  - Lines 40–41: Presents `upload` and `export` as modals.
- **Fragmented Case Screens** (`app/case/[caseId]/`):
  - `app/case/[caseId]/index.tsx` (Lines 98–181, 449–623): Renders a single lengthy vertical feed displaying Claims (`AssessmentPlate`s), Evidence list (`EvidenceRow`s with unread notice), `CaseAnalysisPanel`, Events, Participants, and a "Go further" navigation menu pointing to seven sub-routes:
    1. `/case/[caseId]/letter` ("Escalation letter" — complaint drafting)
    2. `/case/[caseId]/compare` ("Compare documents" — side-by-side comparison)
    3. `/case/[caseId]/timeline` ("Timeline" — chronological day cluster spine)
    4. `/case/[caseId]/graph` ("Connections" — entity relationship graph)
    5. `/case/[caseId]/audit` ("History" — hash chain and crucible seal verification)
    6. `/case/[caseId]/export` ("Export" — single-page PDF printout)
    7. `/case/[caseId]/details` ("Case details" — metadata & participants)
  - Detail screens:
    - `/case/[caseId]/evidence/[evidenceId].tsx` (Lines 383–389): File viewing modal only natively previews `Image` on mobile; for PDF, Audio, and Video on mobile, it relies on `expo-sharing.shareAsync()` or web iframes/tags rather than rich in-app PDF and waveform audio viewers.
    - `/case/[caseId]/claim/[claimId].tsx`: Claim view with citations and status.
    - `/case/[caseId]/event/[eventId].tsx`: Event view with linked claims and evidence.

### 1.2 Design Tokens & Themes (Dark Royal and Crisp Light)
- **Theme Definitions** (`src/ui/tokens.ts`, `src/ui/theme.tsx`):
  - `src/ui/tokens.ts` (Lines 477–521): `darkColors` implements the **Dark Royal** palette using `palette.royal950` (`#060B18`) canvas, `palette.royal880` (`#0E172E`) surface, `palette.royal800` (`#162344`) raised surface, structural gold accent `palette.gold500` (`#C6A43B`), and high-contrast royal blue CTA (`#2B5FD9`).
  - `src/ui/tokens.ts` (Lines 393–430): `lightColors` implements the **Crisp Light** palette using `palette.paper100` (`#F8FAFC`) canvas, crisp white surfaces (`#FFFFFF`), cool grey-blue borders (`#DCE3F0`), warm brass structural accent `palette.brass600` (`#8A6B1A`), and dark navy CTA (`#0C1734`).
  - `tests/theme-contrast.test.ts` (Lines 1–355): Confirms all 78 contrast tests pass, verifying strict WCAG 2.1 AA compliance (>= 4.5:1 for body text, >= 3:1 for large text and UI components) across both schemes.

### 1.3 Evidence Prover AI Assistant & Gemini Session/Cookie Proxy
- **Active Refusal of Gemini** (`src/services/ai/credentials.ts`):
  - Lines 25–31, 62–69:
    ```typescript
    // Gemini is present but deliberately unreachable
    // Gemini keys are refused on the device, always.
    const GEMINI_IS_SERVER_ONLY = true;
    ```
  - Lines 166, 180–184, 213, 232, 256: Explicitly blocks saving, loading, or using Gemini keys on device (`if (provider === 'gemini') return false;`).
- **User-Facing API Key Management and Diagnostics in Settings** (`src/features/settings/ai-key-section.tsx`, `app/(tabs)/profile.tsx`):
  - `src/features/settings/ai-key-section.tsx` (Lines 117–120, 197–251, 350–450): Directly exposes text fields for users to paste raw Groq (`gsk_...`) and xAI (`xai-...`) API keys.
  - Lines 214–251: Executes live `GET /models` probes with latency timeouts and reports raw status codes (`401/403`, `429`, unconfirmed network state).
  - Lines 400–450: Displays developer console links (`console.groq.com`, `console.x.ai`) directly in the end-user profile.
- **Absence of Conversational Evidence Prover Assistant** (`src/services/ai/`):
  - `src/services/ai/semantic-assistant.ts` (Lines 89–130) and `src/features/analysis/case-analysis-panel.tsx` (Lines 42–54, 116–140): AI functionality is restricted to batch one-shot prompts (`FIELD_EXTRACTION`, `CROSS_DOCUMENT_RECONCILIATION`, `SUPPORT_STRENGTH`, `MISSING_INFORMATION`, `TIMELINE_COHERENCE`).
  - Results are rendered as static suggestion cards requiring manual "Accept" or "Dismiss" button clicks.
  - There is **no interactive chat interface**, cross-examination dialogue, or Evidence Prover conversational assistant anywhere in the codebase.
- **Backend Implementation** (`functions/src/provider.js`):
  - Lines 1–43: Firebase Cloud Functions also hardcode calls to Groq (`https://api.groq.com/openai/v1`) using `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, and `whisper-large-v3`. There is no Gemini session/cookie proxy endpoint in `functions/src/`.

### 1.4 The 5 Differentiated Capabilities
1. **Opposing Narrative Simulator & Blind-Spot Hunter**:
   - `src/domain/analysis/evidence-intelligence.ts` (Lines 58–67) has basic `CompletenessGap` models, and `src/services/ai/prompts.ts` has `MISSING_INFORMATION_PROMPT`.
   - `src/domain/analysis/limitation.ts` checks statutory limitation periods.
   - **Gaps**: No counter-argument generator, no simulation of counterparty positions/narratives, and no dedicated Blind-Spot Hunter interface.
2. **The Event Nexus (Multi-Modal Chronological Replay)**:
   - `src/domain/analysis/timeline.ts` (Lines 8–11) and `app/case/[caseId]/timeline.tsx` (Lines 43–99) implement a static vertical list with day clusters and a drawn spine.
   - `src/domain/extraction/` segments contain timestamps (`startMs`, `endMs`, `page`).
   - **Gaps**: The timeline is entirely static. There is no scrubbable temporal axis, no playback controller, and no synchronized multi-modal media replay (e.g. photos, audio waveforms, chat excerpts, and bank records moving in sync along a timeline slider).
3. **Truth Decay & Credibility Cascade**:
   - `src/domain/analysis/graph.ts` builds graph relationships (`GraphNode`, `GraphEdge`), and `src/domain/analysis/claim-state.ts` computes individual claim states (`SUPPORTED`, `CONTRADICTED`, `INSUFFICIENT_EVIDENCE`).
   - `src/domain/analysis/independence.ts` computes source independence ratios.
   - **Gaps**: There is no downward contradiction ripple-effect propagation model. Discrediting an evidence source does not dynamically recalculate dependent claim vulnerabilities. There is no participant credibility scoring or decay metric, nor any cascade visualization.
4. **Cryptographic Proof Capsule**:
   - `src/domain/hashing.ts` computes SHA-256 digests.
   - `src/domain/crucible/` (`seal.ts`, `case-seal-state.ts`) provides Ed25519 digital signature verification.
   - `src/domain/analysis/audit-chain.ts` generates cryptographic hash chains over audit logs.
   - `src/domain/analysis/export-report.ts` and `app/case/[caseId]/export.tsx` generate an HTML string converted to a static PDF via `expo-print`.
   - **Gaps**: There is no exportable, interactive, self-contained Cryptographic Proof Capsule package (standalone web bundle/HTML) allowing external third parties (arbitrators, courts, counterparties) to click claims, inspect cited source excerpts, and independently verify SHA-256 hashes and digital signatures in-browser without the app.
5. **Strategic Next-Move Playbook**:
   - `src/domain/analysis/escalation.ts` (Lines 57–100) contains rich knowledge of Indian statutory redressal ladders (Banking Ombudsman, Insurance Ombudsman, Telecom, Consumer Commission).
   - `src/domain/analysis/filing-draft.ts` and `app/case/[caseId]/letter.tsx` assemble a formal grievance letter with fill-in-the-blank placeholders.
   - **Gaps**: The capability is restricted to a single letter draft screen (`letter.tsx`). There is no tactical action playbook, phased escalation strategy (e.g., informal notice -> formal capsule -> ombudsman complaint -> consumer court), negotiation leverage assessment, or counterparty pressure points.

### 1.5 Verification Tool Results
- `npm run typecheck`: Exited with code 0 (`tsc --noEmit` clean, zero errors).
- `npm test`: 73 test files passed, 1,474 tests passed. 58 skipped (Firestore rules requiring local emulator). Exactly 1 failure occurred in `tests/scratch-probe.test.ts` due to a stray dynamic import of `app/case/[caseId]/evidence/[evidenceId]` under Node/Vitest without JSX transformation.

---

## 2. Logic Chain

1. **Fragmented UI Architecture**:
   - *Premise*: `app/case/[caseId]/index.tsx` renders an initial overview and defers 7 core capabilities to external sub-routes (`/compare`, `/timeline`, `/graph`, `/audit`, `/export`, `/letter`, `/details`), while evidence media detail (`/evidence/[evidenceId]`) is an isolated modal with limited media players.
   - *Inference*: This architecture introduces excessive context switching and violates Requirement R4, which mandates a unified, cohesive 3-View Case Workspace ([Evidence], [Intelligence], [Proof & Dossier]).
2. **Design Token Maturity**:
   - *Premise*: `tokens.ts` defines comprehensive tokens for `darkColors` (royal palette `#060B18`, surface `#0E172E`, gold `#C6A43B`) and `lightColors` (paper `#F8FAFC`, brass `#8A6B1A`), with 78 unit tests in `theme-contrast.test.ts` verifying WCAG AA contrast.
   - *Inference*: The color tokens, theme architecture, and primitive design components already provide a solid, production-grade visual foundation for the 3-view workspace in both Dark Royal and Crisp Light themes.
3. **AI Assistant & Proxy Misalignment**:
   - *Premise*: `src/services/ai/credentials.ts` explicitly rejects Gemini on device (`GEMINI_IS_SERVER_ONLY = true`), `src/features/settings/ai-key-section.tsx` forces users to supply Groq or xAI API keys, and `src/services/ai/semantic-assistant.ts` only provides batch one-shot suggestions without a chat UI.
   - *Inference*: This directly conflicts with Requirement R3 and Acceptance Criteria, which require: (a) zero exposed API keys or developer diagnostics in settings, (b) personal Gemini session/cookie proxy support to eliminate API credit consumption, and (c) an interactive Evidence Prover chatbot grounded in case evidence with deterministic offline fallback.
4. **Differentiated Capabilities Maturity Gap**:
   - *Premise*: The repository has strong foundational domain logic (rules engine, conflict classification, timeline bands, graph layout, crucible hash chains, escalation ladders, and letter generation), but lacks:
     - Adversarial counter-argument modeling (Opposing Narrative Simulator & Blind-Spot Hunter)
     - Interactive multi-modal temporal scrubbing & replay (The Event Nexus)
     - Ripple-effect contradiction propagation & participant credibility decay (Truth Decay & Credibility Cascade)
     - Standalone interactive client-verifiable proof capsule (Cryptographic Proof Capsule)
     - Phased strategic escalation & negotiation leverage playbook (Strategic Next-Move Playbook)
   - *Inference*: The domain primitives exist to power these features, but domain algorithms, UI presentation components, and workspace integration must be constructed to fulfill Requirement R5.

---

## 3. Caveats

1. **Firestore Emulator**:
   - 58 tests in `tests/firestore-rules.test.ts` were skipped because the local Firebase emulator was not running on port 8080 during testing. This is standard in offline development and does not indicate test failure.
2. **Scratch Test File**:
   - `tests/scratch-probe.test.ts` contains a 9-line test that attempts to dynamically import an Expo Router screen component into Node Vitest. This test fails due to Expo Router's `<` JSX syntax in node_modules, not due to application logic.
3. **Hardware / Device-Specific Media Testing**:
   - Audio playback (`expo-audio`) and PDF preview behavior were inspected via source code analysis. Real-device audio codec latency and native PDF rasterization performance could not be profiled on Android hardware in read-only investigation mode.

---

## 4. Conclusion

The Detact project possesses exceptional domain modeling, mathematical hashing, rule validation, and typography/contrast discipline. However, it currently diverges from the authoritative specifications in three fundamental areas:

1. **Navigation & Case Workspace**: Navigation is currently split across a high-level overview and 7+ disparate sub-screens. It must be refactored into the unified **Streamlined 3-View Case Workspace**:
   - **[Evidence View]**: Queue intake, rich media viewers (image, PDF, audio player), extraction status.
   - **[Intelligence View]**: Claims, contradiction/corroboration matrix, side-by-side comparison, and the embedded Evidence Prover Assistant.
   - **[Proof & Dossier View]**: Chronological timeline, relationship graph, hash-chain/crucible verification, and export dossier.
2. **AI Assistant & Credentials Architecture**: Gemini was hardcoded as server-only and blocked on-device, while Groq/xAI API keys and diagnostic probes are exposed in Settings. This must be replaced with:
   - Clean settings (zero exposed API keys or developer jargon).
   - Personal Gemini session/cookie proxy support with seamless fallback to deterministic offline rules.
   - An interactive conversational Evidence Prover AI reasoning assistant embedded into the Intelligence view.
3. **The 5 Differentiated Capabilities**: All 5 capabilities currently exist only as partial seeds or fragments in domain algorithms. They require dedicated modeling, computation pipelines, and rich UI components.

---

## 5. Verification Method

To independently verify the observations and findings of this report:

1. **Typecheck & Test Execution**:
   ```powershell
   cd "e:/Project Evid/detact"
   npm run typecheck
   npm test
   ```
   - Verify `tsc --noEmit` exits with code 0.
   - Verify Vitest completes with 1,474 passing tests.
2. **Inspect Route Fragmentation**:
   - Inspect `app/case/[caseId]/index.tsx` (Lines 108–181) to observe the 7 sub-route destinations (`letter`, `compare`, `timeline`, `graph`, `audit`, `export`, `details`).
3. **Inspect Exposed API Keys & Gemini Lockout**:
   - Inspect `src/services/ai/credentials.ts` (Lines 25–31, 62–69) to verify `GEMINI_IS_SERVER_ONLY = true`.
   - Inspect `src/features/settings/ai-key-section.tsx` (Lines 117–120, 214–251) to observe raw API key input fields, developer probe requests (`/models`), and console URLs.
4. **Inspect Design Tokens & WCAG Contrast**:
   - Inspect `src/ui/tokens.ts` (Lines 393–540) and run `npx vitest run tests/theme-contrast.test.ts` to verify the 78 passing contrast assertions for Dark Royal and Crisp Light themes.
5. **Inspect 5 Capabilities Foundations**:
   - Inspect `src/domain/analysis/escalation.ts`, `timeline.ts`, `graph.ts`, `audit-chain.ts`, `claim-state.ts`, and `evidence-intelligence.ts`.

---
*Report completed and stored in `.agents/explorer_survey_3/handoff.md`.*

# Dispatch to Worker M3: Purposeful Evidence Prover AI Assistant & Session Proxy

You are Worker M3 (AI & Security Specialist).
Your working directory: e:/Project Evid/detact/.agents/m3_worker_1
Project root: e:/Project Evid/detact
Authoritative Request: e:/Project Evid/detact/.agents/ORIGINAL_REQUEST.md
Project Specification: e:/Project Evid/detact/PROJECT.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Exclusively Owned Files:
- `src/services/ai/credentials.ts`
- `src/services/ai/gemini-proxy.ts` (create/implement)
- `src/services/ai/evidence-prover.ts` (create/implement)
- `src/features/settings/ai-key-section.tsx`
- `app/(tabs)/profile.tsx`
- `tests/evidence-prover.test.ts` (create/implement)

Implementation Tasks:
1. **Clean Profile & Settings (Feature 7 & R3)**:
   - In `src/features/settings/ai-key-section.tsx` and `app/(tabs)/profile.tsx`, completely remove:
     - Raw Groq / xAI API key text inputs (`gsk_...`, `xai-...`).
     - Developer `/models` ping probes and latency checks.
     - Console developer URLs (`console.groq.com`, `console.x.ai`).
     - Raw HTTP status codes and developer diagnostic jargon.
   - Replace with clean, user-friendly UI:
     - Clear explanation: "Evidence Prover Reasoning Assistant uses zero-credit deterministic reasoning and personal proxy acceleration."
     - Clean toggle for "Personal Session Proxy" (optional custom proxy URL or session cookie).
2. **Personal Gemini Session/Cookie Proxy Engine (`src/services/ai/gemini-proxy.ts`, Feature 8)**:
   - Lift `GEMINI_IS_SERVER_ONLY = true` restriction in `credentials.ts` to allow personal Gemini session cookies / proxy endpoint.
   - Implement `queryGeminiProxy(prompt: string, context: EvidenceContext, config: GeminiProxyConfig): Promise<ProverResponse>`.
   - Ensure non-throwing error handling: if session cookie expires, network drops, or proxy is unconfigured, seamlessly and silently fall back to deterministic rule reasoning without throwing unhandled exceptions or showing raw errors.
3. **Conversational Evidence Prover Assistant (`src/services/ai/evidence-prover.ts`, Feature 9)**:
   - Provide purposeful evidence reasoning: cross-examination, contradiction hunting, and claim support verification.
   - Ground responses strictly in the case's active evidence items, claims, dates, and amounts.
   - Formulate structured reasoning outputs: `{ answer: string; supportingEvidenceIds: string[]; contradictionsFound: ContradictionSummary[]; confidence: number; source: 'proxy' | 'deterministic' }`.
4. **Author Comprehensive Unit Tests (`tests/evidence-prover.test.ts`)**:
   - Verify clean proxy configuration and request formatting.
   - Verify seamless fallback to deterministic rule reasoning when session cookie is expired or network fails.
   - Verify zero exposed API keys or developer jargon in settings components.
   - Verify evidence-grounded responses and contradiction identification.
5. **Full Verification**:
   - Run `npm run typecheck` (MUST pass with 0 errors).
   - Run `npm test` (MUST pass with 0 failures).
   - Run `npx expo-doctor` (MUST pass 20/20 checks).

Output:
Write handoff report to `e:/Project Evid/detact/.agents/m3_worker_1/handoff.md` and message orchestrator when complete.

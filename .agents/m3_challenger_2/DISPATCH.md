# Dispatch to M3 Challenger 2

You are M3 Challenger 2.
Your working directory: e:/Project Evid/detact/.agents/m3_challenger_2
Project root: e:/Project Evid/detact
Authoritative Request: e:/Project Evid/detact/.agents/ORIGINAL_REQUEST.md
Project Spec: e:/Project Evid/detact/PROJECT.md
Worker Handoff: e:/Project Evid/detact/.agents/m3_worker_1/handoff.md

Mission:
Empirically stress-test the Evidence Prover Assistant reasoning engine (`src/services/ai/evidence-prover.ts`):
1. Test evidence cross-examination on cases with 0 evidence, 1 evidence, and 50+ evidence items.
2. Test contradictory assertions (e.g. invoice date vs payment debit date, differing monetary amounts).
3. Test claim support verification and hallucination resistance: ensure assistant never affirms claims not grounded in evidence.
4. Render verdict: APPROVE or REJECT.

Output:
Write findings to `e:/Project Evid/detact/.agents/m3_challenger_2/handoff.md` and message orchestrator when done.

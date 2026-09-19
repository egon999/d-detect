# BRIEFING — 2026-09-17T16:10:45Z

## Mission
Investigate tests/scratch-probe.test.ts, vitest.config.mts, package.json scripts (lint:expo), and expo-asset dependency to formulate concrete strategy restoring 100% test baseline and clean build configs.

## 🔒 My Identity
- Archetype: explorer
- Roles: investigator, synthesizer
- Working directory: e:/Project Evid/detact/.agents/m1_explorer_2
- Original parent: 1bb3d463-48e2-4165-9c4e-fbe369e86bec
- Milestone: M1

## 🔒 Key Constraints
- Read-only investigation — do NOT implement
- Examine tests/scratch-probe.test.ts and vitest.config.mts
- Formulate safe removal or exclusion so npm test passes with 0 failures
- Examine package.json scripts: lint:expo (needs npx expo-doctor), dependencies (needs expo-asset)
- Verify impact on npm run apk and npm test
- Output report in handoff.md and message orchestrator

## Current Parent
- Conversation ID: 1bb3d463-48e2-4165-9c4e-fbe369e86bec
- Updated: 2026-09-17T16:07:10Z

## Investigation State
- **Explored paths**:
  - `tests/scratch-probe.test.ts` (untracked probe causing JSX eval error in Node Vitest)
  - `vitest.config.mts` (Node environment, path aliases, defines `__DEV__: 'false'`)
  - `package.json` (scripts, dependencies, overrides)
  - `scripts/build-apk.mjs` (release APK pipeline preflight checks)
  - `npx expo-doctor` (20 checks: peer dep `expo-asset` missing from dependencies, `@react-native-ml-kit/text-recognition` new arch warning)
- **Key findings**:
  1. `tests/scratch-probe.test.ts` is an untracked scratch probe dynamically importing `app/case/[caseId]/evidence/[evidenceId]`. Fails in Node Vitest with `SyntaxError: Unexpected token '<'` in `expo-router/src/exports.ts`. Removing/excluding it restores 100% test pass (1,474 passed, 58 skipped, 0 failed).
  2. `npm run lint:expo` fails because `expo-doctor` is not an installed binary in `node_modules/.bin`. Changing script to `"npx expo-doctor"` fixes it.
  3. `expo-asset` (~55.0.20) is in `package.json` `overrides` and installed in `node_modules`, but omitted from direct `dependencies`, triggering `expo-doctor`'s peer dependency warning for `expo-audio`.
  4. Adding `expo-asset: "~55.0.20"` to `dependencies` and adding `expo.doctor.reactNativeDirectoryCheck.exclude` for `@react-native-ml-kit/text-recognition` gives 20/20 clean doctor checks.
  5. `scripts/build-apk.mjs` runs `npx vitest run` as a mandatory preflight gate. Restoring 0 test failures unblocks release packaging.
- **Unexplored areas**: None. All items in dispatch scope verified empirically.

## Key Decisions Made
- Recommend dual protection: Worker deletes untracked `tests/scratch-probe.test.ts` AND adds explicit exclusion in `vitest.config.mts` via `configDefaults.exclude`.
- Formulate exact `before -> after` snippets for `vitest.config.mts` and `package.json`.

## Artifact Index
- e:/Project Evid/detact/.agents/m1_explorer_2/DISPATCH.md — Task dispatch
- e:/Project Evid/detact/.agents/m1_explorer_2/BRIEFING.md — Situational awareness
- e:/Project Evid/detact/.agents/m1_explorer_2/progress.md — Liveness heartbeat
- e:/Project Evid/detact/.agents/m1_explorer_2/handoff.md — 5-component handoff report

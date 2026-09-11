# Architecture

## Deployment boundaries
- `app/`: Expo Router routes and navigation. `components/`: restrained light visual system. `features/`: case-first screens.
- `domain/`: portable strict TypeScript entities, runtime schemas, normalization, extraction, rules, graph, seeded data and commands. No Firebase or React dependencies.
- `services/`: repository contract, local demonstration adapter and authenticated Firebase adapter; OCR provider contract.
- `lib/`: client configuration and application context.
- `functions/`: Firebase Functions v2 callable commands, immutable Storage processing and optional Gemini integration. Shared domain source is copied into the functions build boundary by a build script, not fetched at runtime.
- `rules/`, `tests/`, `scripts/`: access policies, executable checks and tooling.

## Decisions
Use Firebase Auth email/password with React Native AsyncStorage persistence. Owner-only access in MVP; collaboration is deferred rather than approximated insecurely. Root collections include ownerId and caseId. Client Firestore access is read-only; trusted callable mutations enforce ownership, runtime validation, relationship endpoints and state transitions, and produce audit records. Admin SDK bypasses rules, so server checks are mandatory.

Local demo is explicitly entered, persists only on the device and uses the same entities and deterministic command layer. It never writes demo credentials or relaxed rules to Firebase. A configured cloud session does not fall back to a demo after an error.

## Processing
Reserve evidence and job → upload immutable source → finalize trigger verifies ownership/size/type → SHA-256 → PDF/text extraction (or manual transcription for image) → deterministic normalization → optional schema-validated suggestions → persist extraction → run rules → REVIEW_REQUIRED. Confirmation is a separate user operation. Retry uses the same job and source identity. Stable output IDs prevent duplicate results. A lease/fingerprint protects repeated invocations; raw sources are immutable. No automatic events are created from unaccepted extraction, avoiding duplicate timelines and accidental facts.

## Reasoning
A typed rule registry emits structured findings, not side effects. Analysis is reproducible for a sorted snapshot. Stable IDs identify rule+input combinations. Prior reviewed/dismissed findings remain historical; no longer triggered results become RESOLVED. Explicit user relationships are canonical. Timeline sorts stored event dates; uncertain/unknown dates remain visible. Graph is derived from canonical entities and relationships.

## AI boundary
Versioned extraction, normalization and relationship prompts live only in functions. Official Gemini API; Secret Manager key; bounded text input and output; Zod validation; candidate source IDs must belong to input scope. Accepted suggestions are retained separately from confirmed values; they never automatically establish supports/contradicts links. Failure is nonfatal and deterministic analysis remains usable.

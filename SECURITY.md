# Security and privacy

## Trust boundaries
Firebase identity is required for cloud operations. Every callable revalidates `request.auth.uid`, case ownership and command schema. Never trust a client-supplied ownerId. Relationships cannot cross case/owner boundaries. Firestore rules deny all client canonical writes; backend writes are validated commands plus server audit events. Queries must include ownerId. Unauthenticated and cross-owner reads are denied. No public file URLs are persisted.

Storage accepts only creates to `users/{uid}/cases/{caseId}/evidence/{evidenceId}/source`, with an existing owned case and matching UPLOADING evidence reservation, bounded size and supported MIME type. Sources cannot be overwritten or deleted casually from clients. Reads require ownership. SHA-256 is computed from server-downloaded bytes, never trusted from the client.

## Secrets and AI
`EXPO_PUBLIC_FIREBASE_*` values are public project identifiers, not authorization. Gemini API keys must only use Functions Secret Manager (`GEMINI_API_KEY`), never Expo configuration, Firestore or git. Optional AI calls send bounded evidence text to Google only on an explicit suggestion request. Review Google's current data-use policy for your paid/free tier before uploading sensitive material. Local demo files/text are not sent to Gemini. Do not log evidence text, prompts, credentials or full model responses. Prompt injection in a document is untrusted data, and model output cannot execute commands or establish truth.

## Defensive limits
Validate file size/type on both reservation and Storage; check again in processor. Bound PDF/text output and entity counts. Function timeout/maxInstances and deterministic fallback limit cost. Immutable upload, transactional mutation and job lease protect retry races. Findings and audit trails are not client-editable. Add per-user quotas/rate enforcement and abuse monitoring before internet-scale use.

## App Check
Not enforced in this MVP: Firebase JS SDK with Expo requires a deliberately validated native/custom provider. Do not pretend a web reCAPTCHA provider secures Android. Add Play Integrity with a compatible development-build provider, test emulator/debug flows, then enable enforcement. Authentication/authorization remain enforced without it.

## Privacy limitations
Device-local demo uses AsyncStorage, not an encrypted evidence vault. Use synthetic examples only. Cloud raw sources live in private Storage; extracted text may also exist in protected Firestore. Tombstoning preserves audit but is not physical erasure. Production retention, user export/account deletion, backup erasure and jurisdictional compliance need deployment-specific policy. Never describe this software as legally verifying evidence.

## Tests
Rules tests cover unauthenticated, owner and cross-owner reads, forged client canonical mutations, and immutable/private Storage uploads. They require the Emulator Suite; see VERIFICATION.md for whether this environment actually executed them.

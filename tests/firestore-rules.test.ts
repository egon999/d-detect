import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';
import { readFileSync } from 'node:fs';

/**
 * `rules/firestore.rules`, executed.
 *
 * ## Why this file exists
 *
 * These rules are the only boundary between one user's evidence and another's. The
 * Firebase API key shipped in the app is a public project identifier, not a secret —
 * anyone can point their own client at this project and authenticate as themselves. The
 * `assertOwnership` check in `src/data/repository.ts` runs on the attacker's device and so
 * protects nothing. Until this file existed there were no tests over that boundary at all,
 * and the rules had drifted into two failures that no amount of reading the app could
 * surface, because both only appear when Firestore itself evaluates the policy:
 *
 * - **Account erasure destroyed data and kept the personal information.** `clear()` walks
 *   every collection deleting the caller's documents. Only `cases` permitted it: the rest
 *   either said `allow delete: if false` or granted `allow write`, which covers delete
 *   with a predicate that reads `request.resource` — null on a delete, so the check is
 *   false and the delete is refused. Pressing "Erase everything" removed the user's cases
 *   and then failed, stranding their evidence, extracted text, audit history, display name
 *   and email in Firestore permanently.
 *
 * - **A batched write could be refused in full for being too large.** `hasCaseId()` called
 *   `getAfter()` on the named case for every case-scoped write. Firestore allows 20
 *   document-access calls per batched write and the repository batches up to 400 changes,
 *   so an analysis run — findings, jobs, audit entries and a report, committed together —
 *   sat right on a ceiling whose de-duplication behaviour is not documented anywhere.
 *   Reading the rules could not answer it. Running them can, and
 *   `a large batched write` below is that answer.
 *
 * ## Running it
 *
 * Needs the Firestore emulator, which needs a **JDK 21 or newer** — firebase-tools 15
 * refuses to start on anything older, and the JDK 17 that Gradle downloads for the Android
 * build does not qualify, so a machine that builds the APK can still be unable to run this:
 *
 *     npx firebase emulators:start --only firestore --project ddetect-rules-test
 *     npx vitest run tests/firestore-rules.test.ts
 *
 * Without it every case here is skipped and the reason is printed once. That is deliberate
 * — a contributor with no Java still gets a green suite — but a skipped security test
 * proves nothing, so CI must run the emulator. `tests/firestore-rules-shape.test.ts` is
 * the companion that always runs and needs no emulator.
 */

const HOST = '127.0.0.1';
const PORT = 8080;
const PROJECT_ID = 'ddetect-rules-test';

/** Every collection the workspace stores, which is also everything `clear()` walks. */
const CASE_SCOPED = [
  'claims',
  'events',
  'evidence',
  'relationships',
  'analysisResults',
  'processingJobs',
  'aiSuggestions',
  'caseAnalyses',
  'auditLogs',
] as const;

const ALICE = 'user_alice';
const BOB = 'user_bob';
const CASE_ID = 'case_alpha';

/**
 * The emulator answers `GET /` with a plain 200 once it is listening. Probed rather than
 * assumed because `initializeTestEnvironment` against a closed port fails slowly and with
 * a message about the project, not about the port.
 */
async function emulatorReachable(): Promise<boolean> {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const available = await emulatorReachable();
if (!available) {
  console.warn(
    `\n  [firestore-rules] Firestore emulator not reachable on ${HOST}:${PORT} — security rule ` +
      `tests skipped.
  Start it with: npx firebase emulators:start --only firestore
  ` +
      `Needs a JDK 21+ on PATH. firebase-tools 15 refuses anything older, and the JDK 17 ` +
      `Gradle
  downloads for the Android build does not qualify — so a machine that ` +
      `builds the APK
  can still be unable to run these.
`,
  );
}

/**
 * A document body carrying only the fields the rules actually read. The rules do not
 * validate the record schema — `src/domain/models.ts` does, on the way in — so a fuller
 * fixture would test nothing extra and would rot against every schema change.
 *
 * `docId` is a parameter rather than a constant because `/evidence` requires
 * `data.id == docId`, and this helper used to answer `id: 'doc_1'` for every evidence
 * body it built. Two consequences, and the second is the worse one. `carries the whole
 * workspace across in one batch` wrote that body to `migrated_evidence` and asserted the
 * batch *succeeded*, which it cannot — so the handover test could never have passed. And
 * `refuses a %s with a missing or empty caseId` did pass for evidence, but on the id
 * mismatch rather than on the missing `caseId` it names: a green result for a rule it was
 * not exercising. Threading the key through means a fixture states the document it is,
 * and a test that expects a refusal gets it from the rule it is about.
 */
function body(collection: string, ownerId: string, docId: string, extra: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = { id: docId, ownerId, caseId: CASE_ID, ...extra };
  if (collection === 'evidence') return { kind: 'TEXT', sha256: null, storagePath: null, ...base };
  if (collection === 'relationships') return { origin: 'USER', ...base };
  if (collection === 'aiSuggestions') return { status: 'SUGGESTED', reviewedAt: null, ...base };
  if (collection === 'auditLogs') return { actorId: ownerId, action: 'CASE_CREATED', ...base };
  return base;
}

describe.skipIf(!available)('firestore security rules', () => {
  let env: RulesTestEnvironment;

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { host: HOST, port: PORT, rules: readFileSync('rules/firestore.rules', 'utf8') },
    });
  });

  afterAll(async () => env?.cleanup());

  beforeEach(async () => {
    await env.clearFirestore();
    // Seeded past the rules: these tests are about what a client may do to data that
    // exists, and seeding through the rules would make every test depend on create.
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'cases', CASE_ID), { id: CASE_ID, ownerId: ALICE, title: 'Alpha' });
      await setDoc(doc(db, 'users', ALICE), { id: ALICE, ownerId: ALICE });
      for (const name of CASE_SCOPED) {
        await setDoc(doc(db, name, `${name}_doc`), body(name, ALICE, `${name}_doc`));
      }
      await setDoc(doc(db, 'seals', 'seal_1'), { id: 'seal_1', ownerId: ALICE, caseId: CASE_ID });
    });
  });

  const alice = () => env.authenticatedContext(ALICE).firestore();
  const bob = () => env.authenticatedContext(BOB).firestore();

  // -------------------------------------------------------------------------
  // The boundary these rules exist for
  // -------------------------------------------------------------------------

  describe('one user reaching another user’s data', () => {
    it.each([...CASE_SCOPED, 'cases', 'seals'])('refuses %s to a stranger, in every verb', async (name) => {
      const id = name === 'cases' ? CASE_ID : name === 'seals' ? 'seal_1' : `${name}_doc`;
      const ref = doc(bob(), name, id);

      await assertFails(getDoc(ref));
      await assertFails(deleteDoc(ref));
      // Not merely "cannot overwrite as Alice" — cannot take the document either, which is
      // the write that would otherwise convert a foreign record into one of Bob's own.
      await assertFails(setDoc(ref, body(name, BOB, id)));
    });

    it('refuses an unauthenticated read outright', async () => {
      await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'cases', CASE_ID)));
    });

    it('refuses handing a document to someone else', async () => {
      await assertFails(updateDoc(doc(alice(), 'claims', 'claims_doc'), { ownerId: BOB }));
      await assertFails(updateDoc(doc(alice(), 'cases', CASE_ID), { ownerId: BOB }));
    });
  });

  // -------------------------------------------------------------------------
  // Erasure — the regression that motivated this file
  // -------------------------------------------------------------------------

  describe('erasing an account', () => {
    it.each([...CASE_SCOPED, 'seals'])('lets the owner delete their own %s', async (name) => {
      const id = name === 'seals' ? 'seal_1' : `${name}_doc`;
      await assertSucceeds(deleteDoc(doc(alice(), name, id)));
    });

    it('lets the owner delete their case and their profile', async () => {
      await assertSucceeds(deleteDoc(doc(alice(), 'cases', CASE_ID)));
      await assertSucceeds(deleteDoc(doc(alice(), 'users', ALICE)));
    });

    it('completes in the order `clear()` actually walks, cases first', async () => {
      // The exact sequence that used to destroy the cases and then stop. It has to work
      // whichever collection goes first, because a record whose case is already gone must
      // still be removable — that was the state users were being left in.
      await assertSucceeds(deleteDoc(doc(alice(), 'cases', CASE_ID)));
      for (const name of CASE_SCOPED) {
        await assertSucceeds(deleteDoc(doc(alice(), name, `${name}_doc`)));
      }
      await assertSucceeds(deleteDoc(doc(alice(), 'users', ALICE)));
    });

    it('still lets an orphaned record be updated once its case is gone', async () => {
      await assertSucceeds(deleteDoc(doc(alice(), 'cases', CASE_ID)));
      // `hasCaseId()` used to resolve the case document, so this was permanently refused —
      // the record could be neither repaired nor removed for the life of the project.
      await assertSucceeds(updateDoc(doc(alice(), 'claims', 'claims_doc'), { statement: 'edited' }));
    });
  });

  // -------------------------------------------------------------------------
  // Batch size — the question that could not be answered by reading
  // -------------------------------------------------------------------------

  describe('a large batched write', () => {
    it('commits far more case-scoped documents than the 20 document-access ceiling', async () => {
      const db = alice();
      const batch = writeBatch(db);
      // 90 writes spread over the collections a real analysis run touches. Comfortably
      // past 20, and past it in a single evaluation rather than 90 separate requests.
      for (let index = 0; index < 30; index += 1) {
        batch.set(doc(db, 'analysisResults', `finding_${index}`), body('analysisResults', ALICE, `finding_${index}`));
        batch.set(doc(db, 'auditLogs', `audit_${index}`), body('auditLogs', ALICE, `audit_${index}`));
        batch.set(doc(db, 'processingJobs', `job_${index}`), body('processingJobs', ALICE, `job_${index}`));
      }
      await assertSucceeds(batch.commit());
    });

    it('refuses the whole batch if one document in it is foreign', async () => {
      // The property that makes a batch safe to use: it is all-or-nothing, so a single
      // rejected write cannot leave the case half-updated.
      const db = alice();
      const batch = writeBatch(db);
      batch.set(doc(db, 'claims', 'mine'), body('claims', ALICE, 'mine'));
      batch.set(doc(db, 'claims', 'theirs'), body('claims', BOB, 'theirs'));
      await assertFails(batch.commit());
      await assertFails(getDoc(doc(bob(), 'claims', 'mine')));
    });
  });

  // -------------------------------------------------------------------------
  // Sign-in handover
  // -------------------------------------------------------------------------

  describe('the workspace handover at sign-in', () => {
    it('accepts a suggestion that was already reviewed before the account existed', async () => {
      // `buildMigrationPlan` re-writes every local record under the new owner id, carrying
      // each suggestion's existing verdict. A create-time `status == 'SUGGESTED'` refused
      // this one, and because the handover is a single batch the refusal discarded the
      // entire local workspace for anyone who had ever accepted a suggestion.
      await assertSucceeds(
        setDoc(doc(alice(), 'aiSuggestions', 'migrated'),
          body('aiSuggestions', ALICE, 'migrated', { status: 'ACCEPTED', reviewedAt: 1_700_000_000_000 })),
      );
    });

    it('accepts a link the machine drew, which every case on the device rode on', async () => {
      // `relationshipSchema` allows USER, RULE and AI, and `buildMigrationPlan` re-writes
      // each record's origin unchanged. Create used to require `origin == 'USER'`, so a
      // single link inferred by the rule engine or accepted from a model was refused — and
      // the handover being one batch, the refusal discarded the whole local workspace with
      // it. Latent only because all three call sites of `linkEntities` happen to pass
      // 'USER' today, which is one argument away from untrue.
      for (const origin of ['USER', 'RULE', 'AI']) {
        await assertSucceeds(
          setDoc(doc(alice(), 'relationships', `link_${origin}`),
            body('relationships', ALICE, `link_${origin}`, { origin })),
        );
      }
    });

    it('still refuses an origin the app has no weight for', async () => {
      // The app reads this field to decide how much an edge counts for. A value it does
      // not recognise has no defined weight, so it is not storable.
      await assertFails(
        setDoc(doc(alice(), 'relationships', 'link_odd'),
          body('relationships', ALICE, 'link_odd', { origin: 'IMPORTED' })),
      );
    });

    it('still refuses a verdict with no review behind it', async () => {
      // The property the old rule was reaching for, stated directly: nothing enters the
      // case as accepted unless a review was recorded.
      await assertFails(
        setDoc(doc(alice(), 'aiSuggestions', 'forged'),
          body('aiSuggestions', ALICE, 'forged', { status: 'ACCEPTED', reviewedAt: null })),
      );
    });

    it('carries the whole workspace across in one batch', async () => {
      const db = alice();
      const batch = writeBatch(db);
      for (const name of CASE_SCOPED) {
        batch.set(doc(db, name, `migrated_${name}`), body(name, ALICE, `migrated_${name}`));
      }
      batch.set(doc(db, 'cases', 'case_migrated'), { id: 'case_migrated', ownerId: ALICE });
      // The record the batch used to die on, in the batch.
      batch.set(doc(db, 'relationships', 'migrated_inferred'),
        body('relationships', ALICE, 'migrated_inferred', { origin: 'RULE' }));
      await assertSucceeds(batch.commit());
    });
  });

  // -------------------------------------------------------------------------
  // What must stay impossible
  // -------------------------------------------------------------------------

  describe('history that cannot be rewritten', () => {
    it.each(['auditLogs', 'processingJobs', 'caseAnalyses'])('refuses an update to %s', async (name) => {
      // Removal is permitted and detectable — it breaks the seal's hash chain. Editing in
      // place is the one that would lie while looking intact, so it stays refused.
      await assertFails(updateDoc(doc(alice(), name, `${name}_doc`), { note: 'rewritten' }));
    });

    it('refuses rewriting a machine-derived link as a person’s assertion', async () => {
      // The direction that matters. Laundering a model's guess into a user's statement is
      // the one edit worth forbidding here, inside a product whose whole claim is that it
      // says where each value came from. Everything else about the link stays editable.
      await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), 'relationships', 'inferred'),
          body('relationships', ALICE, 'inferred', { origin: 'AI' }));
      });
      await assertFails(updateDoc(doc(alice(), 'relationships', 'inferred'), { origin: 'USER' }));
      await assertSucceeds(updateDoc(doc(alice(), 'relationships', 'inferred'), { note: 'reviewed' }));
    });

    it('lets a retried handover re-write the records it already wrote', async () => {
      // Append-only collections answer `unchanged()` rather than `false`. The handover
      // preserves record ids so it is idempotent, and a retry of a batch whose
      // acknowledgement was lost is therefore an *update* — refused outright by `if false`,
      // which left the case stuck on the device forever. Identical bytes may be re-written;
      // a single changed one may not.
      for (const name of ['auditLogs', 'processingJobs', 'caseAnalyses']) {
        await assertSucceeds(setDoc(doc(alice(), name, `${name}_doc`), body(name, ALICE, `${name}_doc`)));
        await assertFails(setDoc(doc(alice(), name, `${name}_doc`),
          body(name, ALICE, `${name}_doc`, { note: 'rewritten' })));
      }
    });

    it('refuses a client-written seal, which is the entire value of one', async () => {
      await assertFails(
        setDoc(doc(alice(), 'seals', 'forged'), { id: 'forged', ownerId: ALICE, caseId: CASE_ID }),
      );
      await assertFails(updateDoc(doc(alice(), 'seals', 'seal_1'), { signature: 'x' }));
    });

    it('refuses a client-written SEAL_CREATED audit entry', async () => {
      await assertFails(
        setDoc(doc(alice(), 'auditLogs', 'fake_seal'),
          body('auditLogs', ALICE, 'fake_seal', { action: 'SEAL_CREATED' })),
      );
    });
  });

  describe('evidence identity', () => {
    beforeEach(async () => {
      await env.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), 'evidence', 'stored'),
          body('evidence', ALICE, 'stored', { sha256: 'abc123', storagePath: 'users/alice/original.pdf' }));
      });
    });

    it('refuses to repoint a stored record at different bytes', async () => {
      // The digest is what duplicate detection and the audit chain rest on. A record whose
      // file quietly became a different file would be evidence tampering by bug.
      await assertFails(updateDoc(doc(alice(), 'evidence', 'stored'), { sha256: 'deadbeef' }));
      await assertFails(updateDoc(doc(alice(), 'evidence', 'stored'), { storagePath: 'elsewhere' }));
    });

    it('allows the fields the app genuinely edits', async () => {
      await assertSucceeds(updateDoc(doc(alice(), 'evidence', 'stored'), { title: 'Renamed' }));
    });

    it('refuses a note that claims a stored original', async () => {
      await assertFails(
        setDoc(doc(alice(), 'evidence', 'note_1'),
          body('evidence', ALICE, 'note_1', { kind: 'NOTE', sha256: 'abc', storagePath: 'x' })),
      );
    });

    it('refuses a document whose id disagrees with its own key', async () => {
      await assertFails(
        setDoc(doc(alice(), 'evidence', 'key_1'), body('evidence', ALICE, 'key_1', { id: 'different' })),
      );
    });
  });

  describe('records that name no case', () => {
    it.each(CASE_SCOPED)('refuses a %s with a missing or empty caseId', async (name) => {
      const db = alice();
      await assertFails(setDoc(doc(db, name, 'nocase'), { ...body(name, ALICE, 'nocase'), caseId: '' }));
      const { caseId: _dropped, ...withoutCase } = body(name, ALICE, 'nocase2') as Record<string, unknown>;
      await assertFails(setDoc(doc(db, name, 'nocase2'), withoutCase));
    });
  });

  describe('size limits', () => {
    const huge = (length: number) => 'x'.repeat(length);

    it('refuses a case title no person typed', async () => {
      await assertFails(
        setDoc(doc(alice(), 'cases', 'case_big'), { id: 'case_big', ownerId: ALICE, title: huge(2001) }),
      );
      await assertSucceeds(
        setDoc(doc(alice(), 'cases', 'case_ok'), { id: 'case_ok', ownerId: ALICE, title: huge(2000) }),
      );
    });

    it('refuses an audit summary that is really a payload', async () => {
      await assertFails(
        setDoc(doc(alice(), 'auditLogs', 'audit_big'),
          body('auditLogs', ALICE, 'audit_big', { summary: huge(4001) })),
      );
    });

    it('leaves alone the field that legitimately holds a whole document', async () => {
      // `evidence.extraction` carries the source text of a scanned file and is deliberately
      // uncapped: a long document approaches Firestore's 1 MiB ceiling for real reasons, and
      // a limit here would refuse the product's central use rather than an abuse of it.
      await assertSucceeds(
        setDoc(doc(alice(), 'evidence', 'long_doc'),
          body('evidence', ALICE, 'long_doc', { extraction: { sourceText: huge(200_000) } })),
      );
    });

    it('accepts a document that simply does not carry the bounded field', async () => {
      // The trap these limits had to avoid, and the reason they read through
      // `get(key, default)`. Rules have no null-safe access: `data.description.size() < N`
      // on a document with no `description` is an evaluation error, and an error is a
      // denial. `firebase-repository.ts` commits records with `batch.set()` and no merge,
      // having stripped every undefined key on the way, so a field that is optional in the
      // schema really is absent from the document — and a bounds check written the obvious
      // way would refuse that write together with everything batched alongside it.
      await assertSucceeds(
        setDoc(doc(alice(), 'cases', 'case_bare'), { id: 'case_bare', ownerId: ALICE }),
      );
      await assertSucceeds(
        setDoc(doc(alice(), 'claims', 'claim_bare'),
          { id: 'claim_bare', ownerId: ALICE, caseId: CASE_ID }),
      );
    });
  });

  describe('collections nobody declared', () => {
    it('refuses a path with no rule of its own', async () => {
      await assertFails(setDoc(doc(alice(), 'somethingNew', 'x'), { ownerId: ALICE }));
    });
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { WORKSPACE_COLLECTIONS } from '@data/repository';

/**
 * `rules/firestore.rules` read as text, checked for one specific trap.
 *
 * ## Why a test that reads a policy file instead of running it
 *
 * `tests/firestore-rules.test.ts` executes these rules properly, against the emulator, and
 * is the real coverage. It also needs a JDK, so on a machine without one it skips — and a
 * security test that silently skips is exactly where a regression walks back in.
 *
 * What is checked here is not "are the rules correct", which text cannot tell you. It is a
 * single, mechanical, high-consequence property that the rules language makes very easy to
 * get wrong and impossible to notice:
 *
 * > `allow write` is `create, update, delete` together. Every ownership predicate in this
 * > project reads `request.resource.data.ownerId` — and on a delete there *is* no
 * > `request.resource`. So `allow write: if <predicate about the incoming document>`
 * > reliably grants create and update while silently refusing every delete.
 *
 * That is not hypothetical. It is what `claims` and `events` said, and combined with
 * `allow delete: if false` on seven other collections it meant "Erase everything" deleted
 * the user's cases and was then refused on everything else — destroying their work while
 * retaining their evidence, audit history, display name and email in Firestore forever.
 * Nothing in the app, the types or the emulator-less test suite could see it.
 *
 * The collection list is imported from `@data/repository` rather than written out here, so
 * a collection added to the workspace without a matching delete rule fails this test
 * rather than waiting to be discovered by the first user who asks to be forgotten.
 */

const SOURCE = readFileSync('rules/firestore.rules', 'utf8');

/**
 * Comments stripped before parsing.
 *
 * Not fussiness: the prose in that file discusses `allow write` at length, and a scan that
 * counts those sentences reports failures in the very documentation explaining the fix.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The `allow` verbs granted inside each `match /<collection>/{...}` block. */
function grantsByCollection(text: string): Map<string, { verb: string; condition: string }[]> {
  const found = new Map<string, { verb: string; condition: string }[]>();
  // The wildcard is consumed as part of the opener — `match /claims/{docId} {` has two
  // braces, and anchoring on the first one scans `{docId}` as though it were the block.
  // That parses cleanly, finds no `allow` anywhere, and makes every check below pass by
  // examining nothing. A parser for a security test failing open is the worst shape it
  // could take, so the block is located explicitly rather than by the nearest brace.
  const opener = /match\s+\/(\w+)\/\{[^}]*\}\s*\{/g;

  for (let hit = opener.exec(text); hit; hit = opener.exec(text)) {
    const name = hit[1]!;
    // Scan forward from the block's opening brace counting depth, so a nested block
    // cannot end the scan early and a missing brace cannot run past the file.
    const start = hit.index + hit[0].length - 1;
    let depth = 0;
    let end = start;
    for (; end < text.length; end += 1) {
      if (text[end] === '{') depth += 1;
      else if (text[end] === '}' && (depth -= 1) === 0) break;
    }

    const grants: { verb: string; condition: string }[] = [];
    const allow = /allow\s+([\w\s,]+?)\s*:\s*if\s+([\s\S]*?);/g;
    const block = text.slice(start, end);
    for (let line = allow.exec(block); line; line = allow.exec(block)) {
      for (const verb of line[1]!.split(',')) {
        grants.push({ verb: verb.trim(), condition: line[2]!.replace(/\s+/g, ' ').trim() });
      }
    }
    found.set(name, grants);
  }
  return found;
}

const rules = withoutComments(SOURCE);
const grants = grantsByCollection(rules);

describe('the shape of the security rules', () => {
  it('parsed something, so the checks below are not passing over an empty read', () => {
    // Every other assertion here is of the form "nothing in the rules does X". All of them
    // hold trivially if the parser returned nothing, which is precisely what happened on
    // the first run of this file. This is the check that the checks are looking at rules.
    expect(grants.size).toBeGreaterThanOrEqual(WORKSPACE_COLLECTIONS.length);
    const total = [...grants.values()].reduce((sum, list) => sum + list.length, 0);
    expect(total).toBeGreaterThan(30);
    expect(grants.get('cases')?.map((grant) => grant.verb).sort())
      .toEqual(['create', 'delete', 'read', 'update']);
  });

  it('declares a rule for every collection the workspace stores', () => {
    // `clear()` walks exactly this list. A collection missing from the rules is denied by
    // the catch-all at the bottom of the file, which is safe but means its documents can
    // never be written *or* removed.
    for (const collection of WORKSPACE_COLLECTIONS) {
      expect(grants.has(collection), `no match block for /${collection}`).toBe(true);
    }
  });

  it('never grants `write`, because `write` includes a delete the predicate cannot pass', () => {
    // The default-deny at the foot of the file is the one legitimate `write`, and it grants
    // nothing: `if false` has no predicate to evaluate against a missing `request.resource`.
    for (const [collection, allowed] of grants) {
      for (const { verb, condition } of allowed) {
        if (verb !== 'write') continue;
        expect(
          condition,
          `/${collection} grants \`write\`, which silently refuses every delete unless the ` +
            `condition is \`false\`. Split it into \`create, update\` and an explicit \`delete\`.`,
        ).toBe('false');
      }
    }
  });

  it('lets the owner delete their own document in every stored collection', () => {
    // The assertion that would have caught the erasure bug on a laptop with no Java.
    for (const collection of WORKSPACE_COLLECTIONS) {
      const deletes = (grants.get(collection) ?? []).filter((grant) => grant.verb === 'delete');
      expect(deletes.length, `/${collection} declares no delete rule`).toBeGreaterThan(0);
      for (const { condition } of deletes) {
        expect(
          condition,
          `/${collection} refuses delete, so "Erase everything" stops there and leaves the ` +
            `user's data in Firestore permanently.`,
        ).not.toBe('false');
      }
    }
  });

  it('keeps the profile deletable too, since it holds the display name and email', () => {
    const deletes = (grants.get('users') ?? []).filter((grant) => grant.verb === 'delete');
    expect(deletes.length).toBeGreaterThan(0);
    for (const { condition } of deletes) expect(condition).not.toBe('false');
  });

  it('resolves no documents while authorising a write', () => {
    // Firestore permits 20 document-access calls per batched write and this project
    // batches up to 400 changes, so one lookup per write puts an ordinary analysis run
    // over a ceiling that refuses the batch in full. Ownership is already pinned by
    // `ownerId` on the document itself, which is the entire reason for that field.
    //
    // What is being looked for is the *document-resolving* form, which is always a bare
    // call on a path: `get(/databases/$(db)/documents/cases/$(id))`. A plain substring
    // scan for `get(` also matches `request.resource.data.get(key, default)`, which reads
    // a field out of a map already in scope and resolves nothing — the size limits above
    // are built on it, because rules have no null-safe access and a bounds check that
    // reads an absent field directly denies the write instead of permitting it. Matching
    // the method form would fail this test for a call that cannot cost a lookup, so the
    // pattern requires the name to start a token.
    const helpers = rules.slice(0, rules.indexOf('match /users/'));
    for (const call of ['get', 'getAfter', 'exists', 'existsAfter']) {
      const resolving = new RegExp(String.raw`(?<![.\w])${call}\s*\(`);
      expect(resolving.test(helpers), `a rule helper calls ${call}(…) on a document path`)
        .toBe(false);
    }

    // And the scan still sees the hazard it was written for, rather than passing because
    // the pattern got too clever. A test that can no longer fail is not a test.
    expect(/(?<![.\w])get\s*\(/.test('return get(/databases/$(db)/documents/x/$(y)).data;'))
      .toBe(true);
    expect(/(?<![.\w])get\s*\(/.test("return data.get('title', '').size() < 10;")).toBe(false);
  });

  it('refuses updates to the collections that record what happened', () => {
    // Append-only means not rewritable. Deletion is a separate act: it breaks the seal's
    // hash chain and is reported, which is why it is allowed and editing is not.
    //
    // Two conditions express that, and the difference between them is the point. `false`
    // refuses the update verb. `unchanged()` — `ownsExisting() && request.resource.data ==
    // resource.data`, deep equality over the whole document — refuses every update that
    // changes anything, which is the property the verb was standing in for. It is granted
    // because `if false` broke the device handover: `buildMigrationPlan` preserves record
    // ids so a retry rewrites the same records, and rewriting an existing record is an
    // update, so a handover whose acknowledgement was lost could never be completed.
    //
    // Anything else fails. This test previously read `.toBe('false')`, which pinned the
    // implementation rather than the property and so reported a correct fix as a
    // regression; the allow-list is small and every entry is spelled out on purpose,
    // because a predicate that merely looks restrictive does not belong on this list.
    const refusesEveryChange = ['false', 'unchanged()'];
    for (const collection of ['auditLogs', 'processingJobs', 'caseAnalyses', 'seals']) {
      const updates = (grants.get(collection) ?? []).filter((grant) => grant.verb === 'update');
      expect(updates.length, `/${collection} declares no update rule`).toBeGreaterThan(0);
      for (const { condition } of updates) {
        expect(
          refusesEveryChange,
          `/${collection} is a record of what happened and must not be editable. \`${condition}\` ` +
            `is neither \`false\` nor \`unchanged()\`, so it permits some edit to a stored entry.`,
        ).toContain(condition);
      }
    }
  });

  it('lets no client create a seal', () => {
    // A seal's only value is that the device could not have produced it.
    const creates = (grants.get('seals') ?? []).filter((grant) => grant.verb === 'create');
    expect(creates.length).toBeGreaterThan(0);
    for (const { condition } of creates) expect(condition).toBe('false');
  });

  it('ends with a catch-all deny', () => {
    expect(rules.replace(/\s+/g, ' ')).toContain('match /{document=**} { allow read, write: if false; }');
  });
});

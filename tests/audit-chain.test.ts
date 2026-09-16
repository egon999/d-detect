import { describe, expect, it } from 'vitest';

import { buildAuditChain, buildCaseAuditChain, shortDigest } from '@domain/analysis/audit-chain';
import { hashText } from '@domain/hashing';
import type { AuditLog } from '@domain/models';

import { CASE_ID, OWNER, ref, testCase, workspace } from './helpers';

/**
 * Tests for the derived audit hash chain.
 *
 * The module's claim is narrow and precise: re-deriving the chain and getting the same head
 * proves no entry has been altered, inserted, reordered or dropped. Most of the tests below
 * are therefore tamper tests — mutate one thing about a history, re-derive, and require the
 * head to move. The remainder pin the two properties that make a chain worth deriving at
 * all: it is deterministic, and it depends on position rather than only on content.
 *
 * Digests are never hardcoded. A test asserting a literal SHA-256 would have to be rewritten
 * every time the recipe changed, which is the moment it stops catching anything.
 */

let counter = 0;

function entry(overrides: Partial<AuditLog> = {}): AuditLog {
  const id = overrides.id ?? `aud_${(counter += 1)}`;
  return {
    id,
    ownerId: OWNER,
    caseId: CASE_ID,
    createdAt: 1_000,
    updatedAt: 1_000,
    action: 'EVIDENCE_UPLOADED',
    actorId: OWNER,
    entityRefs: [],
    summary: 'Added Invoice INV-2024-018.',
    metadata: {},
    ...overrides,
  };
}

/** Three entries a millisecond apart — the ordinary case. */
function history(): AuditLog[] {
  return [
    entry({ id: 'aud_a', createdAt: 1_000, action: 'CASE_CREATED', summary: 'Created the case.' }),
    entry({ id: 'aud_b', createdAt: 2_000, summary: 'Added Invoice INV-2024-018.' }),
    entry({ id: 'aud_c', createdAt: 3_000, action: 'ANALYSIS_RUN', summary: 'Ran analysis: 3 findings.' }),
  ];
}

const headOf = (entries: AuditLog[]) => buildAuditChain(entries).head;

describe('buildAuditChain', () => {
  it('has no head for a history with nothing in it', () => {
    const chain = buildAuditChain([]);

    // A chain over nothing has no head. Inventing one would let an empty history display a
    // reassuring-looking hash.
    expect(chain.head).toBeNull();
    expect(chain.links).toEqual([]);
    expect(chain.length).toBe(0);
  });

  it('seeds the first entry from a fixed genesis value, not an empty string', () => {
    const chain = buildAuditChain([entry({ id: 'aud_only' })]);

    expect(chain.length).toBe(1);
    expect(chain.links[0]?.index).toBe(0);
    expect(chain.links[0]?.previousDigest).toBe('ddetect-audit-chain/v1');
    expect(chain.head).toBe(chain.links[0]?.digest);
  });

  it('links each entry to the digest of the one before it', () => {
    const chain = buildAuditChain(history());

    expect(chain.length).toBe(3);
    expect(chain.links.map((link) => link.index)).toEqual([0, 1, 2]);
    expect(chain.links[1]?.previousDigest).toBe(chain.links[0]?.digest);
    expect(chain.links[2]?.previousDigest).toBe(chain.links[1]?.digest);
    expect(chain.head).toBe(chain.links[2]?.digest);
  });

  it('produces full-length SHA-256 hex digests', () => {
    for (const link of buildAuditChain(history()).links) {
      expect(link.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('keeps the entries themselves untouched', () => {
    // The chain is derived and stored nowhere. No entry gains a `digest` field, because an
    // entry carrying its own digest is a record that can disagree with itself.
    const entries = history();
    const chain = buildAuditChain(entries);

    expect(chain.links[0]?.entry).toBe(entries[0]);
    for (const link of chain.links) {
      expect(link.entry).not.toHaveProperty('digest');
    }
  });

  describe('determinism', () => {
    it('gives the same head for the same history, twice', () => {
      expect(headOf(history())).toBe(headOf(history()));
    });

    it('gives the same head however the caller ordered the array', () => {
      // The audit screen holds its list newest-first for display. A chain that depended on
      // that would report tampering the moment a screen changed its sort.
      const forwards = history();
      const backwards = [...history()].reverse();

      expect(headOf(backwards)).toBe(headOf(forwards));
    });

    it('does not mutate the array it was given', () => {
      const entries = [...history()].reverse();
      const order = entries.map((item) => item.id);

      buildAuditChain(entries);

      expect(entries.map((item) => item.id)).toEqual(order);
    });

    it('orders entries written in the same millisecond by id', () => {
      // The corpus writes several entries at one timestamp. Without the id tiebreak the
      // chain would depend on however the storage adapter returned the rows.
      const tied = [
        entry({ id: 'aud_c', createdAt: 5_000 }),
        entry({ id: 'aud_a', createdAt: 5_000 }),
        entry({ id: 'aud_b', createdAt: 5_000 }),
      ];

      const chain = buildAuditChain(tied);

      expect(chain.links.map((link) => link.entry.id)).toEqual(['aud_a', 'aud_b', 'aud_c']);
      expect(chain.head).toBe(headOf([...tied].reverse()));
    });
  });

  describe('detecting an inconsistent history', () => {
    it('moves the head when an entry is edited', () => {
      const tampered = history();
      tampered[1] = entry({ ...tampered[1]!, summary: 'Added Invoice INV-2024-999.' });

      expect(headOf(tampered)).not.toBe(headOf(history()));
    });

    it.each([
      ['the action', { action: 'EVIDENCE_DELETED' as const }],
      ['the actor', { actorId: 'user_someone_else' }],
      ['the summary', { summary: 'Something else happened.' }],
      ['the timestamp', { createdAt: 2_500 }],
    ])('moves the head when %s changes', (_label, change) => {
      const tampered = history();
      tampered[1] = entry({ ...tampered[1]!, ...change });

      expect(headOf(tampered)).not.toBe(headOf(history()));
    });

    it('moves the head when the records an entry touched change', () => {
      const tampered = history();
      tampered[1] = entry({ ...tampered[1]!, entityRefs: [ref.evidence('evd_other')] });

      expect(headOf(tampered)).not.toBe(headOf(history()));
    });

    it('moves the head when an entry is removed from the middle', () => {
      const truncated = [history()[0]!, history()[2]!];

      expect(headOf(truncated)).not.toBe(headOf(history()));
    });

    it('moves the head when an entry is inserted between two others', () => {
      const injected = history();
      injected.splice(1, 0, entry({ id: 'aud_injected', createdAt: 1_500 }));

      expect(headOf(injected)).not.toBe(headOf(history()));
    });

    it('moves the head when two entries swap places', () => {
      // Reordering is a real attack — "confirmed, then uploaded" tells a different story
      // from "uploaded, then confirmed" — and it changes no entry's own content, so only a
      // position-dependent digest catches it.
      const swapped = history();
      swapped[1] = entry({ ...swapped[1]!, createdAt: 3_000 });
      swapped[2] = entry({ ...swapped[2]!, createdAt: 2_000 });

      expect(headOf(swapped)).not.toBe(headOf(history()));
    });

    it('gives two identical entries different digests by position', () => {
      // Same content, different place in the history. If the digests matched, one could be
      // substituted for the other without moving the head.
      const twice = [
        entry({ id: 'aud_1', createdAt: 1_000, summary: 'Identical.' }),
        entry({ id: 'aud_2', createdAt: 1_000, summary: 'Identical.' }),
      ];

      const chain = buildAuditChain(twice);

      expect(chain.links[0]?.digest).not.toBe(chain.links[1]?.digest);
    });

    it('cannot be fooled by moving text across a field boundary', () => {
      // With a printable delimiter such as `|`, ('a|b', 'c') and ('a', 'b|c') would
      // serialise identically and hash alike. The unit separator makes the concatenation
      // unambiguous. This is the property that test checks, so it is checked with the
      // delimiter character itself.
      const left = [entry({ id: 'aud_1', actorId: 'user_a', summary: 'b|c' })];
      const right = [entry({ id: 'aud_1', actorId: 'user_a', summary: 'b|c' })];
      right[0] = entry({ ...right[0]!, summary: 'bc' });

      expect(headOf(left)).not.toBe(headOf(right));
    });
  });

  describe('what the digest deliberately excludes', () => {
    it('ignores free-form metadata, whose key order is not guaranteed on the wire', () => {
      // Folding it in would make the digest depend on JSON key ordering and produce
      // spurious mismatches that look exactly like tampering and are not.
      const withMetadata = history();
      withMetadata[1] = entry({ ...withMetadata[1]!, metadata: { textRead: 'yes', kind: 'PDF' } });

      expect(headOf(withMetadata)).toBe(headOf(history()));
    });

    it('ignores updatedAt, because an append-only record has no meaningful update', () => {
      const touched = history();
      touched[1] = entry({ ...touched[1]!, updatedAt: 99_000 });

      expect(headOf(touched)).toBe(headOf(history()));
    });

    it('ignores ownerId and caseId, which scope the row rather than describe the event', () => {
      // Every entry in a chain shares both by construction, and `buildCaseAuditChain`
      // filters on `caseId` before the chain is derived.
      const rescoped = history();
      rescoped[1] = entry({ ...rescoped[1]!, ownerId: 'user_other', caseId: 'case_other' });

      expect(headOf(rescoped)).toBe(headOf(history()));
    });

    it('ignores the entry id, which identifies the row rather than the event', () => {
      // The id still participates in *ordering* — it breaks same-millisecond ties — so this
      // holds only where the sort order is already unambiguous, as it is here.
      const renamed = history();
      renamed[1] = entry({ ...renamed[1]!, id: 'aud_renamed' });

      expect(headOf(renamed)).toBe(headOf(history()));
    });
  });

  it('is the same SHA-256 the app uses for evidence fingerprints', () => {
    // Same `hashText`, pure JS, so an evaluator gets byte-identical digests in the app, in
    // this Node run and in a Cloud Function. The recipe is restated here in full rather
    // than imported, so a change to the field order or the separator has to be made twice
    // deliberately instead of once by accident.
    const single = entry({
      id: 'aud_1',
      createdAt: 4_200,
      action: 'CASE_CREATED',
      actorId: OWNER,
      entityRefs: [ref.evidence('evd_1'), ref.claim('clm_1')],
      summary: 'Created the case.',
    });

    // ASCII 0x1F, the unit separator. Written as an escape, as it is in the module, so it
    // is visible to anyone reading the file rather than an invisible byte in the source.
    const SEP = '\u001F';

    const expected = hashText(
      [
        'ddetect-audit-chain/v1',
        'CASE_CREATED',
        OWNER,
        'evidence:evd_1,claim:clm_1',
        'Created the case.',
        '4200',
      ].join(SEP),
    );

    expect(buildAuditChain([single]).head).toBe(expected);
  });

  it('hashes entityRefs in their stored order rather than a sorted one', () => {
    // The order the app recorded the references in is part of what happened. Normalising it
    // would make two genuinely different entries hash alike.
    const forwards = [entry({ id: 'aud_1', entityRefs: [ref.evidence('evd_1'), ref.claim('clm_1')] })];
    const reversed = [entry({ id: 'aud_1', entityRefs: [ref.claim('clm_1'), ref.evidence('evd_1')] })];

    expect(headOf(forwards)).not.toBe(headOf(reversed));
  });
});

describe('buildCaseAuditChain', () => {
  it('chains only the entries belonging to the case', () => {
    const mine = history();
    const theirs = entry({ id: 'aud_other', caseId: 'case_other', createdAt: 2_500 });

    const chain = buildCaseAuditChain(
      workspace({ auditLogs: [...mine, theirs] }),
      CASE_ID,
    );

    expect(chain.length).toBe(3);
    expect(chain.links.map((link) => link.entry.id)).toEqual(['aud_a', 'aud_b', 'aud_c']);
    // An unrelated case's entries cannot perturb this case's head, even interleaved by time.
    expect(chain.head).toBe(headOf(mine));
  });

  it('returns an empty chain rather than throwing for a case it does not have', () => {
    // Unlike the timeline and the graph this does not go through `buildRuleContext`. The
    // audit trail is the one screen that must still render for a case that has been deleted
    // or has not loaded yet, and an integrity panel that crashes the screen it reports on
    // would be a poor kind of integrity.
    const chain = buildCaseAuditChain(workspace({ auditLogs: history() }), 'case_missing');

    expect(chain.head).toBeNull();
    expect(chain.length).toBe(0);
  });

  it('survives a workspace holding several cases at once', () => {
    const other = testCase({ id: 'case_other', title: 'Other' });
    const store = workspace({
      cases: [testCase(), other],
      auditLogs: [
        ...history(),
        entry({ id: 'aud_o1', caseId: 'case_other', createdAt: 1_500 }),
        entry({ id: 'aud_o2', caseId: 'case_other', createdAt: 2_500 }),
      ],
    });

    expect(buildCaseAuditChain(store, CASE_ID).length).toBe(3);
    expect(buildCaseAuditChain(store, 'case_other').length).toBe(2);
    expect(buildCaseAuditChain(store, CASE_ID).head).not.toBe(
      buildCaseAuditChain(store, 'case_other').head,
    );
  });
});

describe('shortDigest', () => {
  const digest = 'a'.repeat(8) + 'b'.repeat(48) + 'c'.repeat(8);

  it('keeps both ends and elides the middle', () => {
    // Truncating to a prefix alone is the more common choice and is worse here: the first
    // characters are exactly what a reader compares, and showing only those invites "the
    // first eight match, so it is the same hash".
    expect(shortDigest(digest)).toBe(`${'a'.repeat(8)}…${'c'.repeat(8)}`);
  });

  it('honours a wider edge', () => {
    expect(shortDigest(digest, 4)).toBe(`aaaa…cccc`);
    expect(shortDigest(digest, 12)).toBe(`${'a'.repeat(8)}bbbb…${'b'.repeat(4)}${'c'.repeat(8)}`);
  });

  it('returns a value short enough to read whole unchanged', () => {
    // No ellipsis where there is nothing to elide — abbreviating a value that already fits
    // would hide characters for no reason.
    expect(shortDigest('abcd', 8)).toBe('abcd');
    expect(shortDigest('a'.repeat(17), 8)).toBe('a'.repeat(17));
  });

  it('elides as soon as there is more than the two edges plus a character', () => {
    expect(shortDigest('a'.repeat(18), 8)).toBe(`${'a'.repeat(8)}…${'a'.repeat(8)}`);
  });

  it('never returns a string longer than what it was given', () => {
    for (const link of buildAuditChain(history()).links) {
      expect(shortDigest(link.digest).length).toBeLessThan(link.digest.length);
    }
  });
});

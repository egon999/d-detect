/**
 * The upload queue's decisions, tested.
 *
 * Everything here guards against a batch upload quietly doing less than it said it did.
 * The failure this file exists to prevent: a user hands over ten files, eight are written,
 * and the screen says "done" — after which they read an analysis of eight documents
 * believing it covered ten. The counting is therefore pinned as tightly as the rules.
 */

import { describe, expect, it } from 'vitest';

import {
  describeReadiness,
  findDuplicate,
  planCommit,
  recomputeDuplicates,
  summariseCommit,
  titleFromFileName,
  type QueueItem,
} from '../src/features/evidence/upload-queue';

/** A queued file in its settled, committable state. Overridden per test. */
function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'q1',
    name: 'bill.pdf',
    uri: 'file:///bill.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    kind: 'PDF',
    sha256: 'a'.repeat(64),
    status: 'ready',
    stage: null,
    title: 'Bill',
    text: 'Total INR 100.00',
    textMethod: 'DETERMINISTIC',
    note: null,
    failure: null,
    needsManualText: false,
    image: null,
    scriptOffer: null,
    aiOffered: false,
    rereading: false,
    duplicate: null,
    link: null,
    ...overrides,
  };
}

describe('titleFromFileName', () => {
  it('strips one trailing extension', () => {
    expect(titleFromFileName('Mall Bill 12-05-2024.pdf')).toBe('Mall Bill 12-05-2024');
  });

  it('leaves a dotted name that is not an extension alone beyond the last segment', () => {
    // `.2024` looks like an extension to the regex and to a file manager alike. Removing it
    // is the same thing the OS does, so the user sees what they expect.
    expect(titleFromFileName('invoice.v2.2024')).toBe('invoice.v2');
  });

  it('falls back to the whole name rather than producing an empty title', () => {
    // A dotfile is entirely extension by this rule. An empty title would leave the submit
    // button permanently disabled with no visible cause.
    expect(titleFromFileName('.gitignore')).toBe('.gitignore');
  });
});

describe('findDuplicate', () => {
  const hash = 'b'.repeat(64);

  it('finds a match already in the case', () => {
    const match = findDuplicate(hash, [{ sha256: hash, title: 'Original receipt' }], []);
    expect(match).toEqual({ scope: 'case', title: 'Original receipt' });
  });

  it('finds the same file picked twice in one batch', () => {
    const match = findDuplicate(hash, [], [item({ sha256: hash, title: 'Screenshot' })]);
    expect(match).toEqual({ scope: 'batch', title: 'Screenshot' });
  });

  it('prefers the case match when a file is in both', () => {
    // The case match is the one with consequences — it is what produces a DUPLICATE_OF
    // relation against a record that already exists. Reporting the batch match instead
    // would describe the less important of the two collisions.
    const match = findDuplicate(
      hash,
      [{ sha256: hash, title: 'Original receipt' }],
      [item({ sha256: hash, title: 'Screenshot' })],
    );
    expect(match).toEqual({ scope: 'case', title: 'Original receipt' });
  });

  it('returns null for content nobody has seen', () => {
    expect(findDuplicate(hash, [{ sha256: 'c'.repeat(64), title: 'Other' }], [])).toBeNull();
  });

  it('never matches on an empty hash', () => {
    // A file whose bytes could not be read carries an empty hash. Two such files are not
    // duplicates of each other, and neither is a duplicate of any record — treating them
    // as one would collapse unrelated unreadable files into a single item.
    expect(findDuplicate('', [{ sha256: '', title: 'Unhashed' }], [item({ sha256: '' })])).toBeNull();
  });

  it('ignores stored records that carry no hash', () => {
    // `Evidence.sha256` is nullable: a record can predate hashing or have been written from
    // a source that had none. It must not match anything, and it must not throw.
    const match = findDuplicate(
      hash,
      [{ sha256: null, title: 'Hashless record' }, { sha256: hash, title: 'Real match' }],
      [],
    );
    expect(match).toEqual({ scope: 'case', title: 'Real match' });
  });
});

describe('recomputeDuplicates', () => {
  const shared = 'd'.repeat(64);

  it('flags only the later of two identical files', () => {
    const result = recomputeDuplicates(
      [
        item({ id: 'a', title: 'First copy', sha256: shared }),
        item({ id: 'b', title: 'Second copy', sha256: shared }),
      ],
      [],
    );

    expect(result[0]?.duplicate).toBeNull();
    expect(result[1]?.duplicate).toEqual({ scope: 'batch', title: 'First copy' });
  });

  it('clears a stale warning once the file it named is removed', () => {
    // The defect this exists to prevent: remove one of a pair and the survivor keeps warning
    // that it was picked twice, naming a file that is no longer in the queue.
    const flagged = item({
      id: 'b',
      title: 'Second copy',
      sha256: shared,
      duplicate: { scope: 'batch', title: 'First copy' },
    });

    const result = recomputeDuplicates([flagged], []);
    expect(result[0]?.duplicate).toBeNull();
  });

  it('re-flags the new leader against the case after a removal', () => {
    const result = recomputeDuplicates([item({ id: 'b', sha256: shared, duplicate: null })], [
      { sha256: shared, title: 'Already filed' },
    ]);

    expect(result[0]?.duplicate).toEqual({ scope: 'case', title: 'Already filed' });
  });

  it('returns the identical object when an item is unaffected', () => {
    // Identity is load-bearing: the card memoises its extraction preview on the item's
    // fields, and rebuilding every object on an unrelated removal would re-run a regex pass
    // over every queued document.
    const untouched = item({ id: 'a', sha256: 'e'.repeat(64) });
    const result = recomputeDuplicates([untouched], []);

    expect(result[0]).toBe(untouched);
  });

  it('does not pair two files that could not be hashed', () => {
    const result = recomputeDuplicates(
      [item({ id: 'a', sha256: '' }), item({ id: 'b', sha256: '' })],
      [],
    );

    expect(result[0]?.duplicate).toBeNull();
    expect(result[1]?.duplicate).toBeNull();
  });
});

describe('describeReadiness', () => {  it('asks for a file when the queue is empty', () => {
    expect(describeReadiness([])).toEqual({ ready: false, reason: 'Add a file to get started' });
  });

  it('blocks while any file is still being read', () => {
    const result = describeReadiness([item(), item({ id: 'q2', status: 'reading' })]);
    expect(result).toEqual({ ready: false, reason: 'Still reading files…' });
  });

  it('blocks while any file is being re-read', () => {
    // A re-read replaces the text and its provenance. Committing mid-flight would store
    // the superseded reading and stamp it with the method of the one still running.
    const result = describeReadiness([item({ rereading: true })]);
    expect(result).toEqual({ ready: false, reason: 'Still reading files…' });
  });

  it('blocks when nothing in the queue could be read', () => {
    const result = describeReadiness([item({ status: 'failed' })]);
    expect(result).toEqual({ ready: false, reason: 'No file here could be read' });
  });

  it('names how many files still need a title', () => {
    const result = describeReadiness([
      item({ title: 'Bill' }),
      item({ id: 'q2', title: '   ' }),
      item({ id: 'q3', title: '' }),
    ]);
    expect(result).toEqual({ ready: false, reason: '2 files still need a title' });
  });

  it('counts only committable files when reporting readiness', () => {
    // The unreadable file is not going to be written, so it must not hold the button
    // hostage over a title it will never use.
    const result = describeReadiness([item(), item({ id: 'q2', status: 'failed', title: '' })]);
    expect(result).toEqual({ ready: true, count: 1 });
  });

  it('is ready when every readable file has a title', () => {
    expect(describeReadiness([item(), item({ id: 'q2' })])).toEqual({ ready: true, count: 2 });
  });
});

describe('planCommit', () => {
  it('splits the queue into what will be written and what will not', () => {
    const ok = item();
    const broken = item({ id: 'q2', status: 'failed' });
    const reading = item({ id: 'q3', status: 'reading' });

    const plan = planCommit([ok, broken, reading]);

    expect(plan.committable).toEqual([ok]);
    expect(plan.unreadable).toEqual([broken, reading]);
  });

  it('accounts for every item exactly once', () => {
    // The invariant the summary depends on. A file that appears in neither pile would be
    // dropped without ever being counted, which is the failure this whole module guards.
    const items = [item(), item({ id: 'q2', status: 'failed' }), item({ id: 'q3' })];
    const plan = planCommit(items);

    expect(plan.committable.length + plan.unreadable.length).toBe(items.length);
  });

  it('preserves queue order within each pile', () => {
    const plan = planCommit([item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]);
    expect(plan.committable.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('summariseCommit', () => {
  it('reports a clean single-file commit', () => {
    expect(summariseCommit({ saved: 1, unreadable: 0, withoutCloudCopy: 0 })).toBe(
      '1 file saved. Check processing status in the case.',
    );
  });

  it('reports a clean batch', () => {
    expect(summariseCommit({ saved: 10, unreadable: 0, withoutCloudCopy: 0 })).toBe(
      '10 files saved. Check processing status in the case.',
    );
  });

  it('says out loud when files were left behind', () => {
    const text = summariseCommit({ saved: 8, unreadable: 2, withoutCloudCopy: 0 });
    expect(text).toContain('8 files saved');
    expect(text).toContain('2 files were left out');
  });

  it('distinguishes a missing cloud copy from a missing file', () => {
    // These are different outcomes and must never be worded alike: one file is absent
    // from the case, the other is present but has no backup.
    const text = summariseCommit({ saved: 9, unreadable: 1, withoutCloudCopy: 3 });
    expect(text).toContain('1 file was left out');
    expect(text).toContain('3 were kept on this device only');
  });
});

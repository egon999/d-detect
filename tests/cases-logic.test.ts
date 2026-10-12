import { describe, it, expect } from 'vitest';

import {
  buildReportText,
  caseProgress,
  compareBlockerCopy,
  compareFailureCopy,
  compareReadiness,
  coverageDisclosure,
  groupItemsBySide,
  groupSignals,
  isComparisonOutOfDate,
  itemStateNote,
  materialGaps,
  quoteLineFor,
  readingProgress,
  resolveCitations,
  STORED_COMPARISON_UNREADABLE,
  storedComparisonProblem,
  strengthenSection,
  THIN_MATERIAL_WARNING,
  WIDE_LAYOUT,
} from '../app/case/_logic';
import type {
  CaseItem,
  CaseReport,
  CaseSide,
  CaseItemStatus,
  Coverage,
  Signal,
  SourceRef,
  Verdict,
} from '../src/api/cases';

/*
 * The case screens' rules, tested away from the screens.
 *
 * Three of these decide whether the product is honest or not. Whether a comparison has gone
 * out of date is what stops a six-day-old reading being presented as current. The side
 * grouping is the separation the whole screen is built on — a piece in the wrong column is a
 * document attributed to the wrong person. And the "what is still needed" rule replaced a
 * disabled button with no explanation, so every branch of it has to produce a sentence
 * somebody can act on.
 */

const FACTS: CaseItem['facts'] = { amounts: [], dates: [], references: [], statuses: [] };

function item(overrides: Partial<CaseItem> & { id: string }): CaseItem {
  return {
    side: 'mine',
    kind: 'file',
    label: overrides.id,
    status: 'ready',
    fileId: 'file_1',
    readBy: 'pdf',
    readNote: null,
    question: null,
    excerpt: '',
    hasMoreText: false,
    fileHadMoreText: false,
    facts: FACTS,
    createdAt: 1,
    ...overrides,
  };
}

/** The only two things the readiness rule is allowed to look at. */
function piece(side: CaseSide, status: CaseItemStatus): { side: CaseSide; status: CaseItemStatus } {
  return { side, status };
}

function summary(overrides: {
  mine?: number;
  theirs?: number;
  pending?: number;
  hasAnalysis?: boolean;
  analysisStale?: boolean;
  myClaim?: string;
}) {
  return {
    counts: { mine: overrides.mine ?? 0, theirs: overrides.theirs ?? 0, pending: overrides.pending ?? 0 },
    hasAnalysis: overrides.hasAnalysis ?? false,
    analysisStale: overrides.analysisStale ?? false,
    myClaim: overrides.myClaim ?? '',
  };
}

describe('Case layout', () => {
  it('uses one wide breakpoint, matching the other screens', () => {
    // Three different numbers were in use (900, 1050, 1100), so the same tablet reflowed the
    // evidence columns and the home grid at different widths.
    expect(WIDE_LAYOUT).toBe(1050);
  });
});

describe('Out-of-date detection', () => {
  it('is out of date only when a stored comparison exists and the material moved under it', () => {
    expect(isComparisonOutOfDate({ hasAnalysis: true, analysisStale: true })).toBe(true);
    expect(isComparisonOutOfDate({ hasAnalysis: true, analysisStale: false })).toBe(false);
    // A case nobody has compared is not "out of date" — there is nothing to be out of date.
    expect(isComparisonOutOfDate({ hasAnalysis: false, analysisStale: true })).toBe(false);
    expect(isComparisonOutOfDate({ hasAnalysis: false, analysisStale: false })).toBe(false);
  });

  it('reports a stale comparison as needing another run, not as compared', () => {
    const stale = caseProgress(summary({ mine: 2, theirs: 1, hasAnalysis: true, analysisStale: true }));
    expect(stale.state).toBe('out_of_date');
    expect(stale.label).toBe('Needs comparing again');
    expect(stale.tone).toBe('warn');

    const current = caseProgress(summary({ mine: 2, theirs: 1, hasAnalysis: true }));
    expect(current.state).toBe('compared');
    expect(current.tone).toBe('ok');
  });

  it('puts reading ahead of every other state, and says so without a bare count', () => {
    const progress = caseProgress(summary({ mine: 3, pending: 2, hasAnalysis: true, analysisStale: true }));
    expect(progress.state).toBe('reading');
    expect(progress.busy).toBe(true);
    // The old chip read "Reading 2" — a count with no noun, which is a progress counter from
    // a build log rather than a sentence.
    expect(progress.label).toBe('Still reading your files');
    expect(caseProgress(summary({ mine: 1, pending: 1 })).label).toBe('Still reading a file');
  });

  it('distinguishes an empty case from one holding only their side', () => {
    expect(caseProgress(summary({})).state).toBe('nothing_added');
    expect(caseProgress(summary({ theirs: 2 })).state).toBe('nothing_of_yours');
    // The person's own written account is something of theirs, even with no file.
    expect(caseProgress(summary({ theirs: 2, myClaim: 'I paid on the 3rd' })).state).toBe('ready_to_compare');
    expect(caseProgress(summary({ mine: 1, theirs: 1 })).state).toBe('ready_to_compare');
  });

  it('never claims a case is busy when nothing is being read', () => {
    for (const state of [summary({}), summary({ mine: 1 }), summary({ hasAnalysis: true })]) {
      expect(caseProgress(state).busy).toBe(false);
    }
  });

  it('safely handles edge-case summaries missing counts or text fields without crashing', () => {
    // Missing all fields or nulls
    expect(caseProgress(null).state).toBe('nothing_added');
    expect(caseProgress(undefined).state).toBe('nothing_added');
    expect(caseProgress({}).state).toBe('nothing_added');
    expect(caseProgress({ counts: undefined, myClaim: undefined }).state).toBe('nothing_added');
    // myClaim null or whitespace only
    expect(caseProgress({ counts: { mine: 0, theirs: 1, pending: 0 }, myClaim: null as unknown as string }).state).toBe('nothing_of_yours');
    expect(caseProgress({ counts: { mine: 0, theirs: 1, pending: 0 }, myClaim: '   ' }).state).toBe('nothing_of_yours');
    // isComparisonOutOfDate with null / undefined
    expect(isComparisonOutOfDate(null)).toBe(false);
    expect(isComparisonOutOfDate(undefined)).toBe(false);
  });
});

describe('Side grouping', () => {
  it('puts every piece in exactly one column, keeping the server order', () => {
    const items = [
      item({ id: 'a', side: 'mine' }),
      item({ id: 'b', side: 'theirs' }),
      item({ id: 'c', side: 'mine' }),
      item({ id: 'd', side: 'theirs' }),
    ];
    const sided = groupItemsBySide(items);
    expect(sided.mine.map((row) => row.id)).toEqual(['a', 'c']);
    expect(sided.theirs.map((row) => row.id)).toEqual(['b', 'd']);
    expect(sided.mine.length + sided.theirs.length).toBe(items.length);
  });

  it('returns two empty columns for an empty case rather than nothing', () => {
    expect(groupItemsBySide([])).toEqual({ mine: [], theirs: [] });
  });
});

describe('What is still needed before comparing', () => {
  const claims = { myClaim: '', theirClaim: '' };

  it('asks for something to read when the case is empty', () => {
    const readiness = compareReadiness({ items: [], ...claims });
    expect(readiness.ready).toBe(false);
    expect(readiness.blocker).toEqual({ kind: 'nothing_added' });
    expect(compareBlockerCopy(readiness.blocker!).action).toBe('Add what you have');
  });

  it('does not accept a typed account on its own, because the server will not either', () => {
    // The server requires one readable piece of evidence. A statement written into the case
    // is one; the account fields on the case are not, and treating them as equivalent here
    // is how a button ends in a rejected request.
    const readiness = compareReadiness({ items: [], myClaim: 'They never returned it', theirClaim: 'We did' });
    expect(readiness.ready).toBe(false);
    expect(readiness.blocker).toEqual({ kind: 'nothing_added' });
  });

  it('waits while anything is still being read, and counts what is waiting', () => {
    const readiness = compareReadiness({
      items: [piece('mine', 'reading'), piece('mine', 'pending'), piece('theirs', 'ready')],
      ...claims,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blocker).toEqual({ kind: 'reading', count: 2 });
    // Nothing for the person to do, so no action is offered.
    expect(compareBlockerCopy(readiness.blocker!).action).toBeNull();
  });

  it('says nothing could be read when every piece came back unreadable', () => {
    const readiness = compareReadiness({
      items: [piece('mine', 'failed'), piece('mine', 'needs_context')],
      ...claims,
    });
    expect(readiness.blocker).toEqual({ kind: 'nothing_readable' });
    expect(compareBlockerCopy(readiness.blocker!).message).toContain('say what it shows');
  });

  it('refuses to compare a case holding only the other side', () => {
    const readiness = compareReadiness({ items: [piece('theirs', 'ready')], ...claims });
    expect(readiness.ready).toBe(false);
    expect(readiness.blocker).toEqual({ kind: 'nothing_of_yours' });
    expect(compareBlockerCopy(readiness.blocker!).title).toBe('Add something of your own first');
  });

  it('accepts their evidence plus the person’s own written account', () => {
    const readiness = compareReadiness({
      items: [piece('theirs', 'ready')],
      myClaim: 'I paid the deposit in cash',
      theirClaim: '',
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.blocker).toBeNull();
  });

  it('is ready with one readable piece of the person’s own, and flags the one-sidedness', () => {
    const readiness = compareReadiness({ items: [piece('mine', 'ready')], ...claims });
    expect(readiness.ready).toBe(true);
    // Nothing from them at all. Not a blocker — but the screen has to say so before showing
    // a one-sided reading as though it compared two accounts.
    expect(readiness.oneSided).toBe(true);
  });

  it('stops flagging one-sidedness as soon as anything of theirs exists', () => {
    expect(
      compareReadiness({ items: [piece('mine', 'ready'), piece('theirs', 'failed')], ...claims }).oneSided,
    ).toBe(false);
    expect(
      compareReadiness({ items: [piece('mine', 'ready')], myClaim: '', theirClaim: 'We returned it' }).oneSided,
    ).toBe(false);
  });

  it('reports the first thing to fix, not all of them', () => {
    const readiness = compareReadiness({
      items: [piece('theirs', 'ready'), piece('mine', 'reading')],
      ...claims,
    });
    // Both "still reading" and "nothing of yours" are true; the one that resolves itself in
    // seconds is the one to say, because the other may not survive it.
    expect(readiness.blocker).toEqual({ kind: 'reading', count: 1 });
  });
});

describe('Honesty about the material', () => {
  it('keeps a file that was cut short apart from one that merely has a long excerpt', () => {
    const gaps = materialGaps([
      item({ id: 'a', hasMoreText: true }),
      item({ id: 'b', fileHadMoreText: true }),
      item({ id: 'c', status: 'needs_context' }),
      item({ id: 'd', status: 'failed' }),
      item({ id: 'e', status: 'reading' }),
    ]);
    // `hasMoreText` is recoverable — the rest is on the server. `fileHadMoreText` is not.
    expect(gaps.partlySaved.map((row) => row.id)).toEqual(['b']);
    expect(gaps.needsWords.map((row) => row.id)).toEqual(['c']);
    expect(gaps.unread.map((row) => row.id)).toEqual(['d']);
    expect(gaps.reading.map((row) => row.id)).toEqual(['e']);
  });
});

describe('Grouping the mechanical comparison', () => {
  function signal(kind: string, strength: Signal['strength'] = 'moderate'): Signal {
    return { kind, strength, headline: kind, detail: kind, itemIds: [] };
  }

  it('sorts the detectors into agreement, contradiction and what is missing', () => {
    const grouped = groupSignals([
      signal('amount_mismatch'),
      signal('shared_reference'),
      signal('no_opposing_material'),
      signal('date_agreement'),
      signal('status_conflict'),
      signal('your_side_unproven'),
    ]);
    expect(grouped.agreed.map((row) => row.kind)).toEqual(['shared_reference', 'date_agreement']);
    expect(grouped.contradicted.map((row) => row.kind)).toEqual(['amount_mismatch', 'status_conflict']);
    expect(grouped.gap.map((row) => row.kind)).toEqual(['no_opposing_material', 'your_side_unproven']);
    expect(grouped.other).toEqual([]);
  });

  it('shows a detector it has never heard of rather than dropping it', () => {
    const grouped = groupSignals([signal('some_future_detector')]);
    expect(grouped.other.map((row) => row.kind)).toEqual(['some_future_detector']);
  });

  it('puts the firmest finding first within a group', () => {
    const grouped = groupSignals([
      signal('amount_mismatch', 'weak'),
      signal('date_conflict', 'strong'),
      signal('status_conflict', 'moderate'),
    ]);
    expect(grouped.contradicted.map((row) => row.kind)).toEqual([
      'date_conflict',
      'status_conflict',
      'amount_mismatch',
    ]);
  });
});

describe('Tracing a claim back to the material', () => {
  const sources: SourceRef[] = [
    { id: 'item_1', label: 'Deposit receipt', side: 'mine', kind: 'file' },
    { id: 'item_gone', label: 'WhatsApp screenshot', side: 'mine', kind: 'file' },
    { id: 'yours', label: 'Your own account of what happened', side: 'mine', kind: 'account' },
    { id: 'theirs', label: 'Their account, as you described it', side: 'theirs', kind: 'account' },
  ];
  const record = { items: [item({ id: 'item_1', label: 'Deposit receipt' })], sources };

  it('resolves a live piece, an account, and a piece that has since been removed', () => {
    const cited = resolveCitations(['item_1', 'yours', 'item_gone'], record);
    expect(cited.map((entry) => entry.label)).toEqual([
      'Deposit receipt',
      'Your own account of what happened',
      'WhatsApp screenshot',
    ]);
    expect(cited[0]?.item?.id).toBe('item_1');
    expect(cited[1]?.account).toBe(true);
    expect(cited[2]?.removed).toBe(true);
    expect(cited[2]?.item).toBeNull();
  });

  it('drops an id it cannot name rather than printing it', () => {
    // A raw identifier on screen is meaningless to the reader and is an internal leak.
    const cited = resolveCitations(['item_1', 'piece 2', 'analysis_01HZ'], record);
    expect(cited).toHaveLength(1);
    expect(cited[0]?.label).toBe('Deposit receipt');
  });

  it('names a deleted piece from the copy the comparison kept, when the case no longer can', () => {
    const cited = resolveCitations(['item_old'], { items: [], sources: [] }, {
      sources: [{ id: 'item_old', label: 'Bank statement', side: 'mine', kind: 'file' }],
    });
    expect(cited[0]?.label).toBe('Bank statement');
    expect(cited[0]?.removed).toBe(true);
  });

  it('cites each piece once however often the comparison names it', () => {
    expect(resolveCitations(['item_1', 'item_1', 'yours', 'item_1'], record)).toHaveLength(2);
  });
});

describe('Quoting the line a finding rests on', () => {
  const text = 'Invoice 4471\nTotal payable: ₹30,000\nPaid in full on 3 May 2026\nThank you';

  it('returns the exact line carrying the value', () => {
    expect(quoteLineFor(text, '₹30,000')).toBe('Total payable: ₹30,000');
    expect(quoteLineFor(text, '3 may 2026')).toBe('Paid in full on 3 May 2026');
  });

  it('returns nothing rather than a guess when the value is not in the text', () => {
    expect(quoteLineFor(text, '₹45,000')).toBeNull();
    expect(quoteLineFor(text, '')).toBeNull();
    expect(quoteLineFor('', '₹30,000')).toBeNull();
  });

  it('marks a line it had to cut, so a trimmed quote is never passed off as the whole line', () => {
    const wall = `${'x'.repeat(400)} ₹30,000 ${'y'.repeat(400)}`;
    const quote = quoteLineFor(wall, '₹30,000');
    expect(quote).toContain('₹30,000');
    expect(quote?.startsWith('…')).toBe(true);
    expect(quote?.endsWith('…')).toBe(true);
  });
});

describe('The shareable report', () => {
  const report: CaseReport = {
    title: 'Landlord keeping the deposit',
    question: 'Was the deposit returned?',
    myClaim: 'I paid ₹30,000 and never got it back',
    theirClaim: 'They say it covered repairs',
    preparedAt: Date.UTC(2026, 4, 3, 9, 30),
    items: [
      {
        ...item({ id: 'item_1', label: 'Deposit receipt', fileHadMoreText: true }),
        text: 'Received ₹30,000 as security deposit',
      },
      {
        ...item({ id: 'item_2', side: 'theirs', kind: 'statement', label: 'What the landlord said', readBy: 'typed' }),
        text: 'He told me it went on repairs',
      },
    ],
    signals: [
      { kind: 'amount_mismatch', strength: 'strong', headline: 'The amounts differ', detail: '₹30,000 against ₹12,000', itemIds: ['item_1'] },
    ],
    analysis: {
      headline: 'The receipt names the deposit and nothing shows it was returned',
      yourAccount: 'You paid ₹30,000 as a deposit',
      theirAccount: 'They say repairs consumed it',
      standing: 'your_account_is_better_supported',
      confidence: 'medium',
      summary: 'The receipt is specific. Nothing from them puts a figure on the repairs.',
      evidence: [{ itemId: 'item_1', strength: 'strong', reason: 'Names the amount and the date' }],
      conflicts: [
        {
          point: 'How much of the deposit was spent',
          about: 'amount',
          yourSide: 'The receipt says ₹30,000',
          yourValue: '₹30,000',
          yourSources: ['item_1'],
          theirSide: 'They have not put a figure on it',
          theirValue: '',
          theirSources: [],
          reading: 'Only one side has a figure in writing.',
        },
      ],
      supported: [{ point: 'A deposit of ₹30,000 was paid', sources: ['item_1'] }],
      notSupported: [{ point: 'That the full deposit was returned', sources: [] }],
      missing: [{ point: 'An itemised repair bill', wouldShow: 'What the deductions were actually for' }],
      nextStep: 'Ask them in writing for an itemised bill for the repairs.',
    },
    standingText: 'Your account is better supported by the evidence',
    /*
     * Every id the comparison cites, named. Without this the report has no way to turn
     * `item_1` into "Deposit receipt", and a line nobody can trace back to a file they can
     * open is a line in a shared document asserting something on nobody's authority.
     */
    sources: [
      { id: 'item_1', label: 'Deposit receipt', side: 'mine', kind: 'file' },
      { id: 'item_2', label: 'What the landlord said', side: 'theirs', kind: 'statement' },
      { id: 'yours', label: 'Your own account of what happened', side: 'mine', kind: 'account' },
      { id: 'theirs', label: 'Their account, as you described it', side: 'theirs', kind: 'account' },
    ],
    /*
     * A sentence, never a grade and never a figure. The server composes this for the result in
     * hand; the one thing it must not be is a measurement of how sure anything is.
     */
    confidenceText: 'The receipt is specific about the amount, but what the repairs cost is still open.',
    coverage: {
      complete: false,
      itemsInCase: 2,
      itemsAnalysed: 2,
      omitted: [],
      shortened: [],
      partlySaved: ['Deposit receipt'],
      notWeighed: [],
      note: 'Deposit receipt held more text than could be saved from the file.',
    },
    text: 'the server’s own text, which this does not use',
  };

  const text = buildReportText(report);

  it('separates the two sides and names what each piece was', () => {
    expect(text).toContain('WHAT I HAVE');
    expect(text).toContain('WHAT THEY ARE SAYING');
    expect(text).toContain('- Deposit receipt (read from the file)');
    expect(text).toContain('- What the landlord said (written down)');
  });

  it('says in the document itself that a file was cut short', () => {
    expect(text).toContain('held more text than could be saved');
  });

  it('carries the uncomfortable half, not only what the material supports', () => {
    expect(text).toContain('WHAT THE MATERIAL BACKS UP');
    expect(text).toContain('WHAT THE MATERIAL DOES NOT BACK UP');
    expect(text).toContain('That the full deposit was returned');
    expect(text).toContain('WHAT IS MISSING THAT WOULD SETTLE IT');
  });

  it('prints no score, no percentage and no grading vocabulary', () => {
    // The server's own text report prints "Confidence: medium". That is a note about a model
    // in a document somebody emails to a landlord, so this composes its own.
    expect(text.toLowerCase()).not.toContain('confidence');
    expect(text.toLowerCase()).not.toContain('medium');
    expect(text).not.toMatch(/\b\d{1,3}\s?%/);
    expect(text).not.toContain(report.text);
  });

  it('never prints an internal id', () => {
    expect(text).not.toContain('item_1');
    expect(text).not.toContain('item_2');
  });

  it('ends by saying what it is not', () => {
    expect(text.trim().endsWith('not a decision by any authority.')).toBe(true);
    expect(text).toContain('not legal advice');
  });

  it('says in the document that the material is thin, when it is', () => {
    // A report on thin material is read as a finding by whoever it is handed to. The standing
    // line alone gets skimmed, so the warning has to be its own sentence in the file.
    const thin = buildReportText({
      ...report,
      standingText: null,
      confidenceText: null,
      analysis: { ...report.analysis!, standing: 'not_enough_evidence', confidence: 'low' },
    });
    expect(thin).toContain(THIN_MATERIAL_WARNING);
    // And not when the comparison did reach a view, or the warning stops meaning anything.
    expect(text).not.toContain(THIN_MATERIAL_WARNING);
  });

  it('names every cited piece in words, from the sources the server sent', () => {
    // The report's own ids are useless to a reader; `sources` is what turns them into the
    // name of a file the person can open, which is what makes a shared line checkable.
    const cited = resolveCitations(['item_1', 'yours', 'item_2'], { items: [], sources: report.sources });
    expect(cited.map((entry) => entry.label)).toEqual([
      'Deposit receipt',
      'Your own account of what happened',
      'What the landlord said',
    ]);
    for (const line of report.analysis!.supported) {
      expect(resolveCitations(line.sources, { items: report.items, sources: report.sources }).length).toBe(
        line.sources.length,
      );
    }
  });
});

describe('Why a comparison did not happen', () => {
  it('tells a reading still in progress apart from material that moved under it', () => {
    // The route answers 409 for both. Only one of them is anybody's fault, and only one of
    // them is worth a button: a file still being read fixes itself in seconds.
    const waiting = compareFailureCopy(409, { stillReading: 2 });
    expect(waiting.title).toBe('Some files were still being read');
    expect(waiting.retryLabel).toBeNull();
    expect(compareFailureCopy(409, { stillReading: 1 }).title).toBe('A file was still being read');

    const moved = compareFailureCopy(409, { stillReading: 0 });
    expect(moved.title).toBe('Something changed part-way through');
    expect(moved.retryLabel).toBe('Try again');
    // No context at all is the same as nothing waiting, not a crash.
    expect(compareFailureCopy(409).title).toBe(moved.title);
  });

  it('offers a second attempt only where one could honestly work', () => {
    expect(compareFailureCopy(502).retryLabel).toBe('Try again');
    expect(compareFailureCopy(null).retryLabel).toBe('Try again');
    expect(compareFailureCopy(429).retryLabel).toBe('Try again');
    // Switched off on this server, nothing readable, and a case that is gone: a retry button
    // on any of these is a lie the person would act on repeatedly.
    expect(compareFailureCopy(503).retryLabel).toBeNull();
    expect(compareFailureCopy(400).retryLabel).toBeNull();
    expect(compareFailureCopy(404).retryLabel).toBeNull();
  });

  it('never leaks the server’s own vocabulary into the sentence', () => {
    for (const status of [null, 0, 400, 404, 409, 429, 502, 503, 500]) {
      const copy = compareFailureCopy(status, { stillReading: 1 });
      const whole = `${copy.title} ${copy.message}`.toLowerCase();
      for (const word of ['analysis', 'analyze', 'http', 'error', 'status', 'provider', 'request failed']) {
        expect(whole).not.toContain(word);
      }
      expect(whole).not.toMatch(/\b[45]\d\d\b/);
    }
  });
});

describe('A stored comparison this build cannot read', () => {
  it('speaks up only when the case claims a result it cannot produce', () => {
    expect(storedComparisonProblem({ hasAnalysis: true, analysis: null })).toBe(STORED_COMPARISON_UNREADABLE);
    expect(storedComparisonProblem({ hasAnalysis: false, analysis: null })).toBeNull();
  });

  it('offers to run it again rather than inventing a standing to fill the gap', () => {
    expect(STORED_COMPARISON_UNREADABLE.retryLabel).toBe('Compare again');
    expect(STORED_COMPARISON_UNREADABLE.message).toContain('Everything you added is exactly where it was');
  });
});

describe('Whether a piece is taking part', () => {
  const note = (overrides: Partial<CaseItem>) => itemStateNote(item({ id: 'x', ...overrides }));

  it('says the same thing for queued and in-flight, because the difference is not the person’s', () => {
    expect(note({ status: 'pending' })).toBe(note({ status: 'reading' }));
    expect(note({ status: 'pending' })).toContain('being read now');
  });

  it('says plainly when a piece is in the case but not in the comparison', () => {
    // The chip says "Could not be read", which a person reads as a progress note. This is the
    // sentence that stops a verdict being trusted as though the best document was weighed.
    expect(note({ status: 'failed' })).toContain('takes no part in the comparison');
    expect(note({ status: 'unreadable' })).toContain('takes no part in the comparison');
    expect(note({ status: 'needs_context' })).toContain('not in the comparison yet');
  });

  it('distinguishes a read file, a written statement and the person’s own description', () => {
    expect(note({ status: 'ready', readBy: 'pdf' })).toContain('read from the file');
    expect(note({ status: 'ready', kind: 'statement', readBy: 'typed' })).toContain('wrote this down yourself');
    expect(note({ status: 'ready', readBy: 'described' })).toContain('your own description');
  });

  it('carries the cut-short caveat on everything that is taking part', () => {
    const cut = 'The file held more text than could be saved';
    expect(note({ status: 'ready', fileHadMoreText: true })).toContain(cut);
    expect(note({ status: 'ready', kind: 'statement', fileHadMoreText: true })).toContain(cut);
    expect(note({ status: 'ready', readBy: 'described', fileHadMoreText: true })).toContain(cut);
    // Nothing to caveat on a piece that was never read.
    expect(note({ status: 'failed', fileHadMoreText: true })).not.toContain(cut);
  });
});

describe('What the screen says while the server is reading', () => {
  it('is nothing at all when nothing is being read', () => {
    expect(readingProgress([])).toBeNull();
    expect(readingProgress([{ label: 'a', status: 'ready' }])).toBeNull();
    // A bar stuck at zero with no reason is worse than no bar.
    expect(readingProgress([{ label: 'a', status: 'failed' }])).toBeNull();
  });

  it('counts finished pieces, never time', () => {
    const progress = readingProgress([
      { label: 'Receipt', status: 'ready' },
      { label: 'Bank statement', status: 'reading' },
      { label: 'Letter', status: 'failed' },
      { label: 'Photo', status: 'pending' },
    ]);
    expect(progress).not.toBeNull();
    expect(progress!.reading).toBe(2);
    expect(progress!.done).toBe(2);
    expect(progress!.total).toBe(4);
    expect(progress!.fraction).toBe(0.5);
  });

  it('names what is slow while there are few enough to name', () => {
    const one = readingProgress([{ label: 'Bank statement', status: 'reading' }]);
    expect(one!.sentence).toContain('Reading Bank statement now.');
    expect(one!.label).toBe('Reading one file');

    const two = readingProgress([
      { label: 'Receipt', status: 'reading' },
      { label: 'Photo', status: 'pending' },
    ]);
    expect(two!.sentence).toContain('Reading Receipt and Photo now.');

    const many = readingProgress([
      { label: 'a', status: 'reading' },
      { label: 'b', status: 'reading' },
      { label: 'c', status: 'pending' },
      { label: 'd', status: 'ready' },
    ]);
    expect(many!.sentence).toContain('Reading 3 files now.');
    expect(many!.sentence).toContain('One other piece is already read.');
  });

  it('always says nobody has to do anything', () => {
    const progress = readingProgress([{ label: 'Receipt', status: 'pending' }]);
    expect(progress!.sentence).toContain('Nothing is needed from you');
  });
});

describe('What the comparison could take in', () => {
  const coverage = (overrides: Partial<Coverage>): Coverage => ({
    complete: true,
    itemsInCase: 3,
    itemsAnalysed: 3,
    omitted: [],
    shortened: [],
    partlySaved: [],
    notWeighed: [],
    note: null,
    ...overrides,
  });

  it('says nothing rather than claiming completeness the server never claimed', () => {
    // An analysis stored before coverage was recorded knows nothing about what it read.
    expect(coverageDisclosure(null)).toBeNull();
    expect(coverageDisclosure(undefined)).toBeNull();
  });

  it('confirms a clean run in one quiet line', () => {
    const clean = coverageDisclosure(coverage({}))!;
    expect(clean.complete).toBe(true);
    expect(clean.tone).toBe('neutral');
    expect(clean.title).toBeNull();
    expect(clean.message).toContain('All 3 things');
    expect(coverageDisclosure(coverage({ itemsInCase: 1 }))!.message).toContain('The one thing');
  });

  it('carries the server’s own note, and keeps the unrecoverable pieces apart from it', () => {
    const cut = coverageDisclosure(
      coverage({
        complete: false,
        note: 'Two long files were read in part.',
        shortened: ['Lease'],
        partlySaved: ['Deposit receipt'],
      }),
    )!;
    expect(cut.complete).toBe(false);
    expect(cut.tone).toBe('warn');
    expect(cut.message).toBe('Two long files were read in part.');
    // Named separately because reading again cannot recover these, so they are not a retry.
    expect(cut.unrecoverable).toEqual(['Deposit receipt']);
  });
});

describe('What would make the person’s side stronger', () => {
  const verdict = (overrides: Partial<Pick<Verdict, 'missing' | 'standing'>>) => ({
    standing: 'your_account_is_better_supported' as Verdict['standing'],
    missing: [{ point: 'An itemised repair bill', wouldShow: 'What the deductions were for' }],
    ...overrides,
  });

  it('says nothing when there are no gaps, rather than an empty heading', () => {
    expect(strengthenSection(verdict({ missing: [] }))).toBeNull();
  });

  it('is framed as something to go and get on screen, and as a hole in the document', () => {
    const section = strengthenSection(verdict({}))!;
    expect(section.title).toBe('What would make your side stronger');
    // The report is read by people who are not on the person's side, so it names the hole.
    expect(section.reportTitle).toBe('What is missing that would settle it');
    expect(section.points).toEqual(verdict({}).missing);
  });

  it('changes the reason with how the case currently stands', () => {
    const intro = (standing: Verdict['standing']) => strengthenSection(verdict({ standing }))!.intro;
    expect(intro('your_account_is_better_supported')).toContain('already holds up better');
    expect(intro('their_account_is_better_supported')).toContain('go directly against that');
    expect(intro('evenly_matched')).toContain('evenly matched');
    expect(intro('not_enough_evidence')).toContain('not enough in the case');
  });

  it('never grades the gap or counts it', () => {
    for (const standing of [
      'your_account_is_better_supported',
      'their_account_is_better_supported',
      'evenly_matched',
      'not_enough_evidence',
    ] as Verdict['standing'][]) {
      const section = strengthenSection(verdict({ standing }))!;
      expect(section.intro).not.toMatch(/\b\d{1,3}\s?%/);
      expect(section.intro.toLowerCase()).not.toContain('confidence');
    }
  });
});

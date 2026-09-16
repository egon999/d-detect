import { beforeEach, describe, expect, it } from 'vitest';

import type { AttentionItem } from '@domain/analysis/attention';
import { caseWorklist, closingDeadlines } from '@domain/analysis/worklist';
import type { AnalysisResult, Evidence, Workspace } from '@domain/models';

import { CASE_ID, OWNER, evidence, resetIds, testCase, workspace } from './helpers';

/**
 * The forward-looking worklist.
 *
 * `attention.ts` answers "what is unresolved". This module adds the one question the app could
 * not previously ask anywhere except inside a single screen: **what runs out if I do nothing.**
 *
 * Three properties carry the weight here, and most of what follows tests them rather than
 * testing that a list assembles:
 *
 *   1. **A deadline row and the letter screen agree.** Both go through `filingDraftForCase`,
 *      so a row that said "44 days" while the letter it opened said "43" would be a bug in
 *      the only number in this app that a user might act on the same afternoon.
 *   2. **A closed window is stated once, calmly, and does not dominate the list forever.** A
 *      permanently-unresolvable HIGH row is how a to-do list teaches people to ignore it.
 *   3. **Silence is honoured.** Closing or archiving a case silences its deadline too. The
 *      calendar does not get to override the user saying "I am done with this".
 */

const stamps = { ownerId: OWNER, caseId: CASE_ID, createdAt: 1_000, updatedAt: 1_000 };

/** 2024-03-01, the date on the complaint below. */
const COMPLAINT_ISO = '2024-03-01';
const DAY = 86_400_000;
const at = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * The banking window is 395 days from the complaint (Clause 10(2)(a)(ii): one year, plus the
 * thirty days the bank has to reply). Days are counted from the complaint date, so `now` is
 * expressed as an offset from it to keep the arithmetic in the test readable.
 */
const dayAfterComplaint = (days: number) => at(COMPLAINT_ISO) + days * DAY;

const BANK_COMPLAINT = [
  'To: Grievance Officer, State Bank',
  `Date: 01/03/2024`,
  'Complaint reference: SBI/GRV/88421',
  'I am writing to complain about a failed UPI transfer from my savings account.',
  'The amount of INR 4,200.00 was debited but never credited. Kindly resolve and refund.',
].join('\n');

function bankCase(parts: Partial<Workspace> = {}): Workspace {
  const complaint = evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint to bank' });
  return workspace({ evidence: [complaint], ...parts });
}

function finding(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    ...stamps,
    id: 'res_1',
    resultType: 'POSSIBLE_CONFLICT',
    severity: 'HIGH',
    title: 'Amounts do not agree',
    explanation: 'The invoice says INR 85,000 and the receipt says INR 40,000.',
    supportingEvidenceIds: [],
    relatedClaimIds: [],
    relatedEventIds: [],
    triggeredRuleIds: ['amount-mismatch@2'],
    aiSuggestionIds: [],
    inputs: {},
    confidence: 'EXACT_MATCH',
    status: 'OPEN',
    provisional: false,
    unconfirmedReads: [],
    reviewedAt: null,
    reviewNote: '',
    ...overrides,
  };
}

const deadlineIn = (items: readonly AttentionItem[]) =>
  items.find((item) => item.id === `deadline:${CASE_ID}`);

beforeEach(resetIds);

describe('when a filing window produces a row at all', () => {
  it('says nothing while the window is comfortably open', () => {
    // 92 days elapsed of 395. Nothing is running out, so there is nothing to say — and a
    // banner that fires on every visit is one people learn to scroll past.
    expect(deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(92)))).toBeUndefined();
  });

  it('speaks up once the window is inside sixty days of closing', () => {
    // 395 - 340 = 55 days left.
    const row = deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(340)));
    expect(row).toBeDefined();
    expect(row!.title).toBe('55 days left to take this further');
  });

  it('says nothing at sixty-one days left, and speaks at sixty', () => {
    // The threshold, asserted from both sides so a `<` that should be `<=` cannot pass.
    expect(deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(334)))).toBeUndefined();
    expect(deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(335)))).toBeDefined();
  });

  it('writes "1 day" rather than "1 days" on the last day', () => {
    const row = deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(394)));
    expect(row!.title).toBe('1 day left to take this further');
  });

  it('still counts the final day as open rather than closed', () => {
    // 0 remaining means the window closes today, not that it has closed. Someone filing this
    // afternoon is in time, and a row telling them otherwise would cost them the forum.
    const row = deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(395)));
    expect(row!.title).toBe('0 days left to take this further');
    expect(row!.severity).toBe('HIGH');
  });

  it('reports a closed window plainly, and not as the most urgent thing in the list', () => {
    const row = deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(396)));
    expect(row!.title).toBe('Past the usual window to take this further');
    // MEDIUM, not HIGH: a closed window never changes again, so a HIGH row would sit at the
    // top of the list permanently, unresolvable by anything the user could do.
    expect(row!.severity).toBe('MEDIUM');
  });

  it('produces no row for a case with no complaint to measure from', () => {
    // No draft, so no window, so no invented deadline.
    const statement = evidence('ACCOUNT STATEMENT\nStatement Date: 25/02/2024', { id: 'evd_s' });
    const items = caseWorklist(workspace({ evidence: [statement] }), dayAfterComplaint(900));
    expect(deadlineIn(items)).toBeUndefined();
  });

  it('produces no row when the forum has no window this app can state', () => {
    // Telecom: TRAI's clock starts at the expiry of a per-service Quality of Service period
    // that appears in no document the app holds, so `limitation` returns UNKNOWN rather than
    // a computed guess — and UNKNOWN is a question the letter screen answers, not a task.
    //
    // Two distinct sector *patterns* must match before `detectForum` will name a sector at
    // all (one is noise) — and "broadband" and "landline" are the same pattern, so a document
    // using both still counts as one signal. This one adds "mobile number" and "network
    // coverage". With a single signal it falls through to the consumer route, which does have
    // a window and would produce a row.
    const complaint = evidence(
      [
        'To: The Manager, Airtel',
        'Date: 01/03/2024',
        'Complaint reference: AIR/GRV/7788',
        'I am writing to complain about my broadband connection being down.',
        'My mobile number has had no network coverage since then either.',
        'The amount of INR 999.00 was charged for a service I did not receive.',
      ].join('\n'),
      { id: 'evd_c', title: 'Complaint to Airtel' },
    );
    const items = caseWorklist(workspace({ evidence: [complaint] }), dayAfterComplaint(900));
    expect(deadlineIn(items)).toBeUndefined();
  });
});

describe('what a deadline row carries', () => {
  const row = () => deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(340)))!;

  it('opens the letter for its own case', () => {
    expect(row().href).toBe(`/case/${CASE_ID}/letter`);
    expect(row().target).toEqual({ route: 'letter', caseId: CASE_ID });
  });

  it('names the case it belongs to, so the row reads on a cross-case screen', () => {
    expect(row().caseId).toBe(CASE_ID);
    expect(row().caseTitle).toBe('Test case');
  });

  it('keys itself on the case rather than on the days remaining', () => {
    // A row id that changed as the count fell would remount the row every day, losing
    // scroll position and any open state on it.
    const a = deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(340)))!;
    const b = deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(341)))!;
    expect(a.id).toBe(b.id);
    expect(a.title).not.toBe(b.title);
  });

  it('carries no timestamp, rather than a fabricated one', () => {
    // Every other row in the list became visible when a record was written. This one became
    // visible because the calendar moved, and there is no moment on any record to point at.
    expect(row().at).toBeNull();
  });

  it('quotes the provision the window comes from', () => {
    expect(row().detail).toContain('Clause 10(2)(a)(ii)');
    expect(row().detail).toContain('Integrated Ombudsman Scheme, 2021');
  });

  it('never tells the reader it is too late to act', () => {
    const closed = deadlineIn(caseWorklist(bankCase(), dayAfterComplaint(900)))!;
    expect(closed.detail).not.toMatch(/too late|expired|barred|cannot file|no longer possible/i);
    // The consumer route remains, and a closed banking window is the moment to name it —
    // the Ombudsman scheme has no power to condone this delay, so pointing back at it would
    // send someone to ask for an indulgence that does not exist.
    expect(closed.detail).toContain('Consumer Protection Act');
  });

  it('uses none of the words this app does not get to say', () => {
    expect(row().detail).not.toMatch(/\b(proves?|verified|confirmed|authentic)\b/i);
  });
});

describe('how deadlines rank against everything else outstanding', () => {
  it('puts a closing window above an unreviewed finding of the same severity', () => {
    // Both HIGH. The finding has a timestamp and the deadline does not, so ranking by recency
    // after severity — which is what `attention.ts` does — would put the finding first. That
    // is the wrong answer: the finding will still be there next month and the window will not.
    const items = caseWorklist(
      bankCase({ analysisResults: [finding()] }),
      dayAfterComplaint(340),
    );
    expect(items.map((item) => item.id).slice(0, 2)).toEqual([
      `deadline:${CASE_ID}`,
      'finding:res_1',
    ]);
  });

  it('leaves a HIGH finding above a closed window', () => {
    // The finding is actionable and the closed window is not, so severity does the right
    // thing here without any special-casing.
    const items = caseWorklist(
      bankCase({ analysisResults: [finding()] }),
      dayAfterComplaint(900),
    );
    expect(items[0]!.id).toBe('finding:res_1');
    expect(items[1]!.id).toBe(`deadline:${CASE_ID}`);
  });

  it('keeps every row `itemsNeedingAttention` would have produced', () => {
    // The worklist adds to that list; it must never quietly filter it.
    const items = caseWorklist(
      bankCase({ analysisResults: [finding(), finding({ id: 'res_2', severity: 'LOW' })] }),
      dayAfterComplaint(92),
    );
    expect(items.map((item) => item.id)).toContain('finding:res_1');
    expect(items.map((item) => item.id)).toContain('finding:res_2');
  });

  it('orders two rows that both lack a timestamp deterministically', () => {
    // `null - null` is NaN, which makes a comparator non-transitive and the resulting order
    // engine-dependent. Two runs over the same input must produce the same list.
    const ws = bankCase({ cases: [testCase(), testCase({ id: 'case_b', title: 'Second' })] });
    const once = caseWorklist(ws, dayAfterComplaint(340)).map((item) => item.id);
    const twice = caseWorklist(ws, dayAfterComplaint(340)).map((item) => item.id);
    expect(once).toEqual(twice);
  });
});

describe('cases the worklist stays quiet about', () => {
  const silenced = (parts: Partial<Workspace>) =>
    deadlineIn(caseWorklist(bankCase(parts), dayAfterComplaint(340)));

  it('says nothing about a case the user has closed', () => {
    expect(silenced({ cases: [testCase({ status: 'CLOSED' })] })).toBeUndefined();
  });

  it('says nothing about a case the user has archived', () => {
    expect(silenced({ cases: [testCase({ status: 'ARCHIVED' })] })).toBeUndefined();
  });

  it('says nothing about a deleted case', () => {
    expect(silenced({ cases: [testCase({ deletedAt: 2_000 })] })).toBeUndefined();
  });

  it('is empty for an empty workspace rather than throwing', () => {
    expect(caseWorklist({ ...bankCase(), cases: [], evidence: [] }, dayAfterComplaint(340))).toEqual(
      [],
    );
  });
});

describe('deadlines across several cases', () => {
  /** Two cases, each with its own complaint, at different points in their windows. */
  function twoCases(): Workspace {
    const first = evidence(BANK_COMPLAINT, { id: 'evd_a', title: 'Complaint to bank' });
    const second: Evidence = evidence(
      [
        'To: Grievance Officer, HDFC Bank',
        'Date: 01/09/2023',
        'Complaint reference: HDFC/GRV/1201',
        'I am writing to complain about a failed UPI transfer from my savings account.',
        'The amount of INR 9,000.00 was debited but never credited. Kindly resolve and refund.',
      ].join('\n'),
      { id: 'evd_b', title: 'Complaint to HDFC', caseId: 'case_b' },
    );
    return workspace({
      cases: [testCase(), testCase({ id: 'case_b', title: 'Second matter' })],
      evidence: [first, second],
    });
  }

  it('reports one row per case, each measured from its own complaint', () => {
    // case_test: 340 days elapsed, 55 left. case_b's complaint is six months older, so its
    // window has already closed by the same date.
    const rows = closingDeadlines(twoCases(), dayAfterComplaint(340));
    expect(rows.map((row) => row.caseId)).toEqual([CASE_ID, 'case_b']);
    expect(rows[0]!.severity).toBe('HIGH');
    expect(rows[1]!.severity).toBe('MEDIUM');
  });

  it('gives each row the title of its own case', () => {
    const rows = closingDeadlines(twoCases(), dayAfterComplaint(340));
    expect(rows.map((row) => row.caseTitle)).toEqual(['Test case', 'Second matter']);
  });

  it('returns only deadlines, never the rest of the worklist', () => {
    const rows = closingDeadlines(
      bankCase({ analysisResults: [finding()] }),
      dayAfterComplaint(340),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(`deadline:${CASE_ID}`);
  });

  it('agrees with the full worklist about every deadline in it', () => {
    // The two entry points must not be able to disagree — a screen leading with deadlines and
    // a screen showing everything would otherwise show different counts for the same day.
    const ws = twoCases();
    const fromWorklist = caseWorklist(ws, dayAfterComplaint(340)).filter((item) =>
      item.id.startsWith('deadline:'),
    );
    const direct = closingDeadlines(ws, dayAfterComplaint(340));
    expect(new Set(fromWorklist.map((row) => row.id))).toEqual(
      new Set(direct.map((row) => row.id)),
    );
  });
});

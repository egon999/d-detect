import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildFilingDraft,
  draftQuestions,
  draftReadiness,
  filingDraftForCase,
  fillLine,
  PERSONAL_SLOTS,
  renderDraftText,
} from '@domain/analysis/filing-draft';
import { fieldPath } from '@domain/extraction/merge';
import type { Evidence } from '@domain/models';
import { isUnconfirmedReading } from '@domain/rules/provenance';

import { CASE_ID, evidence, resetIds, testCase, workspace } from './helpers';

/**
 * The filing draft — the letter the user signs and sends.
 *
 * This is the most consequential output in the app: a document that goes to a regulator, in
 * the user's name, over their signature. So most of what follows is not about whether the
 * draft assembles, but about what it is forbidden to do.
 *
 * Four properties carry the weight:
 *
 *   1. **Every factual line names its source.** A sentence about the user's money that no
 *      document supports is a sentence they cannot check, and cannot defend.
 *   2. **Nothing is invented.** Where a value is absent the draft asks; it never fills a
 *      plausible number into a letter someone will file.
 *   3. **No legal argument.** The draft reports what happened. It does not call anyone
 *      negligent, unfair or in breach — those are the forum's conclusions, not the app's,
 *      and certainly not on the strength of an OCR read.
 *   4. **The relief is always the user's to write.** The app does not know what outcome
 *      someone wants, so it never proposes one.
 */

/** 2024-06-01 — 92 days after the complaint below. */
const JUNE_1 = Date.UTC(2024, 5, 1);
const DAY = 86_400_000;

const BANK_COMPLAINT = [
  'To: Grievance Officer, State Bank',
  'Date: 01/03/2024',
  'Complaint reference: SBI/GRV/88421',
  'I am writing to complain about a failed UPI transfer from my savings account.',
  'The amount of INR 4,200.00 was debited but never credited. Kindly resolve and refund.',
].join('\n');

/**
 * Dated *before* the complaint, and that is load-bearing rather than incidental.
 *
 * `longestSilence` treats anything in the case dated after the complaint as evidence the case
 * did not go quiet, and refuses to produce a draft — deliberately, because deciding from a
 * document's contents whether it is a reply is the judgement that, made wrong, tells someone
 * nobody answered them when somebody did. A statement dated after the complaint would
 * therefore suppress the draft, and a test that worked around it by relaxing that guard would
 * be testing a product that is wrong in the dangerous direction.
 *
 * It is also simply what the documents look like: you complain *about* a transaction that has
 * already appeared on your statement.
 */
const BANK_STATEMENT = [
  'ACCOUNT STATEMENT',
  'Statement Date: 25/02/2024',
  'UPI transfer INR 4,200.00 debited, not credited to beneficiary.',
].join('\n');

const extractionOf = (items: readonly Evidence[]) => (id: string) =>
  items.find((item) => item.id === id)?.extraction ?? null;

/** The complaint first, so a draft is produced; extra documents follow. */
function draftFor(more: Evidence[] = [], complaint: Evidence = evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint to bank' })) {
  const items = [complaint, ...more];
  return buildFilingDraft(items, extractionOf(items), JUNE_1);
}

const linesOf = (draft: NonNullable<ReturnType<typeof buildFilingDraft>>) =>
  draft.sections.flatMap((section) => section.lines);

const allText = (draft: NonNullable<ReturnType<typeof buildFilingDraft>>) =>
  linesOf(draft)
    .map((item) => item.text)
    .join('\n');

beforeEach(resetIds);

describe('which organisation the letter is addressed against', () => {
  it('reads the respondent off the complaint’s own addressee line', () => {
    // `extraction.organizations` is empty for this document — "State Bank" carries no
    // legal-form word and `to` is not a commercial label, so the extractor files the line
    // under people. A letter to the Ombudsman that cannot name the bank is not usable.
    expect(draftFor()!.sections[0]!.lines[0]!.text).toContain('RBI Ombudsman');
    expect(allText(draftFor()!)).toContain('complaint I raised with State Bank');
  });

  it('takes the body, not the job title, when the line reads "Role, Organisation"', () => {
    // The failure this guards: a letter addressed against "Grievance Officer", which is a
    // job title and not a party.
    const text = allText(draftFor()!);
    expect(text).toContain('State Bank');
    expect(text).not.toContain('raised with Grievance Officer');
  });

  it('resolves an organisation whose name carries no sector word, from the line’s structure', () => {
    // "To: The Manager, Airtel" — no sector vocabulary appears anywhere. Structure alone has
    // to carry it, or a very ordinary telecom complaint gets a blank where the respondent
    // belongs.
    const complaint = evidence(
      [
        'To: The Manager, Airtel',
        'Date: 01/03/2024',
        'Complaint reference: AIR/GRV/7788',
        'I am writing to complain about my broadband connection being down.',
        'The amount of INR 999.00 was charged for a service I did not receive.',
      ].join('\n'),
      { id: 'evd_c', title: 'Complaint to Airtel' },
    );
    expect(allText(draftFor([], complaint)!)).toContain('raised with Airtel');
  });

  it('asks rather than guesses when the addressee is a person', () => {
    // "To: Ramesh" has no role to lean on and no sector word. Assuming a surname is a company
    // would put a private individual at the top of a letter to a regulator.
    const complaint = evidence(
      [
        'To: Ramesh',
        'Date: 01/03/2024',
        'Complaint reference: XYZ/GRV/88421',
        'I am writing to complain about work not done.',
        'The amount of INR 4,200.00 was paid.',
      ].join('\n'),
      { id: 'evd_c', title: 'Complaint' },
    );
    const draft = draftFor([], complaint)!;

    // sections[2] is "What this is about". sections[1] is the Subject line, which is a FACT
    // here on the strength of the reference number and says nothing about the respondent.
    expect(draft.sections[2]!.lines[0]!.kind).toBe('BLANK');
    expect(draft.gaps.map((gap) => gap.what)).toContain(
      'The full name of the organisation you are complaining about',
    );
  });
});

describe('every factual line names where it came from', () => {
  it('gives every FACT line an evidence id, and no other kind one', () => {
    // The property the whole design rests on: a sentence about the user's money that no
    // document supports is a sentence they can neither check nor defend.
    for (const item of linesOf(draftFor([evidence(BANK_STATEMENT, { id: 'evd_s' })])!)) {
      if (item.kind === 'FACT') expect(item.evidenceId).toBe('evd_c');
      else expect(item.evidenceId).toBeNull();
    }
  });

  it('points every factual line at the complaint, which is what the letter is about', () => {
    const facts = linesOf(draftFor([evidence(BANK_STATEMENT, { id: 'evd_s' })])!)
      .filter((item) => item.kind === 'FACT')
      .map((item) => item.evidenceId);

    expect(facts.length).toBeGreaterThan(0);
    expect([...new Set(facts)]).toEqual(['evd_c']);
  });

  it('marks nothing for checking when every value was read from the file itself', () => {
    const draft = draftFor()!;
    expect(draft.checkBeforeFiling).toEqual([]);
    expect(linesOf(draft).every((item) => !item.needsCheck)).toBe(true);
  });
});

describe('what it refuses to invent', () => {
  it('asks for the amount rather than choosing between two figures', () => {
    // An invoice total, a partial payment and a penalty charge are all "the amount" in a
    // case. Picking one would put a number in front of the ombudsman the user never chose.
    const complaint = evidence(
      [
        'To: Grievance Officer, State Bank',
        'Date: 01/03/2024',
        'Complaint reference: SBI/GRV/88421',
        'I am writing to complain about a failed UPI transfer.',
        'The amount of INR 4,200.00 was debited but never credited.',
        'I was additionally charged INR 250.00 as a penalty for the failed transfer.',
      ].join('\n'),
      { id: 'evd_c', title: 'Complaint' },
    );
    const draft = draftFor([], complaint)!;

    const about = draft.sections[2]!.lines;
    expect(about[1]!.kind).toBe('BLANK');
    expect(about[1]!.placeholder).toBe('The sum in dispute, as one figure');
    expect(allText(draft)).not.toContain('4,200.00'); // and does not leak the candidate either
    expect(draft.gaps.map((gap) => gap.what)).toContain('The amount in dispute, as a single figure');
  });

  it('always leaves the relief sought to the user', () => {
    // The app has no basis to know whether someone wants money back, a service restored, or a
    // record corrected — and proposing one puts words in the user's mouth that they did not
    // choose.
    const relief = draftFor()!.sections.find((section) => section.heading === 'What I am asking for')!;

    expect(relief.lines).toHaveLength(1);
    expect(relief.lines[0]!.kind).toBe('BLANK');
    expect(relief.lines[0]!.placeholder).toBe('What outcome you want');
  });

  it('asks for the details only the user can supply', () => {
    const blanks = linesOf(draftFor()!)
      .filter((item) => item.kind === 'BLANK')
      .map((item) => item.placeholder);

    expect(blanks).toContain('Your full name');
    expect(blanks).toContain('Your postal address');
    expect(blanks).toContain('A phone number and email they can reach you on');
    expect(blanks).toContain('The account, policy or connection number this concerns');
  });
});

describe('what it refuses to argue', () => {
  const draft = () => draftFor()!;
  const text = () => allText(draft()).toLowerCase();

  it('states no deadline, no limitation date and no time remaining', () => {
    // Same line the escalation rule holds. The letter reports how long it has been, and
    // quotes a window with its scheme named. It never tells anyone how long they have left.
    for (const forbidden of [
      /deadline/,
      /last date/,
      /days? (?:left|remaining)/,
      /you have \d+ days/,
      /expires?/,
      /limitation period/,
      /must file/,
    ]) {
      expect(text()).not.toMatch(forbidden);
    }
  });

  it('characterises nobody’s conduct', () => {
    // "Negligent", "deficient", "unfair", "in breach" are the forum's conclusions to draw.
    // Putting them in the user's mouth on the strength of a machine reading is indefensible.
    for (const forbidden of [
      /\bnegligen/,
      /\bdeficien/,
      /\bunfair/,
      /\bin breach/,
      /\bviolat/,
      /\bcheat/,
      /\bfraud/,
      /\billegal/,
      /\bunlawful/,
      /\bmisconduct/,
    ]) {
      expect(text()).not.toMatch(forbidden);
    }
  });

  it('claims nothing is proved, verified or confirmed', () => {
    for (const forbidden of [/\bproves?\b/, /\bproved\b/, /\bverified\b/, /\bconfirmed\b/, /\bauthentic\b/]) {
      expect(text()).not.toMatch(forbidden);
    }
  });

  it('attributes the reply window to a named scheme instead of asserting it', () => {
    const body = allText(draft());
    expect(body).toContain('Integrated Ombudsman Scheme, 2021');
    expect(body).toMatch(/generally expected to respond/i);
  });

  it('keeps a caveat on any value that was read off an image', () => {
    // Refusing to use an OCR value would leave the form empty; using it silently would put a
    // guess in a letter to a regulator. So it is used, marked, and listed.
    const complaint = evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Scanned complaint', method: 'OCR' });
    const scanned = draftFor([], complaint)!;

    expect(linesOf(scanned).some((item) => item.needsCheck)).toBe(true);
    expect(scanned.checkBeforeFiling.length).toBeGreaterThan(0);
    expect(scanned.checkBeforeFiling.map((read) => read.reading)).toContain('INR 4,200.00');
  });

  it('names the respondent in the check list when it was read from a scan', () => {
    // The respondent is the one value that may not come from an extracted field at all — it
    // falls back to the addressee line — so it is the one value that could silently skip the
    // checklist. That would leave the party the letter is addressed against unchecked.
    const complaint = evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Scanned complaint', method: 'OCR' });
    const scanned = draftFor([], complaint)!;

    expect(scanned.checkBeforeFiling.some((read) => read.label === 'Organisation')).toBe(true);
  });
});

describe('the annexure list', () => {
  it('numbers the complaint first, whatever order the case holds it in', () => {
    // The complaint is the document the whole letter is about. Its serial must not depend on
    // where it happens to sit in the workspace.
    const statement = evidence(BANK_STATEMENT, { id: 'evd_s', title: 'Bank statement' });
    const complaint = evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint to bank' });

    for (const items of [
      [complaint, statement],
      [statement, complaint],
    ]) {
      const draft = buildFilingDraft(items, extractionOf(items), JUNE_1)!;
      expect(draft.annexures[0]).toMatchObject({ serial: 1, title: 'Complaint to bank' });
      expect(draft.annexures[1]).toMatchObject({ serial: 2, title: 'Bank statement' });
    }
  });

  it('prints the file fingerprint, which is the only identifier that exists outside the app', () => {
    const draft = draftFor()!;
    expect(draft.annexures[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries each document’s own date where it had one', () => {
    expect(draftFor()!.annexures[0]!.date).toBe('1 March 2024');
  });
});

describe('what it says is missing', () => {
  it('asks for support when the case holds only the complaint', () => {
    expect(draftFor()!.gaps.map((gap) => gap.what)).toContain(
      'A document showing what happened — a statement, receipt, screenshot or bill',
    );
  });

  it('stops asking for support once the case holds some', () => {
    const draft = draftFor([evidence(BANK_STATEMENT, { id: 'evd_s' })])!;
    expect(draft.gaps.map((gap) => gap.what)).not.toContain(
      'A document showing what happened — a statement, receipt, screenshot or bill',
    );
  });

  it('gives every gap a reason a reader can act on', () => {
    for (const gap of draftFor()!.gaps) {
      expect(gap.what.length).toBeGreaterThan(10);
      expect(gap.why.length).toBeGreaterThan(20);
    }
  });
});

describe('when no draft should exist', () => {
  const complaint = () => evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint' });

  it('produces nothing while the complaint is still inside its reply window', () => {
    const items = [complaint()];
    expect(buildFilingDraft(items, extractionOf(items), Date.UTC(2024, 2, 20))).toBeNull();
  });

  it('produces nothing once something in the case is dated after the complaint', () => {
    // A draft escalation for a complaint that was answered last week is not a lesser output.
    // It is a wrong one, and it would be sent.
    const reply = evidence(
      ['From: Grievance Redressal Cell, State Bank', 'Date: 15/05/2024', 'We have reviewed the transaction.'].join('\n'),
      { id: 'evd_r', title: 'Bank reply' },
    );
    const items = [complaint(), reply];
    expect(buildFilingDraft(items, extractionOf(items), JUNE_1)).toBeNull();
  });

  it('produces nothing for a case with no complaint in it', () => {
    const items = [evidence('TAX INVOICE\nInvoice Date: 01/03/2024\nTotal: INR 85,000.00\n', { id: 'evd_i' })];
    expect(buildFilingDraft(items, extractionOf(items), JUNE_1)).toBeNull();
  });
});

describe('the questions it puts to the user', () => {
  it('gives every BLANK a slot and exactly one bracketed gap, and no other kind a slot', () => {
    // The invariant the fill mechanism rests on. A BLANK with no gap can never be answered —
    // the answer has nowhere to go — and a BLANK with two would fill only the first, leaving
    // a bracket in a letter someone signs. This catches a malformed `blank()` call at the
    // point it is written rather than on a regulator's desk.
    for (const item of linesOf(draftFor([evidence(BANK_STATEMENT, { id: 'evd_s' })])!)) {
      if (item.kind !== 'BLANK') {
        expect(item.slot).toBeNull();
        continue;
      }

      expect(item.slot).not.toBeNull();
      expect(item.placeholder).toBeTruthy();
      expect(item.text.match(/\[[^\]]*\]/g)).toHaveLength(1);
    }
  });

  it('separates what belongs to the person from what belongs to this dispute', () => {
    // The split exists so a second complaint does not make someone retype their own address,
    // while the account number of a previous dispute is never carried into a new letter.
    const questions = draftQuestions(draftFor()!);
    const personal = questions.filter((question) => question.personal).map((question) => question.slot);
    const caseBound = questions.filter((question) => !question.personal).map((question) => question.slot);

    expect(personal).toEqual([...PERSONAL_SLOTS]);
    expect(caseBound).toContain('accountNumber');
    expect(caseBound).toContain('relief');
    expect(caseBound).not.toContain('name');
  });

  it('asks in the order the letter reads, so answering top to bottom fills it top to bottom', () => {
    const slots = draftQuestions(draftFor()!).map((question) => question.slot);
    expect(slots.slice(0, 3)).toEqual(['name', 'address', 'contact']);
    expect(slots[slots.length - 1]).toBe('place');
  });

  it('leaves a FACT line alone whatever answers are passed', () => {
    // Answers fill gaps. They must never rewrite a sentence assembled from a document.
    const facts = linesOf(draftFor()!).filter((item) => item.kind === 'FACT');

    expect(facts.length).toBeGreaterThan(0);
    for (const item of facts) {
      expect(fillLine(item, { name: 'Ramesh Kumar', amount: '₹99,999' })).toBe(item.text);
    }
  });
});

describe('rendering and readiness', () => {
  it('renders the whole letter as text a person can paste into a form', () => {
    const text = renderDraftText(draftFor([evidence(BANK_STATEMENT, { id: 'evd_s', title: 'Bank statement' })])!);

    expect(text).toContain('ANNEXURES');
    expect(text).toContain('1. Complaint to bank');
    expect(text).toContain('2. Bank statement');
    expect(text).toContain('SHA-256');
  });

  it('keeps unfilled blanks visible as brackets rather than as empty space', () => {
    // An unfilled `[your full name]` cannot be missed. A blank line can, and gets sent.
    expect(renderDraftText(draftFor()!)).toContain('[your full name]');
  });

  it('says the fingerprint does not establish that a document is genuine', () => {
    expect(renderDraftText(draftFor()!)).toMatch(/does not establish that a document is genuine/i);
  });

  it('counts what must be written and what must be checked, as numbers rather than a verdict', () => {
    // "72% complete" invites someone to send a letter with a name missing from it.
    const draft = draftFor()!;
    const readiness = draftReadiness(draft);

    // Questions, not lines — and the two differ on purpose. The letter carries seven BLANK
    // lines but asks six questions, because `name` fills both the From line and the
    // signature. Counting lines would tell a user who has written their name once that they
    // still have two things left to do.
    expect(readiness.blanks).toBe(draftQuestions(draft).length);
    expect(readiness.blanks).toBeLessThan(linesOf(draft).filter((item) => item.kind === 'BLANK').length);
    expect(readiness.blanks).toBeGreaterThan(0);
    expect(readiness.toCheck).toBe(0);
  });

  it('counts down as the user writes, and reaches zero when every question is answered', () => {
    const draft = draftFor()!;
    const questions = draftQuestions(draft);

    expect(draftReadiness(draft, { name: 'Ramesh Kumar' }).blanks).toBe(questions.length - 1);
    // Whitespace is not an answer. A field someone opened and left alone must still count.
    expect(draftReadiness(draft, { name: '   ' }).blanks).toBe(questions.length);

    const answered = Object.fromEntries(questions.map((question) => [question.slot, 'written']));
    expect(draftReadiness(draft, answered).blanks).toBe(0);
  });

  it('asks for the name once, and fills both lines that need it', () => {
    // The dedupe that makes the form finishable: a page that asks for your name twice is a
    // page people give up on halfway down.
    const draft = draftFor()!;
    const name = draftQuestions(draft).find((question) => question.slot === 'name')!;
    expect(name.lines).toBe(2);

    const text = renderDraftText(draft, { name: 'Ramesh Kumar' });
    expect(text).toContain('From: Ramesh Kumar');
    expect(text).toContain('Signed: Ramesh Kumar');
    expect(text).not.toContain('[your full name]');
    expect(text).not.toContain('[your name]');
  });

  it('keeps every unanswered gap in brackets while filling the answered ones', () => {
    const text = renderDraftText(draftFor()!, { name: 'Ramesh Kumar' });

    expect(text).toContain('Ramesh Kumar');
    expect(text).toContain('[your address]'); // still unanswered, still impossible to miss
  });
});

describe('determinism', () => {
  it('produces the same letter twice for the same case and clock', () => {
    // The whole reason this is assembled rather than generated by a model: the same case on
    // the same day must produce the same document, byte for byte.
    const items = [evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint' }), evidence(BANK_STATEMENT, { id: 'evd_s' })];
    const once = renderDraftText(buildFilingDraft(items, extractionOf(items), JUNE_1)!);
    const twice = renderDraftText(buildFilingDraft(items, extractionOf(items), JUNE_1)!);

    expect(twice).toBe(once);
  });

  it('tracks the days elapsed to the clock it was given', () => {
    expect(allText(draftFor()!)).toContain('92 days have passed');

    const items = [evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint' })];
    const later = buildFilingDraft(items, extractionOf(items), JUNE_1 + 30 * DAY)!;
    expect(later.daysElapsed).toBe(122);
    expect(allText(later)).toContain('122 days have passed');
  });
});

/**
 * The selector the screen actually calls.
 *
 * `buildFilingDraft` is handed its evidence and an extraction lookup; every caller in the app
 * goes through this wrapper instead, which picks the case's own live documents out of the
 * workspace and reads each through `effectiveExtraction`. Those three steps are what stand
 * between a user's confirmed correction and a letter that repeats the machine's original
 * misreading anyway, so they are tested here rather than assumed.
 */
describe('drafting from a workspace', () => {
  const complaint = () => evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint to bank' });

  it('carries the limitation window for the forum it addresses', () => {
    // 92 days into a 395-day banking window, so there is time and the state is unremarkable.
    const state = workspace({ evidence: [complaint()] });

    const draft = filingDraftForCase(state, CASE_ID, JUNE_1);

    expect(draft!.limitation.state).toBe('OPEN');
    expect(draft!.limitation.daysRemaining).toBe(303);
  });

  it('measures the window from the same day the letter is dated from', () => {
    // The elapsed count and the window must not disagree about when the clock started: 92
    // days gone plus 303 left is the whole 395-day period.
    const draft = filingDraftForCase(workspace({ evidence: [complaint()] }), CASE_ID, JUNE_1);

    expect(draft!.daysElapsed + draft!.limitation.daysRemaining!).toBe(395);
  });

  it('asks for an explanation of the delay once the window has closed', () => {
    // Two years and more after the complaint. The forum can still hear it, so the draft does
    // not give up — it asks for the one thing that decides whether it will.
    const draft = filingDraftForCase(
      workspace({ evidence: [complaint()] }),
      CASE_ID,
      JUNE_1 + 800 * DAY,
    );

    expect(draft!.limitation.state).toBe('CLOSED');
    const delay = draft!.gaps.find((gap) => gap.what.includes('why this is being brought now'));
    expect(delay).toBeDefined();
    expect(delay!.why).toContain('Clause 10(2)(a)(ii)');
  });

  it('does not ask about delay while the window is open', () => {
    const draft = filingDraftForCase(workspace({ evidence: [complaint()] }), CASE_ID, JUNE_1);

    expect(draft!.gaps.some((gap) => gap.what.includes('why this is being brought now'))).toBe(
      false,
    );
  });

  it('drafts from the case’s own live documents', () => {
    const state = workspace({ evidence: [complaint()] });

    const draft = filingDraftForCase(state, CASE_ID, JUNE_1);

    expect(draft).not.toBeNull();
    expect(draft!.daysElapsed).toBe(92);
  });

  it('returns null for a case the workspace does not hold', () => {
    // Not an error. A screen calls this on every render, including during a delete when the
    // case has gone and the screen has not unmounted yet.
    const state = workspace({ evidence: [complaint()] });

    expect(filingDraftForCase(state, 'case_absent', JUNE_1)).toBeNull();
  });

  it('returns null for a deleted case', () => {
    const state = workspace({
      cases: [testCase({ deletedAt: 2_000 })],
      evidence: [complaint()],
    });

    expect(filingDraftForCase(state, CASE_ID, JUNE_1)).toBeNull();
  });

  it('ignores documents belonging to another case', () => {
    // `evidence()` stamps everything with the default case, so this one document is the
    // only thing separating a letter about this dispute from a letter about someone's.
    const other = evidence(BANK_COMPLAINT, { id: 'evd_o', caseId: 'case_other' });
    const state = workspace({ evidence: [other] });

    expect(filingDraftForCase(state, CASE_ID, JUNE_1)).toBeNull();
  });

  it('ignores deleted documents', () => {
    const state = workspace({
      evidence: [complaint(), evidence(BANK_STATEMENT, { id: 'evd_s', deletedAt: 2_000 })],
    });

    const draft = filingDraftForCase(state, CASE_ID, JUNE_1)!;

    expect(draft.annexures).toHaveLength(1);
    expect(draft.annexures[0]!.title).not.toContain('Statement');
  });

  it('reads each document through the user’s confirmed corrections, not the raw extraction', () => {
    // The failure this guards against: the user corrects a misread amount in the review
    // screen, the case stores the correction, and the letter goes out quoting the machine's
    // original figure — the figure the user had already told the app was wrong. A letter
    // that misstates the amount in dispute is worse than no letter.
    const misread = evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint', method: 'OCR' });
    const rawAmount = misread.extraction!.amounts[0]!;
    expect(isUnconfirmedReading(rawAmount.method)).toBe(true);

    const corrected = {
      ...misread,
      confirmedFields: { [fieldPath('amounts', 0)]: 'INR 4,800.00' },
    };
    const state = workspace({ evidence: [corrected] });

    const draft = filingDraftForCase(state, CASE_ID, JUNE_1)!;
    const text = renderDraftText(draft);

    expect(text).toContain('INR 4,800.00');
    expect(text).not.toContain(rawAmount.original);
    // And the value stops being something the user is told to check: they are the one who
    // said what it should be.
    expect(draft.checkBeforeFiling.map((read) => read.reading)).not.toContain(rawAmount.original);
  });

  it('is not affected by the order the workspace happens to hold its documents in', () => {
    // The store appends as the user uploads, so the array order is a record of when files
    // were added — not of anything about the dispute. The letter must not change because a
    // user re-uploaded a document.
    const first = complaint();
    const second = evidence(BANK_STATEMENT, { id: 'evd_s', title: 'Bank statement' });

    const forwards = filingDraftForCase(workspace({ evidence: [first, second] }), CASE_ID, JUNE_1)!;
    const backwards = filingDraftForCase(workspace({ evidence: [second, first] }), CASE_ID, JUNE_1)!;

    expect(renderDraftText(backwards)).toBe(renderDraftText(forwards));
  });
});

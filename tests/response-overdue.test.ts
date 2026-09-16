import { beforeEach, describe, expect, it } from 'vitest';

import type { Evidence } from '@domain/models';
import { responseOverdueRule } from '@domain/rules/definitions/response-overdue';
import { applyAnalysisRun, buildRuleContext, runAnalysis } from '@domain/rules/engine';
import { RULES } from '@domain/rules/registry';

import { CASE_ID, evidence, resetIds, workspace } from './helpers';

/**
 * The escalation clock, as the engine runs it.
 *
 * `tests/escalation.test.ts` covers the knowledge layer — which forum, which window, when a
 * silence is real. This file covers the part that can hurt someone: what the rule *says*, and
 * when it refuses to speak at all.
 *
 * Two properties matter more than whether it fires:
 *
 *   1. **It states no deadline.** It reports elapsed days as arithmetic and quotes a reply
 *      window attributed to a named scheme. A countdown — "you have 41 days left to file" —
 *      would be advice this app has no basis to give, and being wrong about it costs someone
 *      their claim rather than a phone call.
 *   2. **It is silent without a clock.** The derived read models build a context with
 *      `now: null`. A rule that fell back to `Date.now()` would make the analysis
 *      irreproducible and would report elapsed time from a date its caller never supplied.
 */

/** 2024-06-01, as epoch ms — 92 days after the complaint below. */
const JUNE_1 = Date.UTC(2024, 5, 1);
const DAY = 86_400_000;

const BANK_COMPLAINT = [
  'To: Grievance Officer, State Bank',
  'Date: 01/03/2024',
  'Complaint reference: SBI/GRV/88421',
  'I am writing to complain about a failed UPI transfer from my savings account.',
  'Account Number: 3081 4429 0071, IFSC: SBIN0001234',
  'The amount was debited but never credited. Kindly resolve and refund.',
].join('\n');

/** Dated after the complaint, and deliberately not complaint-shaped itself. */
const BANK_REPLY = [
  'From: Grievance Redressal Cell, State Bank',
  'Date: 15/05/2024',
  'We have reviewed the transaction on account 3081 4429 0071.',
  'The amount of INR 4,200.00 has been credited back to your savings account.',
].join('\n');

/** Runs the whole engine, and returns only what this rule produced. */
function overdueFindings(items: Evidence[], now: number) {
  const run = runAnalysis(workspace({ evidence: items }), CASE_ID, now);
  return run.results.filter((result) => result.resultType === 'RESPONSE_OVERDUE');
}

beforeEach(resetIds);

describe('response-overdue, end to end', () => {
  it('reports a bank complaint nobody answered, through the real engine', () => {
    const findings = overdueFindings([evidence(BANK_COMPLAINT, { title: 'Complaint to bank' })], JUNE_1);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('92 days');
    expect(findings[0]!.severity).toBe('MEDIUM');
    expect(findings[0]!.confidence).toBe('NEEDS_REVIEW');
  });

  it('is registered, so the finding reaches the Analysis Center without further wiring', () => {
    expect(RULES).toContain(responseOverdueRule);
    expect(responseOverdueRule.enabled).toBe(true);
  });

  it('carries the numbers it used into inputs, so the count can be checked by hand', () => {
    const findings = overdueFindings([evidence(BANK_COMPLAINT, { title: 'Complaint to bank' })], JUNE_1);
    const inputs = findings[0]!.inputs;

    expect(inputs['Days since']).toBe('92');
    expect(inputs['Complaint']).toContain('1 March 2024');
    expect(inputs['Reference']).toBe('SBI/GRV/88421');
    expect(inputs['Reply window quoted']).toContain('30 days');
  });
});

describe('what the finding is allowed to say', () => {
  const explanationFor = (now = JUNE_1): string =>
    overdueFindings([evidence(BANK_COMPLAINT, { title: 'Complaint to bank' })], now)[0]!.explanation;

  it('names the scheme it is quoting, never the window on its own authority', () => {
    const explanation = explanationFor();
    expect(explanation).toContain('Integrated Ombudsman Scheme');
    expect(explanation).toContain('30 days');
    expect(explanation).toContain('Ombudsman');
  });

  it('tells the reader to check the current rules before acting', () => {
    expect(explanationFor()).toMatch(/check the current rules/i);
  });

  it('states no deadline, no limitation date and no time remaining', () => {
    // The failure this guards is the one that turns a helpful prompt into harmful advice:
    // a countdown the reader cannot falsify and the app cannot substantiate.
    const explanation = explanationFor();
    for (const forbidden of [
      /deadline/i,
      /last date/i,
      /days? (?:left|remaining)/i,
      /you have \d+ days/i,
      /expires?/i,
      /limitation period/i,
      /must file/i,
      /before \d+ \w+ \d{4}/i,
    ]) {
      expect(explanation).not.toMatch(forbidden);
    }
  });

  it('claims nothing about what the documents prove', () => {
    // The product-wide language rule. A silence is an observation about dates in a case,
    // not a finding about anyone's conduct.
    const explanation = explanationFor();
    for (const forbidden of [/\bproves?\b/i, /\bverified\b/i, /\bauthentic\b/i, /\bfraud/i, /\bnegligen/i]) {
      expect(explanation).not.toMatch(forbidden);
    }
  });

  it('tells the reader how to make it go away', () => {
    expect(explanationFor()).toMatch(/if a reply did arrive/i);
  });
});

describe('when it refuses to speak', () => {
  it('says nothing at all when no clock was supplied', () => {
    // `buildRuleContext` without a `now` is what timeline, graph, claim-state and the
    // compare screen build. A rule that assumed today here would report elapsed time from
    // a date nobody passed it.
    const items = [evidence(BANK_COMPLAINT, { title: 'Complaint to bank' })];
    const context = buildRuleContext(workspace({ evidence: items }), CASE_ID);

    expect(context.now).toBeNull();
    expect(responseOverdueRule.evaluate(context)).toEqual([]);
  });

  it('says nothing while the complaint is still inside its reply window', () => {
    const twentyNineDays = Date.UTC(2024, 2, 1) + 29 * DAY;
    expect(overdueFindings([evidence(BANK_COMPLAINT)], twentyNineDays)).toEqual([]);
  });

  it('says nothing once anything in the case is dated after the complaint', () => {
    // Deliberately indifferent to whether the later document is *really* a reply. Reading a
    // PDF to decide that is exactly the judgement that gets made wrong, and getting it wrong
    // means telling someone nobody answered them when somebody did.
    const items = [
      evidence(BANK_COMPLAINT, { title: 'Complaint to bank' }),
      evidence(BANK_REPLY, { title: 'Bank reply' }),
    ];
    expect(overdueFindings(items, JUNE_1)).toEqual([]);
  });

  it('says nothing about a case with no complaint in it', () => {
    const invoice = 'TAX INVOICE\nInvoice Date: 01/03/2024\nTotal: INR 85,000.00\n';
    expect(overdueFindings([evidence(invoice)], JUNE_1)).toEqual([]);
  });
});

describe('living with the finding', () => {
  const items = () => [evidence(BANK_COMPLAINT, { id: 'evd_complaint', title: 'Complaint to bank' })];

  it('keeps the same id as the days tick up, so the count updates in place', () => {
    // Keyed on the day count, this would mint a new finding every morning and leave a trail
    // of stale ones behind it.
    const today = overdueFindings(items(), JUNE_1)[0]!;
    const nextMonth = overdueFindings(items(), JUNE_1 + 30 * DAY)[0]!;

    expect(nextMonth.id).toBe(today.id);
    expect(today.title).toContain('92 days');
    expect(nextMonth.title).toContain('122 days');
  });

  it('stays dismissed once dismissed, however many days pass', () => {
    // The consequence of the id being stable: a person who has decided this prompt is not
    // for them is not asked again tomorrow.
    const first = runAnalysis(workspace({ evidence: items() }), CASE_ID, JUNE_1);
    const dismissed = applyAnalysisRun(workspace({ evidence: items() }), first, CASE_ID);
    dismissed.analysisResults = dismissed.analysisResults.map((result) =>
      result.resultType === 'RESPONSE_OVERDUE' ? { ...result, status: 'DISMISSED' as const } : result,
    );

    const later = runAnalysis(dismissed, CASE_ID, JUNE_1 + 60 * DAY);
    const overdue = later.results.filter((result) => result.resultType === 'RESPONSE_OVERDUE');

    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.status).toBe('DISMISSED');
    expect(overdue[0]!.title).toContain('152 days');
  });
});

describe('when the date itself was read off a scan', () => {
  const scanned = () => [evidence(BANK_COMPLAINT, { title: 'Scanned complaint', method: 'OCR' })];

  it('warns that the number of days rests on an unconfirmed reading', () => {
    // Every other rule reasons about values agreeing. This one reasons about a subtraction,
    // and an OCR misread of the start date moves the answer without contradicting anything.
    const finding = overdueFindings(scanned(), JUNE_1)[0]!;

    expect(finding.explanation).toMatch(/read from an image/i);
    expect(finding.inputs['Where the date came from']).toBe('Read from an image — unconfirmed');
  });

  it('does not mark itself provisional, because it accuses no one of disagreeing', () => {
    // The quarantine is for conflict-shaped findings. Demoting this one would say "these
    // documents might not really disagree" about a finding that never claimed they did.
    const finding = overdueFindings(scanned(), JUNE_1)[0]!;

    expect(finding.provisional).toBe(false);
    expect(finding.severity).toBe('MEDIUM');
  });

  it('says the date came from the document when it actually did', () => {
    const finding = overdueFindings([evidence(BANK_COMPLAINT)], JUNE_1)[0]!;

    // This asserted the literal `'DETERMINISTIC'` — while the test's own name described the
    // sentence a reader should see. The rule had no reach to `EXTRACTION_METHOD_LABELS`, which
    // lived in the UI layer, so it wrote the enum member and the finding table showed it.
    expect(finding.inputs['Where the date came from']).toBe('Read from the document');
    expect(finding.explanation).not.toMatch(/read from an image/i);
  });
});

/**
 * Rule copy — the budget, and the obligation to say why.
 *
 * `docs/copy-doctrine.md` sets out the split this file enforces: a finding's `explanation` is
 * the observation, its `caveat` is the reason that reading might be wrong, and the next step is
 * a control rather than a sentence. That doctrine exists because of a measured defect. Rule
 * explanations ran 200–730 characters; `FindingCard` clipped them at three lines, roughly 150;
 * and what truncation ate first was reliably the hedge, because the hedge was written last. So
 * the one part of a finding that tells a reader not to trust it was the part they never saw.
 *
 * The card now renders `explanation` in full and gives `caveat` a control of its own. That is
 * only safe while the observation stays short, and "stays short" is not something review
 * catches slipping — one rule gaining a clause reads as a helpful edit, and the regression is
 * invisible until a card somewhere clips again. Hence a test.
 *
 * ## Why this runs the real rules rather than reading the definitions
 *
 * Every explanation here is a template. The length that matters is the length *after* a
 * document title, an amount and a date are interpolated in, and a rule whose source looks
 * brief can emit a long string once a filename lands in it. Grepping the definitions would
 * measure the wrong thing, so this runs the engine over the sample corpus — the same
 * multi-document case `tests/rule-engine-corpus.test.ts` uses — and measures what comes out.
 *
 * Coverage is partial by construction: a rule the corpus does not trigger is not checked here.
 * That is an accepted limit rather than an oversight. The budget exists to catch drift in the
 * rules people actually edit, and every rule the corpus does reach is a rule whose rendered
 * output is now pinned.
 */

import { describe, expect, it } from 'vitest';

import { runAnalysis } from '@domain/rules/engine';
import { RULES } from '@domain/rules/registry';
import type { AnalysisResult } from '@domain/models';

import { buildSampleWorkspace, SAMPLE_CASE_ID } from './fixtures/build-sample-workspace';

/**
 * The observation budget, in characters.
 *
 * Derived from the card rather than picked: `bodySmall` on the narrowest phone the app
 * supports fits roughly 50 characters to a line, and three lines of unclipped observation is
 * as much as can sit above the fold beside a title, a severity rule and the card's own
 * controls. 180 is that, rounded down.
 *
 * Note the floor this sits above. `tests/rule-engine-corpus.test.ts` already requires every
 * explanation to exceed 80 characters, on the grounds that a finding too terse to be
 * understood is its own failure. Together the two make a band: long enough to be a sentence,
 * short enough to be read whole. A rule that needs more room than the band allows has
 * somewhere to put it, which is the entire point of the split.
 */
const OBSERVATION_BUDGET = 180;

const OWNER = 'user_copy';
const workspace = buildSampleWorkspace(OWNER);

/**
 * The corpus findings, plus a second pass with a late clock.
 *
 * `response-overdue` is the one rule that reads `context.now`, and the workspace builder runs
 * analysis at the case's own date. Running again from a year later is cheap and reaches any
 * rule whose trigger is elapsed time. It does not reach `response-overdue` itself — that rule
 * needs a complaint-shaped document with a recognised sector, which this corpus has no reason
 * to contain — so that rule's copy is covered by `tests/escalation.test.ts` instead.
 *
 * The union is deduplicated by id because every other rule fires in both passes and would
 * otherwise be measured twice: harmless for a maximum, but misleading in a failure message
 * that listed the same rule over and over.
 */
const findings: AnalysisResult[] = (() => {
  const later = runAnalysis(workspace, SAMPLE_CASE_ID, Date.parse('2025-04-05T09:00:00.000Z'));
  const byId = new Map<string, AnalysisResult>();
  for (const result of [...workspace.analysisResults, ...later.results]) byId.set(result.id, result);
  return [...byId.values()];
})();

/** Which rule produced a finding, for failure messages that name the file to open. */
const ruleOf = (finding: AnalysisResult) => finding.triggeredRuleIds.join(',') || finding.resultType;

describe('rule copy — the observation', () => {
  it('reaches enough rules for the budget to mean anything', () => {
    // A guard on the guard. If the corpus stops producing findings — a builder changes, a rule
    // gains a precondition — every assertion below would pass vacuously over an empty array
    // and the budget would quietly stop being enforced.
    const rulesReached = new Set(findings.flatMap((finding) => finding.triggeredRuleIds));
    expect(rulesReached.size).toBeGreaterThanOrEqual(9);
  });

  it('keeps every observation inside the budget', () => {
    const over = findings
      .filter((finding) => finding.explanation.length > OBSERVATION_BUDGET)
      .map((finding) => ({
        rule: ruleOf(finding),
        length: finding.explanation.length,
        text: finding.explanation,
      }));

    // Reported as the whole list with the offending text, not as a count. Someone who has just
    // made one explanation four characters too long should be able to read which rule, and
    // what to move, out of the failure alone.
    expect(over).toEqual([]);
  });

  it('states what the records say without hedging inside it', () => {
    // The wordings the split moved out. Each is a reason to doubt the finding, and a reason to
    // doubt belongs in `caveat`, where a reader opens it deliberately — not folded into the
    // sentence that reports what the documents contain.
    const hedges =
      /\b(may not|might be|worth checking|does not mean|before relying|before treating|before acting|open both|check (?:the|both|it|that|whether))\b/i;

    const hedged = findings
      .filter((finding) => hedges.test(finding.explanation))
      .map((finding) => ({ rule: ruleOf(finding), text: finding.explanation }));

    expect(hedged).toEqual([]);
  });
});

describe('rule copy — the caveat', () => {
  it('gives a caveat to every finding the engine graded as uncertain', () => {
    // `NEEDS_REVIEW` is the engine saying the comparison rests on something soft. A finding
    // that says so and then offers no account of what is soft about it is exactly the failure
    // this split was meant to end: a hedge with the hedging removed.
    const silent = findings
      .filter((finding) => finding.confidence === 'NEEDS_REVIEW' && finding.caveat.trim() === '')
      .map((finding) => ({ rule: ruleOf(finding), title: finding.title }));

    expect(silent).toEqual([]);
  });

  it('does not repeat the observation inside the caveat', () => {
    // The two render one above the other on the card, so an overlap reads as duplication —
    // which is the complaint the split was answering, reproduced in a new place. This is how
    // `provenance.ts` used to fail: it appended its warning to `explanation` while
    // `ProvisionalPrompt` stated the same warning underneath in its own words.
    //
    // Compared on the opening clause because that is the text a reader's eye lands on twice.
    const repeated = findings
      .filter((finding) => {
        if (!finding.caveat) return false;
        const opening = finding.explanation.split(/[.,—]/)[0]?.trim() ?? '';
        return opening.length > 24 && finding.caveat.includes(opening);
      })
      .map((finding) => ({ rule: ruleOf(finding), opening: finding.explanation.slice(0, 60) }));

    expect(repeated).toEqual([]);
  });

  it('holds the caveat to the same standard of claim as everything else', () => {
    // The caveat is the least-read text in a finding, which makes it the easiest place for an
    // overclaim to survive. §9 applies here exactly as it applies to the title.
    for (const finding of findings) {
      expect(finding.caveat, ruleOf(finding)).not.toMatch(
        /\b(proves|proven|confirms that|tamper[- ]proof|legally|guaranteed|certified)\b/i,
      );
    }
  });
});

describe('rule copy — the definitions themselves', () => {
  it('holds every rule title to a scannable length', () => {
    // A rule's `title` is a heading on the finding screen and a row label in the list of what
    // the engine checks. It is a name, not a sentence.
    const over = RULES.filter((rule) => rule.title.length > 60).map((rule) => ({
      id: rule.id,
      length: rule.title.length,
    }));

    expect(over).toEqual([]);
  });

  it('gives every rule a stated reason for existing', () => {
    // `description` and `rationale` are not user-facing copy in the sense the budget governs —
    // they are the rule's own account of itself, read on its detail screen and in an export,
    // where length is fine. Absence is not: a rule that cannot say why it fires is a rule a
    // reader has no grounds on which to reject it.
    const undocumented = RULES.filter(
      (rule) => rule.description.trim() === '' || rule.rationale.trim() === '',
    ).map((rule) => rule.id);

    expect(undocumented).toEqual([]);
  });
});

import { amountMismatchRule } from './definitions/amount-mismatch';
import { consistentAmountRule } from './definitions/consistent-amount';
import { corroboratedClaimRule } from './definitions/corroborated-claim';
import { corroboratedEventRule } from './definitions/corroborated-event';
import { duplicateEvidenceRule } from './definitions/duplicate-evidence';
import { eventDateConflictRule } from './definitions/event-date-conflict';
import { harassmentIndicatorRule } from './definitions/harassment-indicator';
import { impossibleSequenceRule } from './definitions/impossible-sequence';
import { missingEvidenceRule } from './definitions/missing-evidence';
import { orphanedEvidenceRule } from './definitions/orphaned-evidence';
import { paymentStatusConflictRule } from './definitions/payment-status-conflict';
import { relatedIdentifiersRule } from './definitions/related-identifiers';
import { responseOverdueRule } from './definitions/response-overdue';
import { statementDiscrepancyRule } from './definitions/statement-discrepancy';
import { timelineGapRule } from './definitions/timeline-gap';
import { unsupportedClaimRule } from './definitions/unsupported-claim';
import type { Rule } from './types';

/**
 * The rule registry.
 *
 * This array is the entire extension point of the analysis engine. Adding a rule means
 * writing one module that satisfies `Rule` and appending it here — the engine, the
 * persistence layer, the Analysis Center and the reasoning trace all pick it up with
 * no further change. That is the property the architecture is built to demonstrate.
 *
 * The rules fall into five kinds, and the spread is deliberate — a set that only ever
 * reported problems would be a fault finder, not an analysis tool:
 *
 *   - **Contradiction** — sources disagree, or describe an impossible order of events.
 *   - **Absence** — something expected is missing: evidence, a link, a period of time.
 *   - **Corroboration** — independent sources agree, which is a finding in its own right.
 *   - **Connection** — documents are about the same thing and the user may not know it.
 *   - **Elapsed time** — the case has gone quiet and a next step may have opened. Exactly
 *     one rule reasons this way, and it is the only one that reads `context.now`; see
 *     `./definitions/response-overdue` for the line it must not cross.
 */
export const RULES: readonly Rule[] = [
  paymentStatusConflictRule,
  statementDiscrepancyRule,
  harassmentIndicatorRule,
  eventDateConflictRule,
  impossibleSequenceRule,
  amountMismatchRule,
  missingEvidenceRule,
  unsupportedClaimRule,
  duplicateEvidenceRule,
  responseOverdueRule,
  orphanedEvidenceRule,
  timelineGapRule,
  relatedIdentifiersRule,
  corroboratedClaimRule,
  consistentAmountRule,
  corroboratedEventRule,
];

/** Highest priority first; ties broken by id so ordering is fully deterministic. */
export function orderedRules(rules: readonly Rule[] = RULES): Rule[] {
  return [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

export function enabledRules(rules: readonly Rule[] = RULES): Rule[] {
  return orderedRules(rules).filter((rule) => rule.enabled);
}

const RULE_INDEX: ReadonlyMap<string, Rule> = new Map(RULES.map((rule) => [rule.id, rule]));

/** Used by the reasoning trace to show a finding's rule alongside its rationale. */
export function ruleById(id: string): Rule | undefined {
  return RULE_INDEX.get(id) ?? RULES.find((r) => r.id === id || r.id.split('@')[0] === id);
}

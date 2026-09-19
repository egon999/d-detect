/**
 * Why the last AI enrichment run for a case ended, held for the life of the session.
 *
 * ## The silence this exists to break
 *
 * The four cross-document passes are enrichments: they run after the deterministic
 * assessment has already been written, they are fire-and-forget, and a failure is
 * deliberately not allowed to reject — the case is left exactly as the deterministic path
 * left it. That is the right instinct and it produced a specific wrong outcome. When a
 * connection failure or a refused key stopped the sequence, the run committed nothing,
 * published nothing, and the panel was left with no suggestions and no way to tell that
 * apart from a run that found nothing to say. The user saw *"Nothing here yet"* — a
 * sentence describing a successful, empty run — over a run that had just failed, with no
 * indication that their key or their connection was the reason.
 *
 * A run that stops early is therefore recorded here, and the panel reads it and says so.
 *
 * ## Why this is memory and not a stored record
 *
 * A failure is about an attempt, and the panel shows it beside the attempt's own button.
 * Persisting it would mean either a new stored field, a new job type, or a row in
 * `aiSuggestions` — each of them a schema change that outlives the fact it describes, and
 * the last of them would put a run's failure into the list a reviewer works through as if
 * it were a proposal to accept or dismiss. None of that buys anything the session does not
 * already have: a failure that survives a reload is a failure the user has already been
 * shown, and re-showing it beside a case they have since reopened would be reporting an
 * event from a run this screen never made.
 *
 * Only runs that *stop* are recorded. A reply that failed its schema on one pass leaves
 * the other three to run and normally produces something, so surfacing it would put a
 * warning above a working result; and `unavailable` is already handled at the other end,
 * where a user with no key at all gets the setup notice instead.
 */

import type { AIFailureReason } from './groq-client';

/**
 * Why a run stopped.
 *
 * Every transport reason, plus two of this module's own.
 *
 * `timed-out` exists because the transport has no way to say it. `CASE_AI_BUDGET_MS` reaches
 * a request as an aborted signal, and `groq-client` reports every aborted signal as
 * `network` carrying the message *"Cancelled."* — correct for its own question, and wrong
 * on this screen in two directions at once: a run that ran out of time would be reported
 * under a title about the connection, and a run the user abandoned by walking away would be
 * reported at all. The budget is told apart from an abandoned run by the caller, which is
 * the only place that knows which abort it asked for.
 *
 * `unexpected` covers a throw the pass did not classify. Kept separate from `network`
 * rather than folded into it because the two send the reader to different places — one to
 * their connection, the other to this build — and a module that reported its own bug as a
 * radio problem would have someone check a router over a defect that is ours.
 */
export type AiRunFailureReason = AIFailureReason | 'timed-out' | 'unexpected';

/** A run that stopped before it finished, and the sentence to put in front of a person. */
export interface AiRunFailure {
  readonly reason: AiRunFailureReason;
  /** A full sentence, from the transport's fixed vocabulary. Never a provider string. */
  readonly message: string;
  readonly at: number;
}

const failures = new Map<string, AiRunFailure>();
const listeners = new Set<(caseId: string) => void>();

function publish(caseId: string): void {
  for (const listener of listeners) listener(caseId);
}

/**
 * Records that a run for this case stopped, and tells anything watching.
 *
 * Replacing an earlier failure for the same case is the point rather than a side effect: a
 * second attempt that fails differently must not leave the first attempt's reason on
 * screen beside it.
 */
export function recordAiRunFailure(caseId: string, reason: AiRunFailureReason, message: string): void {
  failures.set(caseId, { reason, message, at: Date.now() });
  publish(caseId);
}

/**
 * Forgets the last failure for this case.
 *
 * Called when a run starts, not when one succeeds. A new attempt's outcome is not known
 * until it lands, and an old failure left standing over a run in flight is the same false
 * statement this module was written to remove — only pointing the other way.
 */
export function clearAiRunFailure(caseId: string): void {
  if (failures.delete(caseId)) publish(caseId);
}

/** The last failure for this case this session, or null when the last run did not stop. */
export function readAiRunFailure(caseId: string): AiRunFailure | null {
  return failures.get(caseId) ?? null;
}

/** Watches for a recorded or cleared failure. Returns the unsubscribe. */
export function subscribeToAiRunFailures(listener: (caseId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What stopped the run, as a title and the reason beneath it.
 *
 * The title names the cause; the transport's own sentence is the body, because it is the
 * only text here written with the provider's answer in hand — whether the key was refused,
 * the quota is spent, or the request never completed. Both come from this build and never
 * from a provider response, so neither can leak a URL, a key fragment or a raw payload.
 *
 * `unavailable` is deliberately vague where the transport is precise. One reason carries
 * two different messages — *"No Groq key is set up yet"* from a missing key and *"Groq did
 * not accept that key"* from a refused one — so a title that named either would be wrong
 * half the time it appeared. The message underneath says which, and it is the one sentence
 * here written with the answer in hand.
 *
 * `unexpected` has no reason of its own to give, so it says what is true of every
 * unclassified throw instead of guessing at one.
 */
export function describeAiRunFailure(failure: AiRunFailure): { title: string; message: string } {
  const titles: Record<AiRunFailureReason, string> = {
    unavailable: 'The model would not run',
    rate_limited: 'The model is rate limiting this key',
    network: 'The model could not be reached',
    invalid_response: 'The model replied in a form this build cannot read',
    'not-applicable': 'The model was asked for something it does not do',
    'timed-out': 'The reading ran out of time',
    unexpected: 'The model reading stopped unexpectedly',
  };

  return { title: titles[failure.reason], message: failure.message };
}

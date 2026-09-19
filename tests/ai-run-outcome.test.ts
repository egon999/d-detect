import { describe, expect, it, vi } from 'vitest';

// The module directly, not `@services`: that barrel re-exports the storage and credential
// modules, which reach `expo-modules-core` and cannot be loaded in a Node process. This
// module imports nothing but a type, so it is testable on its own — the same reason
// `case-ai-passes.test.ts` reaches its subject by path.
import {
  clearAiRunFailure,
  describeAiRunFailure,
  readAiRunFailure,
  recordAiRunFailure,
  subscribeToAiRunFailures,
  type AiRunFailureReason,
} from '../src/services/ai/run-outcome';

/**
 * The store that lets the panel tell a failed reading apart from an empty one.
 *
 * Every test uses its own case id. The module holds one map for the life of the process,
 * which is the whole point of it, and a suite that reused a key would be asserting on the
 * residue of the test above it.
 */

const CASE = 'case_outcome_a';
const OTHER = 'case_outcome_b';

describe('a run that has not stopped', () => {
  it('has no failure to report', () => {
    expect(readAiRunFailure('case_never_recorded')).toBeNull();
  });

  it('does not invent one after being cleared', () => {
    recordAiRunFailure(CASE, 'network', 'Could not reach Groq.');
    clearAiRunFailure(CASE);

    expect(readAiRunFailure(CASE)).toBeNull();
  });
});

describe('recording a stop', () => {
  it('keeps the reason and the sentence it was given', () => {
    recordAiRunFailure(CASE, 'rate_limited', 'Groq is rate limiting this key right now.');
    const failure = readAiRunFailure(CASE);

    expect(failure?.reason).toBe('rate_limited');
    expect(failure?.message).toBe('Groq is rate limiting this key right now.');
    expect(typeof failure?.at).toBe('number');
  });

  it('replaces an earlier ending for the same case rather than keeping both', () => {
    recordAiRunFailure(CASE, 'network', 'Could not reach Groq.');
    recordAiRunFailure(CASE, 'unavailable', 'Groq did not accept that key.');

    const failure = readAiRunFailure(CASE);
    expect(failure?.reason).toBe('unavailable');
    expect(failure?.message).toBe('Groq did not accept that key.');
  });

  it('leaves another case alone', () => {
    recordAiRunFailure(CASE, 'network', 'Could not reach Groq.');
    recordAiRunFailure(OTHER, 'unavailable', 'Groq did not accept that key.');

    expect(readAiRunFailure(CASE)?.reason).toBe('network');
    expect(readAiRunFailure(OTHER)?.reason).toBe('unavailable');

    clearAiRunFailure(OTHER);
    expect(readAiRunFailure(CASE)?.reason).toBe('network');
  });

  it('takes the outcome of the most recent write, so a later success is not shadowed', () => {
    recordAiRunFailure(CASE, 'timed-out', 'The reading had not finished.');
    clearAiRunFailure(CASE);

    expect(readAiRunFailure(CASE)).toBeNull();
  });
});

describe('subscribers', () => {
  it('hears about a recorded stop, and which case it was', () => {
    const heard = vi.fn();
    const stop = subscribeToAiRunFailures(heard);
    try {
      recordAiRunFailure(CASE, 'network', 'Could not reach Groq.');
      expect(heard).toHaveBeenCalledTimes(1);
      expect(heard).toHaveBeenCalledWith(CASE);
    } finally {
      stop();
    }
  });

  it('hears about a clear, because a run in flight is not a failed run', () => {
    recordAiRunFailure(CASE, 'network', 'Could not reach Groq.');
    const heard = vi.fn();
    const stop = subscribeToAiRunFailures(heard);
    try {
      clearAiRunFailure(CASE);
      expect(heard).toHaveBeenCalledTimes(1);
      expect(heard).toHaveBeenCalledWith(CASE);
    } finally {
      stop();
    }
  });

  it('says nothing when there was nothing to clear', () => {
    const heard = vi.fn();
    const stop = subscribeToAiRunFailures(heard);
    try {
      clearAiRunFailure('case_outcome_never_used');
      expect(heard).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('stops listening once unsubscribed', () => {
    const heard = vi.fn();
    subscribeToAiRunFailures(heard)();

    recordAiRunFailure(CASE, 'network', 'Could not reach Groq.');
    expect(heard).not.toHaveBeenCalled();
  });

  it('tells every listener, not only the newest', () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeToAiRunFailures(first);
    const stopSecond = subscribeToAiRunFailures(second);
    try {
      recordAiRunFailure(CASE, 'network', 'Could not reach Groq.');
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
    } finally {
      stopFirst();
      stopSecond();
    }
  });
});

describe('how a stop is described', () => {
  const REASONS: AiRunFailureReason[] = [
    'unavailable',
    'rate_limited',
    'network',
    'invalid_response',
    'not-applicable',
    'timed-out',
    'unexpected',
  ];

  it('gives every reason a title, and never shows the raw token', () => {
    for (const reason of REASONS) {
      const described = describeAiRunFailure({ reason, message: 'Something the transport said.', at: 0 });

      expect(described.title.length, reason).toBeGreaterThan(0);
      expect(described.title, reason).not.toMatch(/_/);
      expect(described.title, reason).not.toBe(reason);
    }
  });

  it('passes the transport sentence through unchanged', () => {
    const message = 'Groq did not accept that key. Check it in Settings.';
    expect(describeAiRunFailure({ reason: 'unavailable', message, at: 0 }).message).toBe(message);
  });

  it('does not describe a timeout as a connection problem', () => {
    const timedOut = describeAiRunFailure({ reason: 'timed-out', message: 'Cancelled.', at: 0 });
    const offline = describeAiRunFailure({ reason: 'network', message: 'Could not reach Groq.', at: 0 });

    expect(timedOut.title).not.toBe(offline.title);
  });

  it('does not describe this build failing as the reader\'s connection', () => {
    const ours = describeAiRunFailure({ reason: 'unexpected', message: 'Something failed.', at: 0 });
    const theirs = describeAiRunFailure({ reason: 'network', message: 'Could not reach Groq.', at: 0 });

    expect(ours.title).not.toBe(theirs.title);
  });
});

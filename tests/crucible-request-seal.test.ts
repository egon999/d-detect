/**
 * What `requestSeal` tells the user when the server does not produce a seal.
 *
 * The happy path is the least of it. A sealing request has many honest ways to come to
 * nothing — a device-only workspace, an unconfigured build, an offline phone, a case the
 * caller does not own, no deployed function at all — and each of them has to arrive at the
 * screen as the *specific* thing that happened. The failure this file was written for is the
 * one where they collapse: `not-found` from the Functions SDK, meaning nothing of that name
 * is deployed, used to be reported as `refused` with Firebase's raw status token, which told
 * the user their record had been read and declined. Nothing had read it. A product whose
 * entire claim is that it does not assert what it cannot establish cannot invent a refusal.
 *
 * ## The callable is now reached through a gate, and the gate is shut
 *
 * `FIREBASE_SEAL_CALLABLE_DEPLOYED` is `false` because the project is on the Spark plan, so
 * `requestSeal` answers a Firebase workspace from `sealAvailability` without a request leaving
 * the device. That makes the callable transport unreachable from `requestSeal` in this build,
 * which is why the status mapping below is exercised through `interpretCallableError`
 * directly: the mapping is what a deployer inherits, and shipping it untested until the day
 * someone flips the constant would put its first run in production.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIREBASE_SEAL_CALLABLE_DEPLOYED,
  interpretCallableError,
  requestSeal,
  sealAvailability,
} from '@services/crucible/request-seal';

/** What the transports do on the next call. Swapped per test. */
const behaviour: {
  api: unknown;
  apiThrows: unknown;
  apiCalls: Array<[string, RequestInit]>;
  /** Every payload the callable was handed. Empty is the assertion, not the setup. */
  callableCalls: unknown[];
  /** How many times the Firebase app was read, which is the first thing the callable path does. */
  firebaseReads: number;
} = {
  api: null,
  apiThrows: null,
  apiCalls: [],
  callableCalls: [],
  firebaseReads: 0,
};

// Hand-listed rather than spread from `importOriginal`, which is this repo's default and is
// not available here: all three originals pull a native module into a Node process —
// `@react-native-async-storage/async-storage` through `auth`, `expo-constants` through
// `config` — and importing them in order to spread them is the thing the mock exists to
// avoid. Kept as narrow as the code they stand in for, so the staleness that spreading
// prevents stays visible.
vi.mock('../src/data/firebase/auth', () => ({
  firebaseApp: () => {
    behaviour.firebaseReads += 1;
    return {};
  },
}));
vi.mock('../src/data/firebase/config', () => ({
  useFirebaseEmulator: () => false,
  firebaseEmulatorHost: () => '127.0.0.1',
}));
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  connectFunctionsEmulator: () => undefined,
  // Records the call and then refuses it. Nothing in this build reaches the callable, and a
  // stub that answered it cheerfully would let a regression that re-opens the gate go green
  // in whichever test happened to run it.
  httpsCallable: () => async (payload: unknown) => {
    behaviour.callableCalls.push(payload);
    throw new Error('The sealing callable was called, and no path in this build should reach it.');
  },
}));
vi.mock('../src/services/api-client', () => ({
  apiJson: async (path: string, options: RequestInit) => {
    behaviour.apiCalls.push([path, options]);
    if (behaviour.apiThrows) throw behaviour.apiThrows;
    return behaviour.api;
  },
}));

/** A `FunctionsError` as the SDK shapes it: a prefixed code and a message. */
const callableError = (code: string, message: string) => Object.assign(new Error(message), { code, message });

/** A `PlatformApiError` as `api-client` shapes it: the same codes without the prefix. */
const apiError = (code: string, message: string) => Object.assign(new Error(message), { code, message });

beforeEach(() => {
  behaviour.api = null;
  behaviour.apiThrows = null;
  behaviour.apiCalls = [];
  behaviour.callableCalls = [];
  behaviour.firebaseReads = 0;
});

/** Nothing left this device: no HTTP, no callable, not even a read of the Firebase app. */
const reachedNothing = () =>
  behaviour.apiCalls.length + behaviour.callableCalls.length + behaviour.firebaseReads;

describe('sealAvailability', () => {
  it('answers whether a signer can be reached, not where the case is stored', () => {
    // The distinction the ribbon was missing. `firebase` and `remote` are both "on a server";
    // only one of them has something in front of it that can sign.
    expect(sealAvailability('local')).toBe('device-only');
    expect(sealAvailability('remote')).toBe('available');
    expect(sealAvailability('firebase')).toBe('no-service');
  });

  it('defaults to no deployed callable, because there is none', () => {
    // Pinned as a value, not as a mood. The project is on the Spark plan, where Cloud
    // Functions cannot be deployed at all, and a build that ships `true` here puts an enabled
    // "Seal this record" button on every case that can do nothing but raise a toast.
    expect(FIREBASE_SEAL_CALLABLE_DEPLOYED).toBe(false);
  });
});

describe('requestSeal outcomes', () => {
  it('never reaches the network for a device-only workspace', async () => {
    const outcome = await requestSeal('case_x', { repositoryKind: 'local' });
    expect(outcome.kind).toBe('unavailable');
    expect((outcome as { reason: string }).reason).toMatch(/stored only on this device/);
    expect(reachedNothing()).toBe(0);
  });

  it('never reaches the network when it already knows no signer is deployed', async () => {
    // The round trip this replaces always ended here anyway: `functions/not-found`, a bare
    // `NOT_FOUND` from the SDK, and this same sentence as a warning toast. Spending a network
    // call to learn a fact compiled into the binary is latency for nothing.
    const outcome = await requestSeal('case_x', { repositoryKind: 'firebase' });
    expect(outcome.kind).toBe('unavailable');
    expect(reachedNothing()).toBe(0);
  });

  it('says what is known about a missing signer, and nothing else', async () => {
    const outcome = await requestSeal('case_x', { repositoryKind: 'firebase' });
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toMatch(/no sealing server to ask/);
    // The two things a reader on an integrity screen needs to know, and neither is a verdict.
    expect(reason).toMatch(/Nothing was read/);
    expect(reason).toMatch(/nothing in the case has changed/);
    // Firebase's internal token is not shown to anyone — and here there is not even one to
    // show, because no call was made.
    expect(reason).not.toMatch(/NOT_FOUND/);
  });

  it('keeps the two unreachable transports in separate words', async () => {
    const local = (await requestSeal('c', { repositoryKind: 'local' })) as { reason: string };
    const firebase = (await requestSeal('c', { repositoryKind: 'firebase' })) as { reason: string };
    expect(local.reason).not.toBe(firebase.reason);
    // Neither borrows the other's explanation: a Firebase case is not on this device only,
    // and signing in does not summon a deployment.
    expect(firebase.reason).not.toMatch(/stored only on this device/);
    expect(local.reason).not.toMatch(/no sealing server to ask/);
  });
});

/**
 * The callable's status mapping.
 *
 * Unreachable from `requestSeal` while the gate is shut, and still the code a Blaze
 * deployment would run on its first tap. Driven directly for exactly that reason.
 *
 * There is no test here for the "this build has no Firebase project configured" branch:
 * `requestSeal` is the only thing that reads `firebaseApp()`, and it cannot get that far. The
 * branch is kept because it is correct once the callable is deployed, not because anything
 * exercises it today.
 */
describe('interpretCallableError', () => {
  it('will not call a missing deployment a refusal', () => {
    // The bare status token the SDK raises when no `sealCase` exists. No sentence, because
    // no server wrote one.
    const outcome = interpretCallableError(callableError('functions/not-found', 'NOT_FOUND'));

    expect(outcome.kind).toBe('unavailable');
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toMatch(/no sealing server to ask/);
    expect(reason).toMatch(/Nothing was read/);
    expect(reason).toMatch(/nothing in the case has changed/);
    expect(reason).not.toMatch(/NOT_FOUND/);
  });

  it('passes a refusal through in the server own words', () => {
    // `functions/src/seal.js` raises `not-found` with prose when the case is not the
    // caller's. That is a real decision about a real record and belongs on the screen intact.
    expect(interpretCallableError(callableError('functions/not-found', 'This case is unavailable for your account.'))).toEqual({
      kind: 'refused',
      reason: 'This case is unavailable for your account.',
    });

    expect(
      interpretCallableError(
        callableError('functions/failed-precondition', 'There is nothing recorded in this case to seal yet.'),
      ),
    ).toEqual({
      kind: 'refused',
      reason: 'There is nothing recorded in this case to seal yet.',
    });
  });

  it('reports an unreachable server as unreachable, not as a decision', () => {
    for (const code of ['functions/internal', 'functions/unavailable', 'functions/deadline-exceeded']) {
      const outcome = interpretCallableError(callableError(code, 'internal'));
      expect(outcome.kind, code).toBe('unavailable');
      expect((outcome as { reason: string }).reason, code).toMatch(/Nothing in the case has changed/);
    }
  });

  it('asks for a sign-in rather than reporting a fault with the record', () => {
    expect(interpretCallableError(callableError('functions/unauthenticated', 'Sign in to seal a record.'))).toEqual({
      kind: 'unavailable',
      reason: 'Sign in again to seal this record.',
    });
  });
});

/**
 * The platform-API transport.
 *
 * The path that actually runs: the Firebase project is on the Spark plan, so the callable
 * above has nothing to call. These pin that a `remote` workspace reaches the same `sealCase`
 * through `POST /api/cases/{id}/seal` and arrives at the same four outcomes — and that the
 * asymmetry between the transports is handled rather than ignored. `api-client` only passes
 * the server's own sentence through on 400, 409 and 413; on a 404 it substitutes a generic
 * one, so a 404 must not be dressed up as a considered refusal.
 */
describe('requestSeal over the platform API', () => {
  const remote = (caseId = 'case_x') => requestSeal(caseId, { repositoryKind: 'remote' });
  const receipt = { sealId: 'seal_9', chainHead: 'c'.repeat(64), entryCount: 5, sealedAt: 1_757_000_000_000 };

  it('posts nothing but the case id, to the sealing route', async () => {
    behaviour.api = { ...receipt, created: true };
    expect(await remote('case_abc')).toEqual({ kind: 'sealed', receipt });

    expect(behaviour.apiCalls).toHaveLength(1);
    const [path, options] = behaviour.apiCalls[0]!;
    expect(path).toBe('/api/cases/case_abc/seal');
    expect(options.method).toBe('POST');
    // No body at all. A request carrying a chain head would make the server a signing
    // oracle: name a digest, receive an attestation for it.
    expect(options.body).toBeUndefined();
  });

  it('keeps an unchanged record distinct from a newly sealed one', async () => {
    behaviour.api = { ...receipt, created: false };
    expect(await remote()).toEqual({ kind: 'unchanged', receipt });
  });

  it('refuses to call a reply it cannot parse a success', async () => {
    // A server that answered without `created` may or may not have written a seal. Claiming
    // one is the unrecoverable mistake; being too cautious is fixed by reopening the case.
    for (const body of [{ ...receipt }, { ...receipt, created: 'yes' }, { ...receipt, created: 1 }]) {
      behaviour.api = body;
      const outcome = await remote();
      expect(outcome.kind, JSON.stringify(body)).toBe('unavailable');
      expect((outcome as { reason: string }).reason).toMatch(/cannot read/);
    }
  });

  it('passes a 409 through in the server own words', async () => {
    // `problem("failed-precondition", ...)` maps to HTTP 409, and 409 is one of the three
    // statuses whose body `api-client` trusts. This is how every considered refusal arrives.
    behaviour.apiThrows = apiError('failed-precondition', 'There is nothing recorded in this case to seal yet.');
    expect(await remote()).toEqual({
      kind: 'refused',
      reason: 'There is nothing recorded in this case to seal yet.',
    });

    behaviour.apiThrows = apiError(
      'failed-precondition',
      'The recorded history no longer matches an existing seal of this case, so it cannot be sealed again.',
    );
    expect((await remote()).kind).toBe('refused');
  });

  it('will not turn a 404 into a refusal, because it cannot tell which 404 it is', async () => {
    // Two unrelated causes share this status: a case that is not the caller's, and a server
    // with no sealing route deployed. `api-client` has already replaced the body with its own
    // generic sentence, so there is nothing left to tell them apart — and inventing a verdict
    // from an ambiguous status is exactly what this feature must not do.
    behaviour.apiThrows = apiError('not-found', 'This case, file, or service could not be found. Refresh and try again.');
    const outcome = await remote();
    expect(outcome.kind).toBe('unavailable');
    expect((outcome as { reason: string }).reason).toMatch(/no sealing server to ask/);
  });

  it('maps the remaining statuses without inventing a diagnosis', async () => {
    const cases: Array<[string, 'refused' | 'unavailable', RegExp]> = [
      ['unauthenticated', 'unavailable', /Sign in again/],
      ['permission-denied', 'refused', /not available to seal from this account/],
      ['resource-exhausted', 'refused', /too many records recently/],
      ['unavailable', 'unavailable', /Nothing in the case has changed/],
      ['invalid-response', 'unavailable', /Nothing in the case has changed/],
    ];
    for (const [code, kind, pattern] of cases) {
      behaviour.apiThrows = apiError(code, code);
      const outcome = await remote();
      expect(outcome.kind, code).toBe(kind);
      expect((outcome as { reason: string }).reason, code).toMatch(pattern);
    }
  });
});

/**
 * The §9 sweep again, over this module's strings.
 *
 * Failure text is where overclaiming creeps back in, because it is written in a hurry and
 * read once. `tests/crucible-seal-copy.test.ts` guards the ribbon's vocabulary; these are the
 * sentences that reach the same screen through a toast.
 */
describe('failure text vocabulary', () => {
  const FORBIDDEN = [/tamper[\s-]?proof/i, /immutab/i, /block[\s-]?chain/i, /\bcertif/i, /legally binding/i];

  it('makes no claim §9 forbids, in any outcome', async () => {
    const reasons: string[] = [];
    // The callable's sentences, reached directly: `requestSeal` cannot get to them while the
    // gate is shut, and they still have to be swept, because the day it opens is not the day
    // to discover what they say.
    for (const code of ['functions/not-found', 'functions/failed-precondition', 'functions/unauthenticated', 'functions/resource-exhausted', 'functions/internal']) {
      const outcome = interpretCallableError(
        callableError(code, code === 'functions/failed-precondition' ? 'Nothing to seal yet.' : 'NOT_FOUND'),
      );
      reasons.push((outcome as { reason?: string }).reason ?? '');
    }
    reasons.push(((await requestSeal('c', { repositoryKind: 'firebase' })) as { reason: string }).reason);
    reasons.push(((await requestSeal('c', { repositoryKind: 'local' })) as { reason: string }).reason);

    // The API transport's sentences reach the same toast and are swept with the rest.
    for (const code of ['not-found', 'failed-precondition', 'permission-denied', 'unauthenticated', 'unavailable']) {
      behaviour.apiThrows = apiError(code, code === 'failed-precondition' ? 'Nothing to seal yet.' : code);
      reasons.push(((await requestSeal('c', { repositoryKind: 'remote' })) as { reason?: string }).reason ?? '');
    }
    behaviour.apiThrows = null;
    behaviour.api = { sealId: 's', chainHead: 'a'.repeat(64), entryCount: 1, sealedAt: 1 };
    reasons.push(((await requestSeal('c', { repositoryKind: 'remote' })) as { reason: string }).reason);

    expect(reasons.filter((text) => text.trim().length === 0)).toEqual([]);
    for (const pattern of FORBIDDEN) {
      expect(reasons.filter((text) => pattern.test(text)), String(pattern)).toEqual([]);
    }
  });
});

/**
 * The first run: the boot sequence, where a cold start sends somebody, what a person is told
 * when signing in fails, what the form checks before it asks, who the app thinks they are, and
 * whether the introduction can come back a second time.
 *
 * ## Why these and nothing else
 *
 * This app has no component-render harness, so a screen cannot be mounted and read here. What
 * *can* be checked is everything the first-run code was rewritten to delegate to: the ordering
 * the boot deadlines depend on, the one redirect decision the launch gate makes, the sentence a
 * failure turns into, the rules the sign-in form applies to its own fields, the pure helpers
 * every surface uses to decide what to call somebody, and the one stored flag that decides
 * whether the introduction is shown. All of them were previously inline in a component or a
 * provider, where nothing verified them.
 *
 * The strongest tests in the file are the ones that walk a list rather than a recollection:
 * `every known code` walks `KNOWN_AUTH_ERROR_CODES`, and the device-session cases walk the exact
 * payloads earlier builds left in storage.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  KNOWN_AUTH_ERROR_CODES,
  asAuthError,
  readableAuthError,
} from '../src/services/auth/errors';
import {
  MIN_PASSWORD_LENGTH,
  joinWords,
  problemWithEmail,
  problemWithName,
  problemWithPassword,
  whySubmitBlocked,
} from '../src/services/auth/credentials';
import {
  accountInitials,
  accountLabel,
  deviceSessionUser,
  greetingName,
  hasPersonalName,
  personalEmail,
  personalName,
  providerLabel,
  sessionAccount,
  UNNAMED_LABEL,
  type AccountSource,
} from '../src/services/auth/account';
import {
  BOOT_DEADLINE_MS,
  SESSION_RESTORE_DEADLINE_MS,
  SPLASH_FAILSAFE_MS,
  SPLASH_OVERLAY_BACKSTOP_MS,
  SPLASH_OVERLAY_CEILING_MS,
  SPLASH_OVERLAY_EXIT_MS,
  SPLASH_OVERLAY_SETTLE_MS,
  STORAGE_DEADLINE_MS,
  STUCK_MS,
  deadlineOrderingProblems,
  launchDestination,
} from '../src/services/auth/launch';
import { isAccountFreeRoute, shouldLeaveForSignIn } from '../src/services/auth/route-guard';

const GENERIC = 'Something went wrong. Please try again.';
const NO_CONNECTION = 'Check your connection and try again.';

/**
 * Anything that would tell the reader they are holding a developer's tool.
 *
 * The slash is the important one: every code the auth library raises contains one, and a code
 * reaching the screen is the exact failure the mapping exists to prevent.
 */
const FORBIDDEN = [
  /\//, // auth/invalid-credential, and any other code
  /firebase|firestore|googleapis|grpc|xhr|axios/i,
  /\b(?:undefined|null|NaN|TypeError|Exception|stack|token|SDK)\b/i,
  /[{}[\]<>]|=>/,
];

/** Every sentence in the app has to clear this, whichever branch produced it. */
function expectReadableSentence(sentence: string) {
  expect(sentence.length).toBeGreaterThan(0);
  expect(sentence.length).toBeLessThanOrEqual(180);
  // A sentence, not a fragment: starts like one and finishes.
  expect(sentence[0]).toBe(sentence[0]?.toUpperCase());
  expect(sentence).toMatch(/[.?]$/);
  for (const pattern of FORBIDDEN) {
    expect(sentence).not.toMatch(pattern);
  }
}

describe('The cold start, and the order its deadlines fire in', () => {
  it('has an ordering with nothing wrong in it', () => {
    // `deadlineOrderingProblems()` names what a person would *see*, so an empty list is the
    // whole assertion — and a message in it is a description of the failure rather than an
    // arithmetic error, which is what makes a broken build self-explaining.
    expect(deadlineOrderingProblems()).toEqual([]);
  });

  it('leaves the app working when a font never loads', () => {
    // Past the font deadline the tree renders in the system font. This is the cheapest failure
    // in the sequence and the only one that is purely cosmetic.
    expect(BOOT_DEADLINE_MS).toBeLessThan(SPLASH_FAILSAFE_MS);
  });

  it('starts the overlay leaving before the native splash lifts', () => {
    // The other order reveals a seam: the splash goes and the overlay is still fully opaque
    // behind it, so the person sees one dark screen replace another.
    expect(SPLASH_OVERLAY_CEILING_MS).toBeLessThan(SPLASH_FAILSAFE_MS);
  });

  it('lets the overlay finish fading before it is cut away', () => {
    // The bug this guards: the backstop used to *be* the native splash failsafe, so on a launch
    // where the session resolved late the overlay was unmounted 40ms before its own fade
    // finished, and the hand-off read as a cut rather than a transition.
    const fadeEnds = SPLASH_OVERLAY_CEILING_MS + SPLASH_OVERLAY_EXIT_MS;
    expect(SPLASH_OVERLAY_BACKSTOP_MS).toBeGreaterThan(fadeEnds);
    expect(SPLASH_OVERLAY_BACKSTOP_MS - fadeEnds).toBeGreaterThanOrEqual(100);
  });

  it('never leaves the session giving up while the splash still covers the screen', () => {
    // A session that reports signed out behind a full-screen overlay is a redirect nobody can
    // see happening, into a screen they were not shown the reason for.
    expect(SESSION_RESTORE_DEADLINE_MS).toBeGreaterThan(SPLASH_OVERLAY_BACKSTOP_MS);
  });

  it('decides the introduction before the session gives up', () => {
    expect(STORAGE_DEADLINE_MS).toBeLessThan(SESSION_RESTORE_DEADLINE_MS);
  });

  it('offers the way out only once everything else has had its chance', () => {
    // The escape button appearing during a normal cold start is worse than it appearing late:
    // it tells a person something is wrong when nothing is.
    expect(STUCK_MS).toBeGreaterThan(SESSION_RESTORE_DEADLINE_MS);
    expect(STUCK_MS).toBeGreaterThan(SPLASH_OVERLAY_BACKSTOP_MS);
  });

  it('holds the overlay long enough that a fast session does not blink', () => {
    expect(SPLASH_OVERLAY_SETTLE_MS).toBeGreaterThan(0);
    expect(SPLASH_OVERLAY_SETTLE_MS + SPLASH_OVERLAY_EXIT_MS).toBeLessThanOrEqual(
      SPLASH_OVERLAY_CEILING_MS + SPLASH_OVERLAY_EXIT_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// Where a cold start sends somebody
// ---------------------------------------------------------------------------

describe('The launch gate', () => {
  const nothingKnown = {
    status: 'restoring' as const,
    hasUser: false,
    seenIntroduction: null,
    storageDeadlinePassed: false,
  };

  it('holds the launch screen while the session is still being restored', () => {
    expect(launchDestination(nothingKnown)).toBe('wait');
    // Even with the flag already answered, and even past the storage deadline: a restored
    // session outranks the introduction, so there is nothing to gain by moving early.
    expect(launchDestination({ ...nothingKnown, seenIntroduction: false })).toBe('wait');
    expect(launchDestination({ ...nothingKnown, storageDeadlinePassed: true })).toBe('wait');
  });

  it('goes into the app only when a status came with an identity', () => {
    expect(
      launchDestination({ ...nothingKnown, status: 'signedIn', hasUser: true }),
    ).toBe('app');

    // A status without an identity is not a session. Acting on it would put somebody in the
    // app with no owner id for any request they make.
    expect(
      launchDestination({ ...nothingKnown, status: 'signedIn', hasUser: false }),
    ).not.toBe('app');
  });

  it('does not make a returning account wait on the introduction flag', () => {
    // The flag is read for a signed-out person, but a session that restored has no use for it —
    // somebody with an account is never shown the introduction.
    expect(
      launchDestination({
        status: 'signedIn',
        hasUser: true,
        seenIntroduction: null,
        storageDeadlinePassed: false,
      }),
    ).toBe('app');
  });

  it('shows the introduction to someone who has never seen it', () => {
    expect(
      launchDestination({
        status: 'signedOut',
        hasUser: false,
        seenIntroduction: false,
        storageDeadlinePassed: false,
      }),
    ).toBe('introduction');
  });

  it('sends someone who has already seen it to sign in', () => {
    expect(
      launchDestination({
        status: 'signedOut',
        hasUser: false,
        seenIntroduction: true,
        storageDeadlinePassed: false,
      }),
    ).toBe('signIn');
  });

  it('waits for the flag rather than guessing, up to its deadline', () => {
    expect(
      launchDestination({
        status: 'signedOut',
        hasUser: false,
        seenIntroduction: null,
        storageDeadlinePassed: false,
      }),
    ).toBe('wait');
  });

  it('treats an unread flag as seen once storage has had its chance', () => {
    // The case a storage read that never resolves produces. Sending a returning person through
    // the introduction again is an annoyance; a device whose storage never answers is also a
    // device whose "seen" flag can never be written, so the other choice is an introduction on
    // every launch with no way out of it.
    expect(
      launchDestination({
        status: 'signedOut',
        hasUser: false,
        seenIntroduction: null,
        storageDeadlinePassed: true,
      }),
    ).toBe('signIn');
  });

  it('answers for the session timing out with nothing held', () => {
    // What `SESSION_RESTORE_DEADLINE_MS` produces when nothing ever reports in.
    expect(
      launchDestination({
        status: 'signedOut',
        hasUser: false,
        seenIntroduction: null,
        storageDeadlinePassed: false,
      }),
    ).toBe('wait');

    // ...and what it has become by the time the storage deadline lands too.
    expect(
      launchDestination({
        status: 'signedOut',
        hasUser: false,
        seenIntroduction: null,
        storageDeadlinePassed: true,
      }),
    ).toBe('signIn');
  });
});

// ---------------------------------------------------------------------------
// The one redirect a session ending is allowed to cause
// ---------------------------------------------------------------------------

describe('Being sent to sign in when a session ends', () => {
  it('does nothing at all while the answer is still unknown', () => {
    for (const status of ['restoring'] as const) {
      expect(shouldLeaveForSignIn({ status, heldSession: true, pathname: '/(tabs)' })).toBe(false);
    }
  });

  it('does nothing on a first launch, where no session was ever held', () => {
    // 'restoring' → 'signedOut' is what a brand-new install does. Redirecting here would cut
    // across the introduction and drop someone on the sign-in form having been told nothing.
    expect(
      shouldLeaveForSignIn({ status: 'signedOut', heldSession: false, pathname: '/(tabs)' }),
    ).toBe(false);
    expect(
      shouldLeaveForSignIn({ status: 'signedOut', heldSession: false, pathname: '/record/42' }),
    ).toBe(false);
  });

  it('sends someone out of a screen that needed the session', () => {
    for (const pathname of ['/(tabs)', '/(tabs)/cases', '/record/42', '/case/7', '/ask']) {
      expect(shouldLeaveForSignIn({ status: 'signedOut', heldSession: true, pathname })).toBe(true);
    }
  });

  it('leaves someone where they are on a screen that never needed one', () => {
    for (const pathname of ['/', '/sign-in', '/onboarding', '/legal']) {
      expect(isAccountFreeRoute(pathname)).toBe(true);
      expect(shouldLeaveForSignIn({ status: 'signedOut', heldSession: true, pathname })).toBe(false);
    }
  });

  it('does not mistake a route that merely starts the same way for one of them', () => {
    // A `startsWith` check would swallow all of these, and any one of them being reachable with
    // no session is somebody's own records on screen for whoever next picks up the phone.
    // `/legal-notice` and `/sign-in-help` are the two a prefix check gets wrong first; the rest
    // guard the same mistake in the other directions.
    for (const pathname of [
      '/legal-notice',
      '/sign-in-help',
      '/onboarding/2',
      '/legal/privacy',
      '/sign',
      '/Legal',
      '/legal ',
    ]) {
      expect(isAccountFreeRoute(pathname)).toBe(false);
    }
  });

  it('fires at most once across a token refresh that blinks', () => {
    // The sequence a cold radio produces: the listener reports a user, loses it, then gets it
    // back. The guard clears its own flag the moment it acts, so the second 'signedOut' finds
    // nothing held and stays quiet.
    let held = false;
    const act = (status: 'restoring' | 'signedOut' | 'signedIn', pathname: string): boolean => {
      if (status === 'signedIn') {
        held = true;
        return false;
      }
      if (status !== 'signedOut') return false;
      const leave = shouldLeaveForSignIn({ status, heldSession: held, pathname });
      if (held) held = false;
      return leave;
    };

    const decisions = [
      act('restoring', '/(tabs)'),
      act('signedIn', '/(tabs)'),
      act('signedOut', '/(tabs)'),
      act('signedIn', '/(tabs)'),
      act('signedOut', '/(tabs)'),
    ];

    expect(decisions).toEqual([false, false, true, false, true]);
    // Each of the two redirects is preceded by a fresh session being held, which is the point:
    // a refresh that recovers does not strand anybody, and a real second expiry is still acted
    // on rather than being swallowed by the first.
  });
});

// ---------------------------------------------------------------------------
// Who the app thinks the person is
// ---------------------------------------------------------------------------

/** A Firebase account as the provider sees one, with only the fields a case cares about. */
function firebaseAccount(overrides: Partial<AccountSource> = {}): AccountSource {
  return {
    uid: 'uid-123',
    email: 'neha@gmail.com',
    displayName: 'Neha Sharma',
    photoURL: null,
    emailVerified: true,
    metadata: { creationTime: '2026-01-01T00:00:00.000Z' },
    providerData: [{ providerId: 'password', displayName: null, photoURL: null }],
    ...overrides,
  };
}

describe('What the app calls somebody', () => {
  it('uses the name they gave', () => {
    expect(personalName('Neha Sharma')).toBe('Neha Sharma');
    expect(personalName('  Neha Sharma  ')).toBe('Neha Sharma');
    expect(accountLabel('Neha Sharma')).toBe('Neha Sharma');
    expect(greetingName('Neha Sharma')).toBe('Neha');
    expect(accountInitials('Neha Sharma')).toBe('NS');
  });

  it('drops every name an earlier build invented', () => {
    // `'Local user'` is the one that shipped, and it reached the home screen's greeting — which
    // splits on whitespace and takes the first word, so the app opened with "Good morning,
    // Local". The others were placeholder `displayName`s written by earlier code.
    for (const invented of ['Local user', 'local user', 'LOCAL USER', ' Local user ', 'Account', 'User', 'Local']) {
      expect(personalName(invented)).toBe('');
      expect(hasPersonalName(invented)).toBe(false);
      expect(accountInitials(invented)).toBe('');
      expect(greetingName(invented)).toBeNull();
      // A heading still has to render something, and it is the app's own word for the reader.
      expect(accountLabel(invented)).toBe(UNNAMED_LABEL);
    }
    expect(UNNAMED_LABEL).not.toMatch(/local|user|account/i);
  });

  it('treats a name that is only whitespace as no name at all', () => {
    for (const empty of ['', '   ', '\n', null, undefined]) {
      expect(personalName(empty)).toBe('');
      expect(hasPersonalName(empty)).toBe(false);
      expect(accountInitials(empty)).toBe('');
      expect(greetingName(empty)).toBeNull();
      expect(accountLabel(empty)).toBe(UNNAMED_LABEL);
    }
  });

  it('never turns a missing name into a question mark', () => {
    // The old fallback. A `'?'` in a circle is a developer's shrug; the avatar draws a person
    // glyph instead, which is why this returns empty rather than a stand-in.
    expect(accountInitials('')).toBe('');
    expect(accountInitials('   ')).toBe('');
  });

  it('greets without a name rather than greeting the reader', () => {
    // "Good morning" is a complete greeting. "Good morning, You" is the app talking to itself.
    expect(greetingName(undefined)).toBeNull();
    expect(greetingName('')).toBeNull();
  });

  it('takes at most two initials, from the first two words', () => {
    expect(accountInitials('neha')).toBe('N');
    expect(accountInitials('Neha Sharma')).toBe('NS');
    expect(accountInitials('Neha Sharma Rao')).toBe('NS');
    expect(accountInitials('  neha   sharma  ')).toBe('NS');
  });

  it('drops the address an earlier build invented', () => {
    // `local@device` is not an address anyone can be reached at, and the account screen printed
    // it under the person's name.
    expect(personalEmail('local@device')).toBe('');
    expect(personalEmail('LOCAL@DEVICE')).toBe('');
    for (const empty of ['', '   ', null, undefined]) expect(personalEmail(empty)).toBe('');
  });

  it('keeps a real address, and rejects anything that is not one', () => {
    expect(personalEmail('neha@gmail.com')).toBe('neha@gmail.com');
    expect(personalEmail('  neha@gmail.com  ')).toBe('neha@gmail.com');
    // No `@`, so it is not an address, whatever else it is.
    expect(personalEmail('neha.gmail.com')).toBe('');
    expect(personalEmail('Local user')).toBe('');
  });

  it('names the providers a person would recognise', () => {
    expect(providerLabel('google.com')).toBe('Google');
    expect(providerLabel('password')).toBe('Email and password');
    // An unrecognised provider must not put a scope name on screen.
    expect(providerLabel('saml.tenant-42')).toBe('Linked account');
  });
});

describe('An account from the cloud and an identity held by the phone', () => {
  it('reads a Firebase account without an import from anywhere', () => {
    const account = sessionAccount(firebaseAccount());
    expect(account.id).toBe('uid-123');
    expect(account.email).toBe('neha@gmail.com');
    expect(account.displayName).toBe('Neha Sharma');
    expect(account.providerIds).toEqual(['password']);
    expect(account.createdAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    // An unparseable creation time is dropped rather than becoming NaN on a screen.
    expect(
      sessionAccount(firebaseAccount({ metadata: { creationTime: 'not a date' } })).createdAt,
    ).toBeUndefined();
  });

  it('falls back through the Google profile and then the address itself', () => {
    const noName = firebaseAccount({
      displayName: null,
      providerData: [
        { providerId: 'google.com', displayName: 'Neha S', photoURL: 'https://x/p.png' },
      ],
    });
    expect(sessionAccount(noName).displayName).toBe('Neha S');
    expect(sessionAccount(noName).photoURL).toBe('https://x/p.png');

    // Nothing named it at all, so the local part of the address is the only thing left.
    const bare = firebaseAccount({ displayName: null, providerData: [] });
    expect(sessionAccount(bare).displayName).toBe('neha');
  });

  it('never invents a name for an account that has none to give', () => {
    const anonymous = firebaseAccount({
      email: null,
      displayName: null,
      providerData: [],
    });
    expect(sessionAccount(anonymous).displayName).toBe('');
    expect(sessionAccount(anonymous).email).toBe('');
  });

  it('keeps the device identity id and strips the words earlier builds wrote beside it', () => {
    // Exactly what earlier builds left in `detact:v1:identity`. The id owns every record this
    // device has saved, so it is passed through untouched — regenerating or renaming it would
    // orphan all of them — while the invented name and address are dropped on the way out.
    const stored = {
      id: 'user_7f3ka9zz2m4qq1xe',
      email: 'local@device',
      displayName: 'Local user',
      createdAt: 1_750_000_000_000,
    };
    const user = deviceSessionUser(stored);

    expect(user.id).toBe('user_7f3ka9zz2m4qq1xe');
    expect(user.displayName).toBe('');
    expect(user.email).toBe('');
    expect(user.providerIds).toEqual([]);
    expect(user.createdAt).toBe(1_750_000_000_000);

    // Which is what every surface downstream then does with it.
    expect(greetingName(user.displayName)).toBeNull();
    expect(accountInitials(user.displayName)).toBe('');
    expect(accountLabel(user.displayName)).toBe(UNNAMED_LABEL);
  });

  it('omits the optional fields a device identity never had', () => {
    const bare = deviceSessionUser({ id: 'user_abcdefgh12345678' });
    expect(bare).toEqual({
      id: 'user_abcdefgh12345678',
      email: '',
      displayName: '',
      providerIds: [],
    });
    // Absent, not `undefined`-valued keys: those print as the string "undefined" through the
    // paths that stringify a profile.
    expect('photoURL' in bare).toBe(false);
    expect('phone' in bare).toBe(false);
    expect('address' in bare).toBe(false);
    expect('createdAt' in bare).toBe(false);
  });

  it('keeps what the person genuinely gave a device identity', () => {
    const user = deviceSessionUser({
      id: 'user_abcdefgh12345678',
      displayName: 'Neha',
      email: 'neha@gmail.com',
      photoURL: 'https://x/p.png',
      phone: '+91 90000 00000',
      address: 'Pune',
      createdAt: 1,
    });
    expect(user.displayName).toBe('Neha');
    expect(user.email).toBe('neha@gmail.com');
    expect(user.photoURL).toBe('https://x/p.png');
    expect(user.phone).toBe('+91 90000 00000');
    expect(user.address).toBe('Pune');
  });

  it('adds a name to a stored identity without changing who it belongs to', () => {
    // What `loadOrCreateLocalIdentity(displayName)` does when somebody supplies a name later.
    const before = deviceSessionUser({ id: 'user_abcdefgh12345678', displayName: 'Local user' });
    const after = deviceSessionUser({ id: 'user_abcdefgh12345678', displayName: 'Neha' });
    expect(after.id).toBe(before.id);
    expect(before.displayName).toBe('');
    expect(after.displayName).toBe('Neha');
  });
});

describe('Account failures, in words', () => {
  it('has a readable sentence for every code it claims to know', () => {
    expect(KNOWN_AUTH_ERROR_CODES.length).toBeGreaterThan(20);

    for (const code of KNOWN_AUTH_ERROR_CODES) {
      // Both shapes the library produces: the code as a property, and the code buried in a
      // message by something that caught and re-threw it.
      const fromProperty = readableAuthError({ code, message: `Firebase: Error (${code}).` });
      const fromMessage = readableAuthError(new Error(`Firebase: Error (${code}).`));

      expectReadableSentence(fromProperty);
      expect(fromMessage).toBe(fromProperty);
    }
  });

  it('says what to do about the failures a person can actually fix', () => {
    expect(readableAuthError({ code: 'auth/invalid-credential' })).toMatch(/don’t match/);
    expect(readableAuthError({ code: 'auth/user-not-found' })).toMatch(/create one/);
    expect(readableAuthError({ code: 'auth/weak-password' })).toMatch(/longer/);
    expect(readableAuthError({ code: 'auth/email-already-in-use' })).toMatch(/Sign in instead/);
    expect(readableAuthError({ code: 'auth/too-many-requests' })).toMatch(/Wait a minute/);
  });

  it('sends the person to email and password when the build cannot do Google', () => {
    // The failure a release build signed with an unregistered certificate actually hits.
    // Nothing in the app can fix it, so the sentence must not ask them to try again.
    for (const code of [
      'auth/app-not-authorized',
      'auth/operation-not-allowed',
      'auth/unauthorized-domain',
    ]) {
      const sentence = readableAuthError({ code });
      expect(sentence).toMatch(/email and password/);
      expectReadableSentence(sentence);
    }
  });

  it('treats an unmapped code as unknown rather than printing it', () => {
    expect(readableAuthError({ code: 'auth/some-code-nobody-mapped' })).toBe(GENERIC);
    expect(readableAuthError(new Error('Firebase: Error (auth/not-a-real-code).'))).toBe(GENERIC);
  });

  it('recognises a request that never reached anything', () => {
    // How `src/api/client.ts` spells "could not connect": status 0.
    expect(readableAuthError({ status: 0, message: 'Cannot reach the server.' })).toBe(
      NO_CONNECTION,
    );
    expect(readableAuthError({ code: 'auth/network-request-failed' })).toBe(NO_CONNECTION);
  });

  it('passes through a sentence written for a person, and replaces one that was not', () => {
    // Written by `src/services/auth/google.ts` and `session-provider.tsx`. These carry no code,
    // and they must survive — which is also what makes the mapping safe to apply twice.
    const ours = [
      'Signing in with Google isn’t available here. Use your email and password instead.',
      'Google sign-in couldn’t be completed. Use your email and password instead.',
      'Enter the email address for your account first.',
    ];
    for (const sentence of ours) {
      expect(readableAuthError(sentence)).toBe(sentence);
      expect(readableAuthError(new Error(sentence))).toBe(sentence);
      // Idempotent: mapping an already-mapped failure changes nothing.
      expect(readableAuthError(readableAuthError(sentence))).toBe(sentence);
    }

    // And the things that are not sentences.
    expect(readableAuthError(new TypeError('undefined is not an object'))).toBe(GENERIC);
    expect(readableAuthError(new Error('at signInWithCredential (index.js:1)'))).toBe(GENERIC);
    expect(readableAuthError(new Error('NetworkError: request failed'))).toBe(GENERIC);
    expect(readableAuthError(new Error(`a sentence that goes on ${'and on '.repeat(40)}`))).toBe(
      GENERIC,
    );
  });

  it('answers for anything at all, not only errors', () => {
    for (const nonsense of [null, undefined, 0, 42, '', '   ', [], {}, true]) {
      expect(readableAuthError(nonsense)).toBe(GENERIC);
    }
  });

  it('wraps the same sentence in an Error for the paths that throw', () => {
    const thrown = asAuthError({ code: 'auth/wrong-password' });
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe(readableAuthError({ code: 'auth/wrong-password' }));
    // Re-mapping what the session provider threw is a no-op, which is what lets the sign-in
    // screen route everything through one call without knowing where it came from.
    expect(readableAuthError(thrown)).toBe(thrown.message);
  });
});

describe('What the sign-in form checks itself', () => {
  it('asks for an email before judging it', () => {
    expect(problemWithEmail('')).toMatch(/Enter the email/);
    expect(problemWithEmail('   ')).toMatch(/Enter the email/);
  });

  it('turns away only what cannot be an address', () => {
    for (const bad of ['neha', 'neha@', '@gmail.com', 'neha@gmail', 'neha @gmail.com']) {
      expect(problemWithEmail(bad)).toMatch(/doesn’t look like an email/);
    }
    // Real addresses, including the shapes a stricter pattern would wrongly reject.
    for (const good of [
      'neha@gmail.com',
      'neha.sharma+bills@gmail.co.in',
      'n@a.io',
      "o'brien@example.com",
      '  spaced@example.com  ',
    ]) {
      expect(problemWithEmail(good)).toBeNull();
    }
  });

  it('applies the length rule to a new password only', () => {
    expect(problemWithPassword('', 'signIn')).toMatch(/Enter your password/);
    expect(problemWithPassword('', 'signUp')).toMatch(/Enter your password/);

    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
    expect(problemWithPassword(short, 'signUp')).toMatch(
      new RegExp(`${MIN_PASSWORD_LENGTH} characters`),
    );
    // An account made when the minimum was lower must still be able to sign in.
    expect(problemWithPassword(short, 'signIn')).toBeNull();
    expect(problemWithPassword('a'.repeat(MIN_PASSWORD_LENGTH), 'signUp')).toBeNull();
    // A space is a character, not whitespace to trim away.
    expect(problemWithPassword('   ', 'signIn')).toBeNull();
  });

  it('asks for a name only when an account is being created', () => {
    expect(problemWithName('', 'signIn')).toBeNull();
    expect(problemWithName('', 'signUp')).toMatch(/Enter the name/);
    expect(problemWithName('   ', 'signUp')).toMatch(/Enter the name/);
    expect(problemWithName('Neha', 'signUp')).toBeNull();
  });

  it('prompts for what is missing rather than listing errors nobody has made', () => {
    expect(whySubmitBlocked({ mode: 'signIn', name: '', email: '', password: '' })).toBe(
      'Add your email and your password to continue.',
    );
    expect(whySubmitBlocked({ mode: 'signUp', name: '', email: '', password: '' })).toBe(
      'Add your name, your email and a password to continue.',
    );
    expect(
      whySubmitBlocked({ mode: 'signIn', name: '', email: 'neha@gmail.com', password: '' }),
    ).toBe('Add your password to continue.');
  });

  it('names what is wrong once every field has something in it', () => {
    expect(whySubmitBlocked({ mode: 'signIn', name: '', email: 'neha', password: 'secret' })).toMatch(
      /doesn’t look like an email/,
    );
    expect(
      whySubmitBlocked({ mode: 'signUp', name: 'Neha', email: 'neha@gmail.com', password: 'abc' }),
    ).toMatch(new RegExp(`${MIN_PASSWORD_LENGTH} characters`));
  });

  it('lets the button through when there is nothing left to say', () => {
    expect(
      whySubmitBlocked({ mode: 'signIn', name: '', email: 'neha@gmail.com', password: 'secret' }),
    ).toBeNull();
    expect(
      whySubmitBlocked({
        mode: 'signUp',
        name: 'Neha',
        email: 'neha@gmail.com',
        password: 'secret',
      }),
    ).toBeNull();
  });

  it('writes a list the way a sentence reads', () => {
    expect(joinWords([])).toBe('');
    expect(joinWords(['your email'])).toBe('your email');
    expect(joinWords(['your email', 'your password'])).toBe('your email and your password');
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('says the same thing as the server about the same problem', () => {
    // A rule the form catches and a rule the server catches must not be worded differently,
    // or correcting one produces a second, unfamiliar sentence.
    expect(problemWithEmail('')).toBe(readableAuthError({ code: 'auth/missing-email' }));
    expect(problemWithPassword('', 'signIn')).toBe(
      readableAuthError({ code: 'auth/missing-password' }),
    );
  });
});

// ---------------------------------------------------------------------------
// The introduction, and the one flag that decides whether it comes back
// ---------------------------------------------------------------------------

/**
 * A stand-in for device storage, with its failures under the test's control.
 *
 * Hoisted so `vi.mock` below — which runs before the imports — can close over it. The whole
 * module is replaced rather than partially mocked: the real one loads a native module that does
 * not exist under Node, so there is no original to spread in.
 */
const storage = vi.hoisted(() => ({
  value: null as string | null,
  readFails: false,
  writeFails: false,
  removeFails: false,
  reads: [] as string[],
  writes: [] as Array<[string, string]>,
  removed: [] as string[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string): Promise<string | null> => {
      storage.reads.push(key);
      if (storage.readFails) throw new Error('storage unavailable');
      return storage.value;
    },
    setItem: async (key: string, value: string): Promise<void> => {
      storage.writes.push([key, value]);
      if (storage.writeFails) throw new Error('no space left on device');
    },
    removeItem: async (key: string): Promise<void> => {
      teardown.steps.push('storage');
      storage.removed.push(key);
      if (storage.removeFails) throw new Error('storage unavailable');
    },
  },
}));

/**
 * What signing out touched, and which of its steps were made to fail.
 *
 * Separate from `storage` because the teardown's four steps live in four different modules, and
 * the only thing worth asserting about them is the order they ran in and that none of them could
 * stop the others.
 */
const teardown = vi.hoisted(() => ({
  steps: [] as string[],
  cacheFails: false,
  googleFails: false,
  firebaseFails: false,
}));

/*
 * The modules `runSignOutTeardown` reaches are replaced outright rather than spread from an
 * original, because none of them has an original that loads here: `@data/firebase/config` pulls
 * in `expo-constants`, whose native side does not exist under Node, and `./auth/google` pulls in
 * the Google native module. A partial mock is the right default — a hand-listed factory goes
 * stale the moment production code adds an import — but it is not available for these four.
 */
vi.mock('@api', () => ({
  clearApiCache: () => {
    teardown.steps.push('cache');
    if (teardown.cacheFails) throw new Error('unreachable');
  },
}));

vi.mock('../src/services/auth/google', () => ({
  signOutOfGoogle: async () => {
    teardown.steps.push('google');
    if (teardown.googleFails) throw new Error('play services not available');
  },
}));

vi.mock('@data/firebase/config', () => ({ isFirebaseConfigured: () => true }));
vi.mock('@data/firebase/auth', () => ({ firebaseAuth: async () => ({ currentUser: null }) }));
vi.mock('firebase/auth', () => ({
  signOut: async () => {
    teardown.steps.push('firebase');
    if (teardown.firebaseFails) throw new Error('network request failed');
  },
}));

/**
 * The preferences module with its in-memory state wiped.
 *
 * `markOnboardingSeen` remembers the answer for the lifetime of the module, which is the point
 * of it — so each case has to start from a module that has not been told anything yet, the way
 * a cold start does.
 */
async function freshPreferences() {
  vi.resetModules();
  return import('../src/services/preferences');
}

describe('Whether the introduction comes back', () => {
  beforeEach(() => {
    storage.value = null;
    storage.readFails = false;
    storage.writeFails = false;
    storage.reads = [];
    storage.writes = [];
  });

  it('shows it to someone who has never seen it', async () => {
    const { hasSeenOnboarding } = await freshPreferences();
    await expect(hasSeenOnboarding()).resolves.toBe(false);
  });

  it('does not show it again on the next launch', async () => {
    const first = await freshPreferences();
    await first.markOnboardingSeen();
    await expect(first.hasSeenOnboarding()).resolves.toBe(true);

    // The next cold start reads what was written, with none of the memory from this one.
    expect(storage.writes).toEqual([['detact:v1:onboarding-seen', 'true']]);
    storage.value = 'true';
    const next = await freshPreferences();
    await expect(next.hasSeenOnboarding()).resolves.toBe(true);
  });

  it('still sticks for this run when the write fails', async () => {
    storage.writeFails = true;
    const { hasSeenOnboarding, markOnboardingSeen } = await freshPreferences();

    // Must not reject: it is called on the way out of a screen that is already navigating.
    await expect(markOnboardingSeen()).resolves.toBeUndefined();
    // And the answer has to have changed anyway, or skipping would not stick.
    await expect(hasSeenOnboarding()).resolves.toBe(true);
  });

  it('answers immediately once it has been marked, without reading storage again', async () => {
    const { hasSeenOnboarding, markOnboardingSeen } = await freshPreferences();
    void markOnboardingSeen();

    // Fired without awaiting, which is how the introduction screen calls it on its way out.
    // The answer has to be true already, before the write has had a chance to land.
    await expect(hasSeenOnboarding()).resolves.toBe(true);
    expect(storage.reads).toEqual([]);
  });

  it('errs towards not showing it when storage cannot be read', async () => {
    storage.readFails = true;
    const { hasSeenOnboarding } = await freshPreferences();

    // The less bad of the two mistakes: a device whose storage cannot be read is also a device
    // whose "seen" flag cannot be written, so answering false would show the introduction on
    // every single launch with no way out of it.
    await expect(hasSeenOnboarding()).resolves.toBe(true);
  });

  it('treats anything other than the written value as not seen', async () => {
    for (const stored of ['false', '', 'TRUE', '1']) {
      storage.value = stored;
      const { hasSeenOnboarding } = await freshPreferences();
      await expect(hasSeenOnboarding()).resolves.toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Signing out, which is the one thing that must not be a no-op
// ---------------------------------------------------------------------------

/** The teardown with every module's state wiped, the way a cold process starts. */
async function freshTeardown() {
  vi.resetModules();
  const mod = await import('../src/services/session-provider');
  return mod.runSignOutTeardown;
}

describe('What signing out forgets', () => {
  beforeEach(() => {
    storage.value = null;
    storage.readFails = false;
    storage.writeFails = false;
    storage.removeFails = false;
    storage.reads = [];
    storage.writes = [];
    storage.removed = [];
    teardown.steps = [];
    teardown.cacheFails = false;
    teardown.googleFails = false;
    teardown.firebaseFails = false;
  });

  it('forgets the previous account before anything that can block', async () => {
    const runSignOutTeardown = await freshTeardown();
    await runSignOutTeardown(true);

    // Order is the assertion. The remembered reads go first because they are the only step whose
    // failure leaves another person's records readable, and the only one nothing outside the app
    // can delay — two people sharing a handset is the ordinary case for these users.
    expect(teardown.steps).toEqual(['cache', 'google', 'storage', 'firebase']);
  });

  it('clears the Google account selection, not just the session', async () => {
    const runSignOutTeardown = await freshTeardown();
    await runSignOutTeardown(true);

    // Signing out of the account alone leaves Google's chooser pre-answered, so the next
    // "Continue with Google" signs the same person straight back in without asking.
    expect(teardown.steps.indexOf('google')).toBeLessThan(teardown.steps.indexOf('firebase'));
  });

  it('keeps the identity that owns the records already saved', async () => {
    const runSignOutTeardown = await freshTeardown();
    await runSignOutTeardown(true);

    // Only the "this phone was the owner" flag is dropped. Deleting the identity itself would
    // strand every record saved under it, with no way to get back to them.
    expect(storage.removed).toEqual(['detact:v1:offline-active']);
    expect(storage.removed).not.toContain('detact:v1:identity');
  });

  it('skips the account call in a build that has no account project', async () => {
    const runSignOutTeardown = await freshTeardown();
    await runSignOutTeardown(false);

    expect(teardown.steps).toEqual(['cache', 'google', 'storage']);
  });

  it('never rejects, however many of its steps fail', async () => {
    // The defect this is here for: the teardown used to be a straight line of awaits, so one
    // failing step rejected out of `signOut()` and skipped the lines that clear the session. The
    // person was left holding a session they had explicitly ended — name still in the header,
    // the launch gate still sending them into the app.
    teardown.cacheFails = true;
    teardown.googleFails = true;
    teardown.firebaseFails = true;
    storage.removeFails = true;

    const runSignOutTeardown = await freshTeardown();
    await expect(runSignOutTeardown(true)).resolves.toBeUndefined();

    // And every later step still ran, rather than being skipped by the first failure.
    expect(teardown.steps).toEqual(['cache', 'google', 'storage', 'firebase']);
  });

  it('still forgets the rest when the one unblockable step is the one that fails', async () => {
    teardown.cacheFails = true;
    const runSignOutTeardown = await freshTeardown();
    await expect(runSignOutTeardown(true)).resolves.toBeUndefined();

    expect(teardown.steps).toEqual(['cache', 'google', 'storage', 'firebase']);
    expect(storage.removed).toEqual(['detact:v1:offline-active']);
  });

  it('runs to the end when the network is gone', async () => {
    // Airplane mode: the Google call and the account call both fail, and signing out still has
    // to mean signed out. Nothing here waits on the server agreeing.
    teardown.googleFails = true;
    teardown.firebaseFails = true;

    const runSignOutTeardown = await freshTeardown();
    await expect(runSignOutTeardown(true)).resolves.toBeUndefined();
    expect(storage.removed).toEqual(['detact:v1:offline-active']);
  });
});

/**
 * The toast queue's contract, executed.
 *
 * `Toast.tsx` makes three promises that are easy to state and easy to break: two rapid calls
 * queue rather than stack, the same message twice is one toast, and a message stays up for
 * as long as it takes to read. The first two are the reason the primitive exists at all —
 * a toast host that lets two cards overlap is worse than the `<Notice>` block it replaced,
 * because at least the block was legible.
 *
 * Only the pure half is exercised here. The animated half needs a renderer and a native
 * driver, neither of which this suite has (`vitest.config.mts` runs a plain Node
 * environment), so the queue is deliberately built as data that can be reasoned about
 * without one. That split is the testability argument for the shape of the module.
 *
 * ## The three mocks
 *
 * All three stand in for native leaves that this file's subject never reaches, and all three
 * are here because of what `Toast.tsx` imports rather than what it does.
 *
 * `react-native-safe-area-context` and `@expo/vector-icons` both ship source the test
 * runner's parser rejects outright — they are transpiled by Metro in the app and by nothing
 * here. The toast reads insets to position itself and derives `IconName` from the icon
 * font's glyph map; neither survives into the queue, and `IconName` is erased entirely
 * before any of this runs.
 *
 * `expo-linear-gradient` arrives via `Motion.tsx`, which `Toast.tsx` imports for
 * `useReducedMotion` and which also exports `Shimmer`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({ default: () => null }));
vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));

import {
  TOAST_DURATION,
  TOAST_ICON,
  activeToast,
  createToast,
  dropToast,
  enqueueToast,
  findToastDuplicate,
  toastDuration,
  type ToastEntry,
  type ToastOptions,
} from '@ui/primitives/Toast';

/** A toast with resolved defaults, at the placement the provider would have supplied. */
const toast = (message: string, id = message, options: Partial<ToastOptions> = {}): ToastEntry =>
  createToast({ message, ...options }, id, 'top');

describe('toast duration', () => {
  it('gives a longer message longer on screen', () => {
    const short = toastDuration('Saved');
    const long = toastDuration(
      'Your statement is saved, and the two documents you attached are being read now.',
    );
    expect(long).toBeGreaterThan(short);
  });

  it('never drops below the floor, however short the message', () => {
    expect(toastDuration('')).toBe(TOAST_DURATION.min);
    expect(toastDuration('Ok')).toBe(TOAST_DURATION.min);
  });

  it('never exceeds the ceiling, however long the message', () => {
    expect(toastDuration('word '.repeat(200))).toBe(TOAST_DURATION.max);
  });

  it('counts the title toward the reading time', () => {
    const withTitle = toastDuration('A message of some length to clear the floor', 'Not saved');
    const without = toastDuration('A message of some length to clear the floor');
    expect(withTitle).toBeGreaterThan(without);
  });
});

describe('toast defaults', () => {
  it('defaults to neutral rather than ok, which would claim success unasked', () => {
    expect(toast('Something happened').tone).toBe('neutral');
  });

  it('takes the glyph from the tone when none is given', () => {
    expect(toast('Saved', 'a', { tone: 'ok' }).icon).toBe(TOAST_ICON.ok);
    expect(toast('Not saved', 'b', { tone: 'danger' }).icon).toBe(TOAST_ICON.danger);
  });

  it('lets an explicit icon win over the tone default', () => {
    expect(toast('Saved', 'a', { tone: 'ok', icon: 'content-save-outline' }).icon).toBe(
      'content-save-outline',
    );
  });

  it('keeps a zero duration, which means the toast waits to be dismissed', () => {
    // Guards `options.duration ?? …`: with `||` a sticky toast would silently become a
    // timed one, and a message that was meant to persist would disappear.
    expect(toast('Working', 'a', { duration: 0 }).duration).toBe(0);
  });

  it('falls back to the provider placement, and lets one toast override it', () => {
    expect(createToast({ message: 'Saved' }, 'a', 'bottom').placement).toBe('bottom');
    expect(createToast({ message: 'Saved', placement: 'top' }, 'a', 'bottom').placement).toBe('top');
  });
});

describe('the queue', () => {
  it('shows one toast at a time — a second call waits rather than overlapping', () => {
    let queue = enqueueToast([], toast('First'));
    queue = enqueueToast(queue, toast('Second'));

    expect(queue).toHaveLength(2);
    expect(activeToast(queue)?.message).toBe('First');
  });

  it('is first-in-first-out: dismissing the visible one promotes the next', () => {
    const first = toast('First');
    const queue = enqueueToast(enqueueToast([], first), toast('Second'));

    const after = dropToast(queue, first.id);
    expect(activeToast(after)?.message).toBe('Second');
  });

  it('has no active toast when empty', () => {
    expect(activeToast([])).toBeNull();
    expect(activeToast(dropToast(enqueueToast([], toast('Only')), 'Only'))).toBeNull();
  });

  it('drops a waiting toast without disturbing the visible one', () => {
    const queue = enqueueToast(enqueueToast([], toast('First')), toast('Second'));

    const after = dropToast(queue, 'Second');
    expect(after.map((entry) => entry.message)).toEqual(['First']);
  });

  it('ignores a dismissal for an id that is not queued', () => {
    const queue = enqueueToast([], toast('First'));
    expect(dropToast(queue, 'nope')).toHaveLength(1);
  });
});

describe('duplicate folding', () => {
  it('finds the same message already queued, so a double-tap shows one toast', () => {
    const queue = enqueueToast([], toast('Your statement is saved'));
    const duplicate = findToastDuplicate(queue, { message: 'Your statement is saved' });

    expect(duplicate?.id).toBe('Your statement is saved');
  });

  it('matches against waiting toasts as well as the visible one', () => {
    const queue = enqueueToast(enqueueToast([], toast('First')), toast('Second'));
    expect(findToastDuplicate(queue, { message: 'Second' })?.id).toBe('Second');
  });

  it('treats a different tone as a different message', () => {
    // The words can be identical while the meaning is not — "Not saved" as a warning and as
    // a failure are two different things to tell someone, and folding them would drop one.
    const queue = enqueueToast([], toast('Not saved', 'a', { tone: 'warn' }));
    expect(findToastDuplicate(queue, { message: 'Not saved', tone: 'danger' })).toBeNull();
  });

  it('treats a different title as a different message', () => {
    const queue = enqueueToast([], toast('Try again', 'a', { title: 'Not saved' }));
    expect(findToastDuplicate(queue, { message: 'Try again' })).toBeNull();
  });

  it('matches a defaulted tone against an unspecified one', () => {
    // `show({ message })` and `show({ message, tone: 'neutral' })` are the same call, and a
    // comparison against the raw options rather than the resolved entry would miss it.
    const queue = enqueueToast([], toast('Saved'));
    expect(findToastDuplicate(queue, { message: 'Saved', tone: 'neutral' })?.id).toBe('Saved');
  });

  it('finds nothing in an empty queue', () => {
    expect(findToastDuplicate([], { message: 'Saved' })).toBeNull();
  });
});

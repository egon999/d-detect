/**
 * The voice-memo recorder's pure helpers, tested.
 *
 * These three functions are the user-visible half of a recording: the clock that runs
 * while it is taken, the name it is filed under, and the type it is declared with. They
 * live apart from `media-recorder.tsx` precisely so a plain Node process can check them,
 * because a mistake in any of them - a clock that runs ahead of the file, a memo named
 * in the wrong timezone, a `.3gp` renamed to `.m4a` - is silent on the device and only
 * surfaces later, when a statement cannot be found or cannot be transcribed.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEMO_EXTENSION,
  formatElapsedClock,
  memoExtension,
  memoFileName,
  memoMimeType,
} from '../src/features/evidence/media-recorder-format';

describe('formatElapsedClock', () => {
  it('formats a take under a minute with a padded seconds field', () => {
    expect(formatElapsedClock(7_000)).toBe('0:07');
  });

  it('floors rather than rounds, so the clock never claims time that has not passed', () => {
    expect(formatElapsedClock(7_600)).toBe('0:07');
    expect(formatElapsedClock(59_999)).toBe('0:59');
  });

  it('reads minutes and seconds together once there are minutes', () => {
    expect(formatElapsedClock((4 * 60 + 32) * 1000)).toBe('4:32');
  });

  it('adds an hours field only once there are hours', () => {
    expect(formatElapsedClock((60 * 60 + 4 * 60 + 9) * 1000)).toBe('1:04:09');
  });

  it('never renders a negative or non-finite clock', () => {
    expect(formatElapsedClock(0)).toBe('0:00');
    expect(formatElapsedClock(-5_000)).toBe('0:00');
    expect(formatElapsedClock(Number.NaN)).toBe('0:00');
    expect(formatElapsedClock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('memoExtension', () => {
  it('reads the extension off a plain cache path', () => {
    expect(memoExtension('file:///var/mobile/Containers/Data/Application/tmp/recording.m4a')).toBe('.m4a');
  });

  it('lowercases an uppercase extension', () => {
    expect(memoExtension('file:///cache/Take.M4A')).toBe('.m4a');
  });

  it('falls back to the transcribable default only when the URI carries no extension', () => {
    expect(memoExtension('file:///cache/recording')).toBe(DEFAULT_MEMO_EXTENSION);
    expect(memoExtension('file:///cache/take.')).toBe(DEFAULT_MEMO_EXTENSION);
  });

  it('never substitutes a present extension for a more convenient one', () => {
    expect(memoExtension('content://media/external/audio/take.3gp')).toBe('.3gp');
  });

  it('strips a query string before reading the extension', () => {
    expect(memoExtension('file:///cache/take.m4a?source=share-sheet')).toBe('.m4a');
  });

  it('treats a dotfile as extensionless', () => {
    expect(memoExtension('file:///cache/.noise')).toBe(DEFAULT_MEMO_EXTENSION);
  });

  it('handles a Windows-style path separator', () => {
    expect(memoExtension('C:\\Users\\investigator\\AppData\\take.wav')).toBe('.wav');
  });
});

describe('memoFileName', () => {
  it('names the memo in local time with a filesystem-safe timestamp', () => {
    expect(memoFileName(new Date(2026, 8, 14, 14, 32, 8), '.m4a')).toBe('Statement 2026-09-14 14.32.08.m4a');
  });

  it('pads single-digit date and time parts', () => {
    expect(memoFileName(new Date(2026, 0, 5, 9, 7, 3), '.m4a')).toBe('Statement 2026-01-05 09.07.03.m4a');
  });

  it('keeps the extension as the last dotted segment, so the upload screen can derive its title', () => {
    const name = memoFileName(new Date(2026, 8, 14, 14, 32, 8), '.m4a');
    expect(name.replace(/\.[^.]+$/, '')).toBe('Statement 2026-09-14 14.32.08');
  });

  it('distinguishes two takes recorded within the same minute', () => {
    const first = memoFileName(new Date(2026, 8, 14, 14, 32, 8), '.m4a');
    const second = memoFileName(new Date(2026, 8, 14, 14, 32, 9), '.m4a');
    expect(first).not.toBe(second);
  });
});

describe('memoMimeType', () => {
  it('maps only the containers the recorder can actually produce', () => {
    expect(memoMimeType('.m4a')).toBe('audio/mp4');
    expect(memoMimeType('.mp4')).toBe('audio/mp4');
    expect(memoMimeType('.wav')).toBe('audio/wav');
    expect(memoMimeType('.webm')).toBe('audio/webm');
    expect(memoMimeType('.3gp')).toBe('audio/3gpp');
  });

  it('returns null rather than guessing for anything else', () => {
    expect(memoMimeType('.flac')).toBeNull();
    expect(memoMimeType('.3gpp')).toBeNull();
    expect(memoMimeType('.jpg')).toBeNull();
  });
});
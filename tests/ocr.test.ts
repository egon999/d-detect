import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TextRecognitionResult } from '@react-native-ml-kit/text-recognition';
import { recogniseText } from '@services/ingestion/ocr';

/**
 * On-device text recognition.
 *
 * The native module is mocked, not the function under test: everything below exercises the
 * real `recogniseText`, including its two-model comparison and its failure mapping. What is
 * faked is only ML Kit itself, which cannot run in Node.
 *
 * The failure cases carry most of the weight. `recogniseText` is documented never to throw,
 * because the callers are picker flows — an exception there leaves a user staring at a
 * spinner with no way back — and a promise that rejects is exactly the kind of contract that
 * rots silently without a test.
 */

const { recognize } = vi.hoisted(() => ({ recognize: vi.fn() }));

// Hoisted above the import below by Vitest, so the real binding — which reaches for
// `NativeModules` and cannot load under Node — is never evaluated.
vi.mock('@react-native-ml-kit/text-recognition', () => ({
  default: { recognize },
  // Mirrors the real enum. The values are the strings the binding passes to the native
  // side, and the mock keys results off them, so a rename upstream shows up here.
  TextRecognitionScript: {
    LATIN: 'Latin',
    CHINESE: 'Chinese',
    DEVANAGARI: 'Devanagari',
    JAPANESE: 'Japanese',
    KOREAN: 'Korean',
  },
}));

/** One recognised page: a single block whose lines carry geometry and a language guess. */
function page(...lines: string[]): TextRecognitionResult {
  return {
    text: lines.join('\n'),
    blocks: [
      {
        text: lines.join('\n'),
        lines: lines.map((text, index) => ({
          text,
          frame: { left: 12, top: 40 * index, width: 300, height: 28 },
          elements: [],
          recognizedLanguages: [{ languageCode: 'en' }],
        })),
        recognizedLanguages: [{ languageCode: 'en' }],
      },
    ],
  };
}

/** A page with a controlled amount of content, for exercising the two margins. */
const filler = (characters: number): TextRecognitionResult => page('x'.repeat(characters));

const EMPTY: TextRecognitionResult = { text: '', blocks: [] };

/** Answers each script with its own result, the way two different models would. */
function models(results: { latin: TextRecognitionResult; devanagari: TextRecognitionResult }) {
  recognize.mockImplementation((_uri: string, script: string) =>
    Promise.resolve(script === 'Devanagari' ? results.devanagari : results.latin),
  );
}

beforeEach(() => {
  recognize.mockReset();
});

describe('recogniseText', () => {
  it('runs both script models over the one image', async () => {
    models({ latin: page('Total: INR 1,500.00'), devanagari: EMPTY });

    await recogniseText('file:///receipt.jpg');

    expect(recognize).toHaveBeenCalledTimes(2);
    expect(recognize).toHaveBeenCalledWith('file:///receipt.jpg', 'Latin');
    expect(recognize).toHaveBeenCalledWith('file:///receipt.jpg', 'Devanagari');
  });

  it('returns the recognised lines with their geometry and language', async () => {
    models({ latin: page('TAX INVOICE', 'Total: INR 1,500.00'), devanagari: EMPTY });

    const outcome = await recogniseText('file:///receipt.jpg');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.text).toContain('INR 1,500.00');
    expect(outcome.result.script).toBe('Latin');
    expect(outcome.result.lines).toEqual([
      { text: 'TAX INVOICE', left: 12, top: 0, languages: ['en'] },
      { text: 'Total: INR 1,500.00', left: 12, top: 40, languages: ['en'] },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Failure reasons. Each maps to different wording on the upload screen, so each
  // is pinned separately.
  // ---------------------------------------------------------------------------

  it('reports NO_TEXT when neither model found anything readable', async () => {
    models({ latin: page('   ', ''), devanagari: EMPTY });

    const outcome = await recogniseText('file:///blank.jpg');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('NO_TEXT');
    // The message must name the two limits a user cannot otherwise discover, rather than
    // implying they took a bad photo.
    expect(outcome.message).toMatch(/handwriting/i);
    expect(outcome.message).toMatch(/latin and devanagari/i);
  });

  it('reports UNAVAILABLE when the native module is not linked into this build', async () => {
    // Verbatim shape of the binding's own linking error, which is what Expo Go throws.
    recognize.mockRejectedValue(
      new Error(
        `The package '@react-native-ml-kit/text-recognition' doesn't seem to be linked. Make sure: \n\n` +
          '- You rebuilt the app after installing the package\n',
      ),
    );

    const outcome = await recogniseText('file:///receipt.jpg');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('UNAVAILABLE');
    // Not "could not read this image": the image is fine, the build is not.
    expect(outcome.message).toMatch(/not available in this build/i);
    expect(outcome.message).toMatch(/type the details in/i);
  });

  it('reports FAILED when recognition itself blew up', async () => {
    recognize.mockRejectedValue(new Error('Bitmap decode failed'));

    const outcome = await recogniseText('file:///corrupt.jpg');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('FAILED');
    expect(outcome.message).toMatch(/sharper photo/i);
    // The internal error text is not shown to the user; it says nothing they can act on.
    expect(outcome.message).not.toContain('Bitmap decode failed');
  });

  it('reports FAILED rather than crashing when something rejects with a non-Error', async () => {
    recognize.mockRejectedValue('nope');

    const outcome = await recogniseText('file:///receipt.jpg');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('FAILED');
  });

  it('never rejects, whatever the native side does', async () => {
    recognize.mockRejectedValue(new Error('boom'));
    await expect(recogniseText('file:///receipt.jpg')).resolves.toMatchObject({ ok: false });
  });

  // ---------------------------------------------------------------------------
  // Choosing between the two models
  // ---------------------------------------------------------------------------

  it('switches to the other model when it found a quarter more text', async () => {
    models({ latin: filler(10), devanagari: filler(40) });

    const outcome = await recogniseText('file:///hindi-bill.jpg');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.script).toBe('Devanagari');
    // Already switched, so there is nothing left to offer.
    expect(outcome.result.otherScriptLooksBetter).toBe(false);
  });

  it('keeps the preferred model but offers the other when it found a little more', async () => {
    // 12 against 10: more, but not the quarter more that would justify overriding the
    // preference on the user's behalf. This band is the one the upload screen's "read it
    // as Devanagari" offer exists for — with a single margin it was unreachable.
    models({ latin: filler(10), devanagari: filler(12) });

    const outcome = await recogniseText('file:///mixed.jpg');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.script).toBe('Latin');
    expect(outcome.result.otherScriptLooksBetter).toBe(true);
  });

  it('offers nothing when the two models read the page much the same', async () => {
    models({ latin: filler(10), devanagari: filler(10) });

    const outcome = await recogniseText('file:///receipt.jpg');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.otherScriptLooksBetter).toBe(false);
  });

  it('honours a re-read in the requested script', async () => {
    models({ latin: filler(12), devanagari: filler(10) });

    const outcome = await recogniseText('file:///mixed.jpg', 'Devanagari');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Latin found slightly more, but the user asked for this model. It is reported, and
    // the alternative is offered — not silently substituted.
    expect(outcome.result.script).toBe('Devanagari');
    expect(outcome.result.otherScriptLooksBetter).toBe(true);
  });
});

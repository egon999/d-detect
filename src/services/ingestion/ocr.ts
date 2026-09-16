/**
 * On-device text recognition.
 *
 * ## Why on-device, and why this package
 *
 * Evidence is private. A payment receipt, a salary slip and a chat screenshot are exactly the
 * material Google's own Gemini terms tell you not to send to a free tier — "Do not submit
 * sensitive, confidential, or personal information", with human reviewers explicitly in scope.
 * ML Kit runs the model locally: the image never leaves the handset, there is no API key, no
 * per-call cost, and it works with the radio off.
 *
 * `@react-native-ml-kit/text-recognition` is the only React Native binding that exposes ML
 * Kit's **script selection**, and therefore the only one that can read Devanagari. The two
 * modern Expo-native alternatives (`expo-mlkit-ocr`,
 * `@infinitered/react-native-mlkit-text-recognition`) hardcode Latin in Kotlin with no
 * JavaScript escape hatch. For an app used in India that is disqualifying, so the older binding
 * wins on the one axis that matters.
 *
 * ## What this cannot tell you
 *
 * **There are no confidence scores.** ML Kit's Android API exposes them; this binding does not
 * surface them — its `TextBlock` / `TextLine` / `TextElement` types carry `text`, `frame`,
 * `cornerPoints` and `recognizedLanguages`, and nothing else. So the tempting design of
 * "route low-confidence numbers to the uncertain bucket" is **not available**, and any code
 * written as if it were would be inventing a number.
 *
 * What replaces it is stricter and more honest: *every* value read from an image is provisional
 * until a person confirms it, regardless of how clean it looks. See docs/product-thesis.md §4.
 * A single misread digit turning ₹1,500 into ₹7,500 would manufacture a contradiction that does
 * not exist — the worst failure this product can have — so nothing extracted here may raise a
 * finding on its own.
 *
 * ## Scripts
 *
 * The Devanagari model covers Hindi, Marathi, Nepali and Sanskrit. ML Kit has **no model at all**
 * for Tamil, Telugu, Bengali, Gujarati, Punjabi, Urdu, Kannada or Malayalam — documents in those
 * scripts are not readable by any on-device option, and the UI must say so rather than return an
 * empty result that looks like a failure the user caused.
 *
 * @see https://developers.google.com/ml-kit/vision/text-recognition/v2/languages
 */

import TextRecognition, {
  TextRecognitionScript,
  type TextRecognitionResult,
} from '@react-native-ml-kit/text-recognition';

/** One recognised line, kept separate because layout carries meaning. */
export interface RecognisedLine {
  text: string;
  /** Left edge in image pixels. Distinguishes sender from receiver in a chat screenshot. */
  left: number | null;
  /** Top edge in image pixels. Gives reading order across columns. */
  top: number | null;
  /** BCP-47-ish codes ML Kit attributed to this line. Often empty; never assume it is filled. */
  languages: string[];
}

export interface RecognisedText {
  /** Everything read, in ML Kit's block order. */
  text: string;
  lines: RecognisedLine[];
  /** Which model produced this. Surfaced so the UI can offer the other one. */
  script: 'Latin' | 'Devanagari';
  /**
   * True when the model that was *not* used found more text than the one that was — enough
   * more to be worth a second look, but not enough to override the caller's preference
   * outright (see the two margins in `recogniseText`).
   *
   * The caller should offer the switch rather than applying it, because the two results are
   * two separate readings of the same page and a merge of them is not a document.
   */
  otherScriptLooksBetter: boolean;
}

export type RecognitionOutcome =
  | { ok: true; result: RecognisedText }
  | {
      ok: false;
      reason: 'NO_TEXT' | 'UNAVAILABLE' | 'FAILED';
      message: string;
    };

/** Flattens ML Kit's block → line tree, keeping geometry. */
function toLines(result: TextRecognitionResult): RecognisedLine[] {
  const lines: RecognisedLine[] = [];
  for (const block of result.blocks) {
    for (const line of block.lines) {
      lines.push({
        text: line.text,
        left: line.frame?.left ?? null,
        top: line.frame?.top ?? null,
        languages: line.recognizedLanguages.map((l) => l.languageCode).filter(Boolean),
      });
    }
  }
  return lines;
}

/**
 * Counts characters that carry information, ignoring whitespace.
 *
 * Used only to compare two models' output on the same image. It is a crude measure and is not
 * reported to the user as a quality score, because it cannot tell confident text from confident
 * nonsense — it only answers "did this model find more to read than that one".
 */
function contentLength(result: TextRecognitionResult): number {
  return result.text.replace(/\s+/g, '').length;
}

/**
 * Reads text from an image.
 *
 * Both models are run. Google does not document whether the Devanagari model also reads Latin
 * in the same pass, and Indian documents routinely mix Hindi prose with ASCII digits and English
 * headings — so rather than guess, this measures it per image and reports which one found more.
 * Both passes are local and cost nothing but time.
 *
 * Never throws: a picker flow that rejects leaves the user staring at a spinner.
 */
export async function recogniseText(
  uri: string,
  preferred: 'Latin' | 'Devanagari' = 'Latin',
): Promise<RecognitionOutcome> {
  let latin: TextRecognitionResult | null = null;
  let devanagari: TextRecognitionResult | null = null;

  try {
    [latin, devanagari] = await Promise.all([
      TextRecognition.recognize(uri, TextRecognitionScript.LATIN),
      TextRecognition.recognize(uri, TextRecognitionScript.DEVANAGARI),
    ]);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '';
    // The binding throws a linking error when the native module is missing — which is what
    // happens in Expo Go, or in any build made before the package was added.
    if (message.includes("doesn't seem to be linked")) {
      return {
        ok: false,
        reason: 'UNAVAILABLE',
        message: 'Reading text from images is not available in this build. Type the details in instead.',
      };
    }
    return {
      ok: false,
      reason: 'FAILED',
      message: 'Could not read this image. Try a sharper photo, or type the details in.',
    };
  }

  const latinLength = contentLength(latin);
  const devanagariLength = contentLength(devanagari);

  if (latinLength === 0 && devanagariLength === 0) {
    return {
      ok: false,
      reason: 'NO_TEXT',
      message:
        'No readable text was found in this image. Handwriting cannot be read, and scripts other than Latin and Devanagari are not supported.',
    };
  }

  // Two margins, because "which model should be used" and "is the other one worth offering"
  // are different questions with different costs.
  //
  // A model that found a quarter more content has plainly read a page the other could not,
  // so it is used outright. Below that the two are effectively reading the same page and the
  // caller's preference wins — but they have still disagreed, and if the unused model found
  // even a tenth more it is worth one tap of the user's attention.
  //
  // These were one number before, and that was a bug: with a single margin the chosen result
  // is by construction the larger one, so `otherScriptLooksBetter` could never be true and
  // the "read it as Devanagari" offer in the upload screen was unreachable code.
  const SWITCH_MARGIN = 1.25;
  const OFFER_MARGIN = 1.1;

  const preferLatin =
    preferred === 'Latin'
      ? devanagariLength <= latinLength * SWITCH_MARGIN
      : devanagariLength * SWITCH_MARGIN < latinLength;

  const chosen = preferLatin ? latin : devanagari;
  const other = preferLatin ? devanagari : latin;

  return {
    ok: true,
    result: {
      text: chosen.text,
      lines: toLines(chosen),
      script: preferLatin ? 'Latin' : 'Devanagari',
      otherScriptLooksBetter: contentLength(other) > contentLength(chosen) * OFFER_MARGIN,
    },
  };
}

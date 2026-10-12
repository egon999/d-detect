/**
 * Nothing on a screen that a developer would have written.
 *
 * ## Why this reads the source instead of rendering the screens
 *
 * This suite runs in a node environment with no renderer: there is no component harness, and
 * mounting one would drag in every native module these seven screens touch. What is being
 * guarded against is not a layout or a state machine, though — it is a *string*. A developer
 * string reaches a person by sitting in the source, and the source is readable directly.
 *
 * So this file parses the seven screen files, pulls out every string literal that can end up in
 * front of a person, and asserts that none of them is machinery.
 *
 * ## Why it also asserts the shape of the failure paths
 *
 * A string scan alone would pass a screen that had deleted its errors down to `undefined`. The
 * second half of this file pins the rule that replaced the per-screen wording: every catch that
 * sets state goes through the shared voice, and no screen owns a private copy of it any more.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The screens this suite owns. Paths are relative to the project root. */
const SCREENS = [
  'app/(tabs)/money.tsx',
  'app/(tabs)/tasks.tsx',
  'app/(tabs)/you.tsx',
  'app/ask.tsx',
  'app/attention.tsx',
  'app/capture.tsx',
  'app/recap.tsx',
];

const ROOT = join(__dirname, '..');

/**
 * Things that identify the machinery rather than the message.
 *
 * A bare three-digit number is absent on purpose: `500` appears in this app as a real quantity
 * — five hundred rupees, five hundred metres — and a rule that banned it would be fought with
 * rather than obeyed. What is banned is the *shape* a status code takes in the place a person
 * reads: an `HTTP` in front of it, or a status beside one of the words a failure sentence uses.
 */
const LEAKS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bHTTP\b/i, why: 'an HTTP status is not a thing a person reads' },
  { pattern: /\bHTTP\s*[45]\d\d\b/i, why: 'a status code shown as if it were an explanation' },
  { pattern: /\b[45]\d\d\b\s*(?:error|status|code)\b/i, why: 'a status code with a label' },
  { pattern: /\b(?:status|error)\s*[:=]?\s*[45]\d\d\b/i, why: 'a status code with a label' },
  { pattern: /\bundefined\b/, why: 'a value that was never set' },
  { pattern: /\bNaN\b/, why: 'a number that was never computed' },
  // Bounded by a non-word character on the left so that the word inside a longer one — the
  // `null` in `nullable`, say — is not mistaken for the value.
  { pattern: /(?:^|[^A-Za-z0-9_])null(?:$|[^A-Za-z0-9_])/, why: 'an empty slot inside a sentence' },
  { pattern: /\b(?:TypeError|RangeError|SyntaxError|ReferenceError|Exception)\b/, why: 'a thrown type' },
  { pattern: /\bError\s*[:(]/, why: 'an exception string' },
  { pattern: /\bat\s+\w+\s*\(/, why: 'a stack frame' },
  { pattern: /=>|\{["']/, why: 'a dump of a value' },
  { pattern: /\b(?:Firebase|Firestore|GoogleAPIs|gRPC|axios|XHR|SQL|Postgres|Supabase|Groq|Grok|OpenAI|Gemini|Claude|Anthropic|DeepSeek|Llama)\b/i, why: 'a provider or library name' },
  { pattern: /\b(?:ECONNREFUSED|ETIMEDOUT|ENOENT|errno)\b/i, why: 'an operating-system error' },
  { pattern: /\b[a-z0-9-]+\/[a-z][a-z-]{2,}\b/i, why: 'a code rather than a sentence' },
];

/**
 * The source with every comment removed.
 *
 * The scan has to run on code rather than prose, because the *comments* in these files discuss
 * the forbidden strings on purpose — one of them names `HTTP 409` to explain what was removed.
 * A scan that fired on that would be unfixable without deleting the explanation, and the
 * explanation is the thing that stops the mistake coming back.
 *
 * Removal happens here, in one pass, before anything is extracted: a comment is cut out whole,
 * apostrophes and all. The alternative — copying string literals through and skipping comments
 * — is what a first attempt at this did, and it went wrong on the ordinary English in a comment
 * ("the platform's own"). The apostrophe in `platform's` closed a literal that had never been
 * opened, so every quote after it was read backwards from then on and the code between was
 * harvested as if it were copy. Cutting comments first removes the problem at its source.
 */
function withoutComments(source: string): string {
  let out = '';
  let index = 0;

  while (index < source.length) {
    const here = source[index];
    const next = source[index + 1];

    if (here === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index);
      index = lineEnd === -1 ? source.length : lineEnd;
      continue;
    }

    if (here === '/' && next === '*') {
      const blockEnd = source.indexOf('*/', index + 2);
      index = blockEnd === -1 ? source.length : blockEnd + 2;
      continue;
    }

    if (here === '"' || here === "'" || here === '`') {
      out += here;
      index += 1;
      while (index < source.length) {
        const char = source[index];
        out += char;
        index += 1;
        if (char === '\\') {
          out += source[index] ?? '';
          index += 1;
          continue;
        }
        if (char === here) break;
      }
      continue;
    }

    out += here;
    index += 1;
  }

  return out;
}

/**
 * The source with its imports removed.
 *
 * A module specifier is a string literal that no person will ever see — `expo-file-system/legacy`
 * and `@api/files` are paths, not copy — and leaving them in the scan would mean either a false
 * failure or a rule loose enough to let a real code through. Imports are stripped whole rather
 * than special-cased later, so there is no list of allowed-looking paths to keep up to date.
 */
function withoutImports(source: string): string {
  return source
    .replace(/^\s*import[\s\S]*?from\s*['"][^'"]*['"];?/gm, '')
    .replace(/^\s*import\s*['"][^'"]*['"];?/gm, '');
}

/**
 * The fixed text of a template literal, with the interpolations taken out.
 *
 * What a person reads in `` `Version ${APP_VERSION}` `` is "Version " — the rest is an
 * expression, and an expression is full of the punctuation a leak rule looks for. Scanning the
 * literal whole therefore reports the code inside it as shown text. Brace depth is counted
 * rather than matched with a pattern, because these expressions nest: one of them passes an
 * options object to `toLocaleTimeString`.
 */
function templateText(literal: string): string[] {
  const parts: string[] = [];
  let current = '';
  let index = 0;

  while (index < literal.length) {
    if (literal[index] === '\\') {
      current += literal.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (literal[index] === '$' && literal[index + 1] === '{') {
      parts.push(current);
      current = '';
      index += 2;
      let depth = 1;
      while (index < literal.length && depth > 0) {
        if (literal[index] === '{') depth += 1;
        else if (literal[index] === '}') depth -= 1;
        index += 1;
      }
      continue;
    }
    current += literal[index];
    index += 1;
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Whether a run of characters is prose rather than code.
 *
 * The two scans below both need this, and for the same reason: TSX spells a generic with the
 * same two characters JSX spells a tag with, so `useState<string | null>(null)` ends a `>` and
 * begins a `<` exactly as an element does, and the text "between the tags" comes out as
 * `(null);  const [next, setNext] = useState`. Every such capture carries the marks of code —
 * a semicolon, a bracket, an `=` — and no sentence in this app carries any of them.
 */
function looksLikeProse(text: string): boolean {
  if (!/^[A-Za-z“‘]/.test(text)) return false;
  if (!/[a-z]/.test(text)) return false;
  if (/[{}`;=<>()[\]|]/.test(text)) return false;
  if (text.endsWith(',')) return false;
  return true;
}

/**
 * A media type, which is handed to the phone and never to a person.
 *
 * These screens pass `image/jpeg` to the photo picker and `application/json` to the share
 * sheet, and both read as the kind of code this file bans. The pattern is anchored to the
 * registered top-level type names rather than to "anything with a slash in it", so the thing
 * it must not be able to excuse — a failure code like `auth/invalid-credential` — still fails.
 */
const MEDIA_TYPE = /^(?:image|audio|video|application|text|font|model|multipart)\/[a-z0-9.*+-]+(?:;[a-z-]+=[a-z0-9-]+)?$/;

/**
 * Every string a screen can put in front of a person.
 *
 * Three scans, because the copy in these files takes three shapes: text between tags on one
 * line, text that is the whole of its own line inside a component, and a literal handed to a
 * prop — which is how every one of these screens shows an error.
 */
function shownStrings(source: string): string[] {
  const code = withoutImports(withoutComments(source));
  const found: string[] = [];

  // Text between tags, on one line. The newline exclusion is what keeps a multi-line stretch
  // of code between two generics from being read as the contents of an element.
  for (const match of code.matchAll(/>([^<>{}\n]+)</g)) {
    const text = (match[1] ?? '').trim();
    if (looksLikeProse(text)) found.push(text);
  }

  // Text that is the whole of its line, which is the shape nearly all of this copy takes.
  for (const line of code.split('\n')) {
    const text = line.trim();
    if (looksLikeProse(text)) found.push(text);
  }

  // String literals, in the forms the screens use for props, hints and fallbacks.
  for (const match of code.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
    if (match[3] !== undefined) {
      found.push(...templateText(match[3]));
      continue;
    }
    const text = (match[1] ?? match[2] ?? '').trim();
    if (text.length === 0 || MEDIA_TYPE.test(text)) continue;
    found.push(text);
  }

  return found;
}

describe('every screen in this suite speaks to a person', () => {
  for (const screen of SCREENS) {
    it(`${screen} shows no developer text`, () => {
      const source = readFileSync(join(ROOT, screen), 'utf8');
      const strings = shownStrings(source);

      // A parse that found nothing would pass the loop below for the wrong reason.
      expect(strings.length, `${screen} yielded no strings to check`).toBeGreaterThan(20);

      for (const text of strings) {
        for (const { pattern, why } of LEAKS) {
          expect(pattern.test(text), `${screen} shows ${JSON.stringify(text)} — ${why}`).toBe(false);
        }
      }
    });

    it(`${screen} keeps every failure in the shared voice`, () => {
      const source = readFileSync(join(ROOT, screen), 'utf8');

      // No screen owns a copy of the mapper any more. A private one is how the three voices
      // this app used to speak in began.
      expect(source).not.toMatch(/function\s+(?:readableError|messageFor|describeError)\s*\(/);
      expect(source).not.toMatch(/function\s+technicalDetail\s*\(/);

      // The sentence shown after a failure is never built from the thrown value by hand.
      expect(source).not.toMatch(/set\w*Error\w*\(\s*(?:String\s*\(\s*\w*error|error\.message|err\.message)/i);
      expect(source).not.toMatch(/String\s*\(\s*(?:error|err|cause|e)\s*\)/);

      // Something shared is imported wherever a failure is caught.
      if (/catch\s*\(/.test(source)) {
        expect(source).toMatch(/readableError|readableAuthError|worthRetrying|isCancelled/);
      }
    });
  }

  it('leaves no error rendered with a detail slot filled from the failure', () => {
    for (const screen of SCREENS) {
      const source = readFileSync(join(ROOT, screen), 'utf8');
      expect(source, `${screen} passes a failure straight into a detail slot`).not.toMatch(
        /detail=\{(?:failure|loadFailure|error|saveError|adviceError)\b/,
      );
    }
  });
});

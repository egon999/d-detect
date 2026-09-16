/**
 * Colour arithmetic.
 *
 * One function, because the app needs exactly one thing the token file cannot give it: a
 * token's colour at a different opacity.
 *
 * ## Why this is not solved by adding another token
 *
 * A tone carries four values — `fg`, `bg`, `border`, `solid` — and they are tuned for the
 * places tones are used: a chip, a tile, a left rule. `bg` is a 10% tint in the dark scheme,
 * which is right for a chip's ground and much too faint for a highlighter mark on a quoted
 * line, where the mark has to survive being read as *ink on the page* rather than as a panel.
 * Adding a fifth `mark` value to all fourteen tones to serve one component would spend the
 * token file's budget on a local decision; deriving it at the call site keeps the tone's
 * meaning in one place and the emphasis where it is chosen.
 *
 * The tokens are not uniform in format — `fg` is a hex triple and `bg` is already an `rgba()`
 * string — so this handles both, and it fails loudly rather than returning a colour that
 * silently paints nothing.
 */

/** Matches `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`. */
const HEX = /^#([0-9a-f]{3,8})$/i;

/**
 * The opacity a highlighter mark is laid on at.
 *
 * Lives here rather than in the component that draws it so `theme-contrast.test.ts` can pin
 * the real number: the mark is a tone's own colour laid over its own translucent ground, and
 * whether the value stays readable through both layers depends on this one figure. A tint
 * chosen by eye in a mock and then found to be unreadable in hand is the failure mode.
 *
 * 0.22 is where a mark stops looking like a faint selection and starts looking like ink,
 * while still clearing AA for every tone on every surface in both schemes.
 */
export const MARK_OPACITY = 0.22;

/** Matches `rgb(r, g, b)` and `rgba(r, g, b, a)` with any spacing. */
const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/**
 * Returns `color` at `alpha` opacity, keeping its red, green and blue channels.
 *
 * `alpha` replaces any opacity the input carried rather than multiplying with it: a caller
 * asking for 22% wants 22%, and compounding an invisible 10% token down to 2% is the bug this
 * function exists to avoid.
 *
 * Throws on a colour it cannot parse. Every input is a design token or a literal written in
 * this codebase, so an unparseable one is a mistake to fix at build time, not a case to
 * degrade gracefully at runtime — and the graceful degradation available here is a mark the
 * reader cannot see on the screen where the app makes its central claim.
 */
export function withAlpha(color: string, alpha: number): string {
  const opacity = Math.max(0, Math.min(1, alpha));
  const rgb = channelsOf(color);
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${round(opacity)})`;
}

function channelsOf(color: string): [number, number, number] {
  const trimmed = color.trim();

  const hex = HEX.exec(trimmed);
  if (hex) {
    const digits = hex[1]!;
    // Shorthand: each digit stands for a doubled pair, so `#8af` is `#88aaff`.
    if (digits.length === 3 || digits.length === 4) {
      return [pair(digits[0]! + digits[0]!), pair(digits[1]! + digits[1]!), pair(digits[2]! + digits[2]!)];
    }
    if (digits.length === 6 || digits.length === 8) {
      return [pair(digits.slice(0, 2)), pair(digits.slice(2, 4)), pair(digits.slice(4, 6))];
    }
    throw new Error(`withAlpha: "${color}" is not a 3, 4, 6 or 8 digit hex colour`);
  }

  const rgb = RGB.exec(trimmed);
  if (rgb) {
    return [byte(rgb[1]!), byte(rgb[2]!), byte(rgb[3]!)];
  }

  throw new Error(`withAlpha: "${color}" is not a hex or rgb(a) colour`);
}

function pair(digits: string): number {
  return Number.parseInt(digits, 16);
}

function byte(value: string): number {
  return Math.max(0, Math.min(255, Math.round(Number.parseFloat(value))));
}

/** Three decimal places: enough for any opacity a designer picks, short enough to read. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

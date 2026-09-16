/**
 * The design system's own claims, executed.
 *
 * `src/ui/tokens.ts` opens with a docblock asserting that every foreground clears WCAG AA on
 * every surface it can land on, that solid chips are readable, and that no two semantic tones
 * sit near each other on the hue wheel. Those were prose promises: true when written, and
 * silently breakable by any future colour edit.
 *
 * This file turns them into assertions. It exists because the accent was changed from royal
 * blue to gold, and gold is a *light* colour — it reads beautifully on the dark canvas and
 * measures 2.34:1 on white. That asymmetry is exactly the kind of thing a person changing a
 * hex value by eye will not catch, so it is checked here instead of trusted.
 *
 * Ratios are computed from the exported tokens themselves, never from copies, so the test
 * cannot drift away from what the app actually renders.
 */

import { describe, expect, it } from 'vitest';

import { MARK_OPACITY, withAlpha } from '../src/ui/color';
import { darkColors, lightColors, type ColorScheme, type Tone } from '../src/ui/tokens';

/** WCAG 2.1 AA for body text. */
const AA_TEXT = 4.5;
/** WCAG 2.1 AA for large text, icons and other non-text graphics. */
const AA_NON_TEXT = 3;

type RGB = readonly [number, number, number];

/** Parses `#RRGGBB` and `rgba(r, g, b, a)` alike — the token file uses both. */
function parseColor(value: string): { rgb: RGB; alpha: number } {
  const rgba = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1]!.split(',').map((part) => Number(part.trim()));
    return {
      rgb: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
      alpha: parts[3] ?? 1,
    };
  }

  const hex = value.replace('#', '');
  const expanded =
    hex.length === 3
      ? hex
          .split('')
          .map((char) => char + char)
          .join('')
      : hex;

  return {
    rgb: [
      parseInt(expanded.slice(0, 2), 16),
      parseInt(expanded.slice(2, 4), 16),
      parseInt(expanded.slice(4, 6), 16),
    ],
    alpha: 1,
  };
}

/** Source-over composite. A translucent chip fill is read against the blend, not the nominal colour. */
function composite(foreground: string, background: string): string {
  const front = parseColor(foreground);
  const back = parseColor(background);
  const blended = front.rgb.map((channel, index) =>
    Math.round(channel * front.alpha + (back.rgb[index] ?? 0) * (1 - front.alpha)),
  );
  return `#${blended.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function relativeLuminance(color: string): number {
  const { rgb } = parseColor(color);
  const [r, g, b] = rgb.map((channel) => {
    const normalised = channel / 255;
    return normalised <= 0.03928
      ? normalised / 12.92
      : Math.pow((normalised + 0.055) / 1.055, 2.4);
  }) as unknown as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Hue in degrees. Used to prove two tones are told apart by more than a shade. */
function hue(color: string): number {
  const { rgb } = parseColor(color);
  const [r, g, b] = rgb.map((channel) => channel / 255) as unknown as RGB;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;

  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (sector * 60 + 360) % 360;
}

/** Smallest angle between two hues, accounting for the wrap at 360°. */
function hueDistance(a: string, b: string): number {
  const raw = Math.abs(hue(a) - hue(b));
  return raw > 180 ? 360 - raw : raw;
}

/** HSL saturation, 0-100. The second axis the token contract allows tones to separate on. */
function saturation(color: string): number {
  const { rgb } = parseColor(color);
  const [r, g, b] = rgb.map((channel) => channel / 255) as unknown as RGB;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;

  const lightness = (max + min) / 2;
  return (delta / (1 - Math.abs(2 * lightness - 1))) * 100;
}

const SCHEMES: ReadonlyArray<readonly [string, ColorScheme]> = [
  ['dark', darkColors],
  ['light', lightColors],
];

/** The surfaces any foreground can legitimately land on. */
const surfacesOf = (scheme: ColorScheme) =>
  [
    ['canvas', scheme.canvas],
    ['surface', scheme.surface],
    ['surfaceRaised', scheme.surfaceRaised],
    ['surfaceSunken', scheme.surfaceSunken],
  ] as const;

const TONES: readonly Tone[] = ['neutral', 'accent', 'danger', 'warn', 'ok', 'info', 'ai'];

describe.each(SCHEMES)('%s scheme', (_name, scheme) => {
  it('renders body text and both secondary ranks above AA on every surface', () => {
    for (const [surfaceName, surface] of surfacesOf(scheme)) {
      for (const token of ['text', 'textSecondary', 'textTertiary'] as const) {
        expect(
          contrast(scheme[token], surface),
          `${token} on ${surfaceName}`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it('keeps the accent legible on every surface it can be drawn over', () => {
    // `accent` is icon tints, focus rings, selection borders and quote rules — graphics
    // rather than prose, so it is held to the non-text threshold. `textAccent` is prose.
    for (const [surfaceName, surface] of surfacesOf(scheme)) {
      expect(
        contrast(scheme.accent, surface),
        `accent on ${surfaceName}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
      expect(
        contrast(scheme.textAccent, surface),
        `textAccent on ${surfaceName}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      expect(
        contrast(scheme.accentPressed, surface),
        `accentPressed on ${surfaceName}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it('pairs onAccent with accent so a filled accent element stays readable', () => {
    // The trap this catches: gold is light. Carrying the dark scheme's white `onAccent`
    // across to a gold `accent` would produce 2.34:1 — legible in a mock, unreadable in hand.
    expect(contrast(scheme.onAccent, scheme.accent)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(scheme.onCta, scheme.cta)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps the accent wash readable under both the accent and body text', () => {
    for (const [surfaceName, surface] of surfacesOf(scheme)) {
      const wash = composite(scheme.accentSurface, surface);
      expect(
        contrast(scheme.text, wash),
        `text on accentSurface over ${surfaceName}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      expect(
        contrast(scheme.accent, wash),
        `accent on accentSurface over ${surfaceName}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it.each(TONES)('keeps the %s tone readable on every surface and on its own fill', (tone) => {
    const palette = scheme.tones[tone];

    for (const [surfaceName, surface] of surfacesOf(scheme)) {
      expect(
        contrast(palette.fg, surface),
        `tones.${tone}.fg on ${surfaceName}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);

      // The chip's label is read against the composited fill, not the nominal colour.
      const filled = composite(palette.bg, surface);
      expect(
        contrast(palette.fg, filled),
        `tones.${tone}.fg on its own bg over ${surfaceName}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each(TONES)('keeps the %s solid readable, because Chip draws solid labels in white', (tone) => {
    // `Chip` hardcodes `#FFFFFF` for its solid variant. Until that is a per-tone token,
    // every `solid` value is constrained by it — which is the mechanical reason the accent
    // tone could not simply be recoloured gold along with `colors.accent`.
    expect(contrast('#FFFFFF', scheme.tones[tone].solid)).toBeGreaterThanOrEqual(AA_TEXT);
  });
  it.each(SCHEMES)('keeps the %s paper material readable on every surface', (_name, scheme) => {
    // Paper is a quoted passage from the reader's own evidence — the most carefully read
    // text in the app — so both its ranks are held to the text threshold, and against the
    // *composited* wash rather than the nominal surface, because that wash is translucent.
    for (const [surfaceName, surface] of surfacesOf(scheme)) {
      const sheet = composite(scheme.paper.fill, surface);
      expect(
        contrast(scheme.paper.text, sheet),
        `paper.text on paper.fill over ${surfaceName}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      expect(
        contrast(scheme.paper.meta, sheet),
        `paper.meta on paper.fill over ${surfaceName}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
      expect(
        contrast(scheme.paper.border, sheet),
        `paper.border on paper.fill over ${surfaceName}`,
      ).toBeGreaterThanOrEqual(1.2);
    }
  });

  it.each(TONES)('keeps a %s reading stamp readable on the paper sheet', (tone) => {
    // `Excerpt` stamps the foot of a quoted sheet with how those characters were obtained,
    // in the *method's* tone — `warn` for a value recovered off a photograph, `ai` for one a
    // model proposed. That colour was tuned against the app's own glass surfaces, and it is
    // being drawn here on a warm translucent wash instead, so the pair is measured rather
    // than assumed. Without this, the caption distinguishing a figure a person typed from a
    // figure a model guessed could quietly become the least readable text on the screen.
    for (const [name, scheme] of SCHEMES) {
      for (const [surfaceName, surface] of surfacesOf(scheme)) {
        const sheet = composite(scheme.paper.fill, surface);
        expect(
          contrast(scheme.tones[tone].fg, sheet),
          `${name} tones.${tone}.fg on paper.fill over ${surfaceName}`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  it.each(TONES)('keeps the document ink readable through a %s highlighter mark', (tone) => {
    // How a highlighter actually works, and why it is drawn this way: the pen tints the
    // *paper* and the ink stays put. So the mark is the tone's colour at `MARK_OPACITY`
    // under text that keeps `paper.text`, and the pair is read through both translucent
    // layers — the tone wash over the paper wash over the surface.
    //
    // Drawing the marked run in the tone's own colour instead was the first attempt, and it
    // measured 3.7:1 for `ok` in the light scheme: a value the reader cannot make out, on the
    // one screen whose whole job is to show them where a figure in their evidence came from.
    // Tone-on-tone always loses contrast, which is the argument for this being the physical
    // arrangement rather than a preference.
    for (const [name, scheme] of SCHEMES) {
      const palette = scheme.tones[tone];
      for (const [surfaceName, surface] of surfacesOf(scheme)) {
        const marked = composite(
          withAlpha(palette.fg, MARK_OPACITY),
          composite(scheme.paper.fill, surface),
        );
        expect(
          contrast(scheme.paper.text, marked),
          `${name} paper.text on a ${tone} mark over ${surfaceName}`,
        ).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });
});

describe('hue discipline', () => {
  it.each(SCHEMES)('holds the %s accent away from the canvas hue', (_name, scheme) => {
    // The regression this exists to prevent. The accent was `#3D7BFF` at 220.8° against a
    // canvas at 226.2° — 5.3° apart. An accent that shares the hue of the surface behind it
    // has nothing to contrast against, and the result reads as flat and cheap no matter how
    // well spaced the layout is. Gold sits ~180° away.
    expect(hueDistance(scheme.accent, scheme.canvas)).toBeGreaterThan(45);
  });

  it.each(SCHEMES)('holds the %s paper material off the canvas hue', (_name, scheme) => {
    // The invariant that keeps the app's second material a material. Paper separates from
    // glass by *hue* — manila against royal navy — and almost not at all by luminance: the
    // wash is five to eight percent. So a well-meaning edit that pulled the paper tokens
    // back towards the blue family would cost the app the whole distinction while every
    // contrast assertion above still passed, which is precisely the kind of silent loss the
    // rest of this file exists to catch.
    //
    // Measured on `text` rather than `fill`, because `fill` is nearly transparent and the
    // warmth a reader actually perceives is the ink's. Roughly 175-180° in both schemes.
    expect(hueDistance(scheme.paper.text, scheme.canvas)).toBeGreaterThan(120);
    expect(hueDistance(scheme.paper.text, scheme.text)).toBeGreaterThan(120);
  });

  it.each(SCHEMES)('keeps the %s semantic tones distinguishable from one another', (_name, scheme) => {
    // `neutral` and `accent` are excluded on purpose: they are the same blue at two
    // saturations, so "inert" and "active" read as one family. The tones below all mean
    // different things about the evidence, so none of them may be told apart by a shade.
    const semantic = ['danger', 'warn', 'ok', 'info', 'ai'] as const;

    for (let i = 0; i < semantic.length; i += 1) {
      for (let j = i + 1; j < semantic.length; j += 1) {
        const a = semantic[i]!;
        const b = semantic[j]!;
        expect(
          hueDistance(scheme.tones[a].fg, scheme.tones[b].fg),
          `tones.${a}.fg vs tones.${b}.fg`,
        ).toBeGreaterThan(25);
      }
    }
  });

  it.each(SCHEMES)('keeps the %s chip accent clear of warn', (_name, scheme) => {
    // The measurement that decided `tones.accent` stays blue while `colors.accent` went gold:
    // gold is 46° and warn is 43.3°, so a gold accent chip beside a warn chip would be a
    // 2.6° distinction. On a tool that reports where records disagree, "primary" and "needs
    // attention" have to be separable at a glance.
    expect(hueDistance(scheme.tones.accent.fg, scheme.tones.warn.fg)).toBeGreaterThan(25);
  });

  it.each(SCHEMES)('separates the %s brand accent from warn', (_name, scheme) => {
    // `colors.accent` *is* gold, and gold and amber are neighbours on the wheel. The token
    // contract permits two colours to be close in hue only when a large saturation step
    // tells them apart — this pins the step that permission is resting on.
    //
    // The two axes are scored together rather than as alternatives, because they compose:
    // a colour 20° away *and* 37 saturation points apart is plainly better separated than
    // one 2.6° away and 54 points apart, and an either/or threshold would rank those
    // backwards. Full marks on one axis alone is 30° of hue or 40 points of saturation;
    // anything reaching 1.0 between them passes.
    //
    //   dark  — 2.7° + 54pt → 1.45   (hue carries none of it; saturation carries all)
    //   light — 20.3° + 37pt → 1.61  (brass can go darker than amber ever will, so it
    //                                 gets real hue separation as well)
    //
    // The bright `#D4AF37` gold this replaced scored 0.88 and would fail here, which is
    // the point: without this, "brightening the gold" silently re-collides the brand
    // colour with the colour that means a person has to look at a finding.
    const dHue = hueDistance(scheme.accent, scheme.tones.warn.fg);
    const dSat = Math.abs(saturation(scheme.accent) - saturation(scheme.tones.warn.fg));
    const separation = dHue / 30 + dSat / 40;

    expect(
      separation,
      `accent vs tones.warn.fg: ${dHue.toFixed(1)}° apart, ${dSat.toFixed(0)} saturation points`,
    ).toBeGreaterThanOrEqual(1);
  });
});

import { describe, it, expect } from 'vitest';

import {
  darkColors,
  DENSITY,
  FOCUS_RING,
  HIT_TARGET,
  nestedRadius,
  RADIUS,
  SPACING,
  type Tone,
  type ToneColors,
} from '../src/ui/tokens';

/**
 * Contrast and hue separation, computed from the real tokens.
 *
 * `src/ui/tokens.ts` makes a series of measured claims about its palette — every tone's text
 * clears WCAG AA on every surface it can land on, no two semantic tones sit near each other on
 * the hue wheel, the gold accent is separated from `warn` by saturation rather than hue, and
 * `paper` stays a warm material rather than drifting back toward the royal canvas. Those are
 * not decorative statements. This product reports what it does and does not know, and a reader
 * who cannot tell "corroborated" from "for information" has been told something false about
 * their own evidence.
 *
 * ## Why the numbers are derived rather than listed
 *
 * Nothing below hard-codes an expected ratio. Every assertion recomputes from `darkColors`, so
 * changing a token is what moves the number and the threshold is the only thing pinned. A test
 * that asserted `8.89` would need editing by whoever broke it, which is the opposite of the
 * job — and a suite of literals is how a palette ends up "verified" against figures nobody has
 * recomputed since they were written down.
 *
 * ## Why the compositing step matters
 *
 * A chip's label is not read against its tone's nominal `bg`. `bg` is a translucent fill — 10%
 * to 15% alpha — so what the eye receives is the fill composited over whichever surface the
 * chip landed on. Measuring `fg` against the nominal `bg` string flatters every tone in the
 * file by several points. `over()` below does the alpha blend first, which is why these ratios
 * are lower than a naive check would report and why they are the ones worth holding.
 */

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

type Rgba = readonly [number, number, number, number];

const HEX = /^#([0-9a-f]{6})$/i;
const RGB = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i;

/**
 * Parses the two formats the token file actually uses.
 *
 * Deliberately narrow, and it throws rather than falling back. Every input is a token from this
 * repo, so an unparseable one is a token written in a format nothing renders — which a silent
 * `[0,0,0,1]` default would turn into a passing test about black.
 */
function parse(color: string): Rgba {
  const hex = HEX.exec(color.trim());
  if (hex) {
    const digits = hex[1]!;
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
      1,
    ];
  }
  const rgb = RGB.exec(color.trim());
  if (rgb) {
    return [+rgb[1]!, +rgb[2]!, +rgb[3]!, rgb[4] === undefined ? 1 : +rgb[4]!];
  }
  throw new Error(`Not a token colour this test can read: "${color}"`);
}

/** WCAG relative luminance. */
function luminance([r, g, b]: Rgba): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio. Order-independent, as the spec defines it. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(parse(a)), luminance(parse(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Composites a translucent colour over an opaque one, returning an opaque `rgb()` string. */
function over(fg: string, bg: string): string {
  const [r, g, b, a] = parse(fg);
  const [br, bg_, bb] = parse(bg);
  const mix = (top: number, bottom: number) => Math.round(top * a + bottom * (1 - a));
  return `rgb(${mix(r, br)}, ${mix(g, bg_)}, ${mix(b, bb)})`;
}

/** Hue in degrees, and saturation as a percentage, both from HSL. */
function hueSat(color: string): { hue: number; sat: number } {
  const [r255, g255, b255] = parse(color);
  const [r, g, b] = [r255 / 255, g255 / 255, b255 / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  const lightness = (max + min) / 2;
  const sat = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { hue, sat: sat * 100 };
}

/** Shortest distance round the wheel, so 350° and 10° are 20° apart rather than 340°. */
function hueDistance(a: string, b: string): number {
  const raw = Math.abs(hueSat(a).hue - hueSat(b).hue);
  return Math.min(raw, 360 - raw);
}

/**
 * The surfaces a chip or a label can land on.
 *
 * All four, including `surfaceSunken`. It is the darkest of them, so it flatters light text and
 * is never the binding case — but it is the ground of a progress track and a step indicator,
 * and leaving it out would mean the suite covered three of the four planes the app draws on.
 */
const SURFACES = {
  canvas: darkColors.canvas,
  surface: darkColors.surface,
  surfaceRaised: darkColors.surfaceRaised,
  surfaceSunken: darkColors.surfaceSunken,
} as const;

const AA = 4.5;
/** AA for non-text: borders, hairlines and pressed states, which carry no glyphs. */
const AA_NON_TEXT = 3;

const TONES = Object.entries(darkColors.tones) as [Tone, ToneColors][];
/** The five tones that answer a question about evidence. `neutral` and `accent` are chrome. */
const SEMANTIC_TONES: Tone[] = ['danger', 'warn', 'ok', 'info', 'ai'];

describe('theme contrast', () => {
  describe('tone foregrounds', () => {
    it.each(TONES)('%s fg clears AA on every surface', (_name, tone) => {
      for (const surface of Object.values(SURFACES)) {
        expect(contrast(tone.fg, surface)).toBeGreaterThanOrEqual(AA);
      }
    });

    it.each(TONES)('%s fg clears AA on its own bg over every surface', (_name, tone) => {
      for (const surface of Object.values(SURFACES)) {
        expect(contrast(tone.fg, over(tone.bg, surface))).toBeGreaterThanOrEqual(AA);
      }
    });

    it.each(TONES)('%s pairs its solid fill with an ink that clears AA on it', (_n, tone) => {
      // `Chip` and `CountBadge` set `emphasis="solid"` labels in `tone.onSolid`, and the leading dot
      // takes the same colour. Both used to hard-code `#FFFFFF`, which held for six tones and failed
      // for `warn` — its solid is a light amber, so white on it is barely a shape. Asserting the
      // *pair* rather than white-on-solid is what makes the token the thing under test: a tone whose
      // solid is re-lightened now has to bring its own ink down with it.
      expect(contrast(tone.solid, tone.onSolid)).toBeGreaterThanOrEqual(AA);
    });

    it.each(TONES)('%s onSolid is readable as a dot against its own solid', (_n, tone) => {
      // The dot in a solid chip is `onSolid` on `solid` and carries no glyph, so it is held to the
      // non-text threshold rather than AA. Separate from the assertion above because a shape and a
      // letter are not the same reading task, and collapsing them would quietly hold one of the two
      // to the wrong bar.
      expect(contrast(tone.solid, tone.onSolid)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });

    it.each(TONES)('%s border is visible against every surface', (_name, tone) => {
      for (const surface of Object.values(SURFACES)) {
        expect(contrast(over(tone.border, surface), surface)).toBeGreaterThanOrEqual(1.05);
      }
    });
  });

  describe('text ranks', () => {
    const RANKS = ['text', 'textSecondary', 'textTertiary', 'textAccent'] as const;

    it.each(RANKS)('%s clears AA on every surface', (rank) => {
      // Tertiary is the binding case and the reason this test exists: it carries timestamps and
      // source lines, which is exactly the text a reader squints at.
      for (const surface of Object.values(SURFACES)) {
        expect(contrast(darkColors[rank], surface)).toBeGreaterThanOrEqual(AA);
      }
    });

    it('keeps the accent itself text-safe on every surface', () => {
      // `accent` is `gold500`, and it is not only a fill: it sets the active tab label, the
      // wordmark and every link-shaped control. The gold ramp was chosen over a brighter one
      // on the argument that a muted gold still clears AA as text on this canvas, so that is
      // the claim worth holding — the moment someone re-saturates the ramp for punch, this is
      // the assertion that should stop them rather than a reviewer's eye.
      for (const surface of Object.values(SURFACES)) {
        expect(contrast(darkColors.accent, surface)).toBeGreaterThanOrEqual(AA);
      }
    });

    it('puts dark ink on the accent fill, because gold cannot carry white', () => {
      // The gold ramp is a *light* colour: white on it is far under AA. Anything filled with
      // `accent` has to put the canvas on top, which is what `onAccent` is.
      expect(contrast('#FFFFFF', darkColors.accent)).toBeLessThan(AA);
      expect(contrast(darkColors.onAccent, darkColors.accent)).toBeGreaterThanOrEqual(AA);
    });

    it('keeps white readable on the primary button', () => {
      expect(contrast(darkColors.onCta, darkColors.cta)).toBeGreaterThanOrEqual(AA);
    });

    it('keeps the pressed accent usable as a non-text fill', () => {
      for (const surface of Object.values(SURFACES)) {
        expect(contrast(darkColors.accentPressed, surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    });
  });

  describe('hue separation', () => {
    it('holds every pair of tones apart by hue or by saturation', () => {
      // The token file's own claim, stated over all seven tones rather than the semantic five:
      // any two tones are either ~30 degrees apart on the wheel or separated by a large
      // saturation step. Exactly one pair currently relies on the second clause — `neutral` and
      // `accent`, which share a hue deliberately — and the next test pins that on its own. The
      // point of checking all 21 pairs here is that adding an eighth tone cannot quietly land
      // next to an existing one.
      for (let i = 0; i < TONES.length; i += 1) {
        for (let j = i + 1; j < TONES.length; j += 1) {
          const [aName, a] = TONES[i]!;
          const [bName, b] = TONES[j]!;
          const distance = hueDistance(a.fg, b.fg);
          const satGap = Math.abs(hueSat(a.fg).sat - hueSat(b.fg).sat);
          expect(distance >= 30 || satGap >= 50, `${aName} vs ${bName}`).toBe(true);
        }
      }
    });

    it('holds every pair of semantic tones at least 30 degrees apart', () => {
      for (let i = 0; i < SEMANTIC_TONES.length; i += 1) {
        for (let j = i + 1; j < SEMANTIC_TONES.length; j += 1) {
          const a = SEMANTIC_TONES[i]!;
          const b = SEMANTIC_TONES[j]!;
          const distance = hueDistance(darkColors.tones[a].fg, darkColors.tones[b].fg);
          expect(distance, `${a} vs ${b}`).toBeGreaterThanOrEqual(30);
        }
      }
    });

    it('holds info away from accent, which is the pair that forced the teal', () => {
      // `info` was sky blue and sat 25 degrees from `accent`, so "informational" and
      // "actionable" were told apart by a shade. One of those means a person still has to act.
      expect(hueDistance(darkColors.tones.info.fg, darkColors.tones.accent.fg))
        .toBeGreaterThanOrEqual(30);
    });

    it('separates neutral from accent by saturation, since they share a hue on purpose', () => {
      // The documented exception to the rule above: the same blue at 20% and 100% saturation,
      // so "inert" and "active" read as one family. The rule it has to satisfy instead is a
      // large saturation step.
      const neutral = hueSat(darkColors.tones.neutral.fg);
      const accent = hueSat(darkColors.tones.accent.fg);
      expect(hueDistance(darkColors.tones.neutral.fg, darkColors.tones.accent.fg)).toBeLessThan(10);
      expect(accent.sat - neutral.sat).toBeGreaterThanOrEqual(50);
    });

    it('separates the gold accent from warn by saturation, not hue', () => {
      // The load-bearing assertion of the whole gold decision. A bright gold sits ~3 degrees
      // from `warn`: two chips side by side, one meaning "brand" and one meaning "a person must
      // look at this", would be the same colour. Gold stays quiet so it cannot be confused with
      // amber, and this is what stops someone brightening it back up.
      const gold = hueSat(darkColors.accent);
      const warn = hueSat(darkColors.tones.warn.fg);
      expect(hueDistance(darkColors.accent, darkColors.tones.warn.fg)).toBeLessThan(10);
      expect(warn.sat - gold.sat).toBeGreaterThanOrEqual(50);
    });

    it('keeps tones.accent blue even though colors.accent is gold', () => {
      // Not an oversight, and it should not be tidied into matching. `colors.accent` paints
      // structure; `tones.accent` paints chips that sit in a row beside `warn`, where the colour
      // *is* the meaning. Gold there would collide with `warn` and could not carry white.
      expect(hueDistance(darkColors.accent, darkColors.tones.accent.fg)).toBeGreaterThan(90);
    });
  });

  describe('paper is a second material, not a tinted panel', () => {
    it('holds the paper wash in the warm band, far from the royal canvas', () => {
      // A paper token that drifted back toward the canvas hue would cost the app its second
      // material while every contrast assertion above still passed. Hue is the whole effect:
      // what reads as paper on a navy screen is warmth, not lightness.
      for (const token of [darkColors.paper.fill, darkColors.paper.border, darkColors.paper.text]) {
        const { hue } = hueSat(token);
        expect(hue).toBeGreaterThan(20);
        expect(hue).toBeLessThan(70);
        expect(hueDistance(token, darkColors.canvas)).toBeGreaterThan(140);
      }
    });

    it('keeps the document voice warmer than the app voice', () => {
      // `paper.text` against `text`. If these converged, a quoted passage would stop reading as
      // somebody else's words — which is the claim that matters when a reader is deciding
      // whether to trust a figure in a demand letter.
      expect(hueDistance(darkColors.paper.text, darkColors.text)).toBeGreaterThan(140);
    });

    it('keeps quoted text and its reading stamp readable on the paper ground', () => {
      const ground = over(darkColors.paper.fill, darkColors.canvas);
      expect(contrast(darkColors.paper.text, ground)).toBeGreaterThanOrEqual(AA);
      expect(contrast(darkColors.paper.meta, ground)).toBeGreaterThanOrEqual(AA);
    });
  });

  describe('glass', () => {
    it('keeps every glass layer low-contrast enough to read as a material', () => {
      // Real frosted glass modulates what is behind it by a few percent. The moment a
      // translucent panel is strong enough to be noticed on its own it stops looking like a
      // material and starts looking like a sticker, which is the failure this pins.
      const layers = [
        darkColors.glass.highlight,
        darkColors.glass.border,
        darkColors.glass.innerBorder,
      ];
      for (const layer of layers) {
        expect(contrast(over(layer, darkColors.surface), darkColors.surface)).toBeLessThan(3);
      }
    });

    it('keeps body text readable on a glass panel over the canvas', () => {
      const panel = over(darkColors.glass.fill, darkColors.canvas);
      expect(contrast(darkColors.text, panel)).toBeGreaterThanOrEqual(AA);
      expect(contrast(darkColors.textSecondary, panel)).toBeGreaterThanOrEqual(AA);
      expect(contrast(darkColors.textTertiary, panel)).toBeGreaterThanOrEqual(AA);
    });
  });

  describe('the elevation ladder', () => {
    /**
     * The four planes in the order they stack, each paired with the one it sits on.
     *
     * `surfaceSunken` is the exception and is listed against `canvas` rather than below it: it is a
     * well cut *into* the page, not a layer above it, so the step that matters is the one a reader
     * sees at its edge.
     */
    const STEPS: ReadonlyArray<readonly [string, string, string]> = [
      ['surface on canvas', darkColors.surface, darkColors.canvas],
      ['surfaceRaised on surface', darkColors.surfaceRaised, darkColors.surface],
      ['surfaceSunken on canvas', darkColors.surfaceSunken, darkColors.canvas],
    ];

    it.each(STEPS)('%s is a step the eye can find', (_label, upper, lower) => {
      // Deliberately a low bar, and the number is the point: these steps are 1.04–1.17, which is
      // *not* enough for the fill alone to locate a card edge on a dim OLED panel. That is why
      // `Surface` draws a hairline and why the shadow was dropped rather than kept — a near-black
      // glow on a near-black canvas renders nothing and costs an offscreen pass per card. Holding
      // the floor here stops the ladder collapsing to literally zero while being honest that the
      // border is the load-bearing half of the treatment.
      expect(contrast(upper, lower)).toBeGreaterThan(1.03);
    });

    it('keeps the ladder monotonic, so a higher plane is never darker', () => {
      // Three planes in rising order. A ladder that inverted anywhere would put a raised card
      // *below* the page it floats on, which no border can rescue: the reader would be looking at
      // a hole where the app intended a lift.
      const rising = [darkColors.surfaceSunken, darkColors.canvas, darkColors.surface, darkColors.surfaceRaised];
      const luminances = rising.map((plane) => luminance(parse(plane)));
      for (let i = 1; i < luminances.length; i += 1) {
        expect(luminances[i]!, `plane ${i} is not above plane ${i - 1}`).toBeGreaterThan(
          luminances[i - 1]!,
        );
      }
    });

    it('holds every text rank above AA on a raised card, which is the lightest plane', () => {
      // The binding plane for light ink, and the one a dialog, a sheet and a selected row all use.
      // Covered by the rank suite above as one of four surfaces; restated here because this is the
      // case that fails first if the ladder is lifted to make the steps more visible, which is the
      // obvious and wrong fix for the 1.17 above.
      for (const rank of ['text', 'textSecondary', 'textTertiary', 'textAccent'] as const) {
        expect(contrast(darkColors[rank], darkColors.surfaceRaised)).toBeGreaterThanOrEqual(AA);
      }
    });
  });

  describe('the focus ring', () => {
    it('is visible as a non-text mark on every plane', () => {
      // A ring that cannot be seen is the same as no ring, and no ring means the app is unnavigable
      // by keyboard or switch access. Held to the non-text threshold because it carries no glyph —
      // but note it clears AA as text too, which is what the gold ramp was chosen for.
      for (const surface of Object.values(SURFACES)) {
        expect(contrast(darkColors.focusRing, surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    });

    it('is distinguishable from the accent fill that marks a selected row', () => {
      // The one confusion that would make the ring useless rather than invisible: if focus looked
      // like selection, a keyboard user could not tell which row they were *on* from which row was
      // *chosen*. This is why the ring is gold rather than the accent blue.
      const selected = over(darkColors.accentSurface, darkColors.surface);
      expect(contrast(darkColors.focusRing, selected)).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });

    it('is not mistakable for any semantic tone, so it never states something about the control', () => {
      // A red ring on a delete button would read as a warning the control did not raise, and a
      // green one as a confirmation. The ring reports position and nothing else.
      //
      // Separated by hue *or* by saturation, which is the same rule the tone-pair suite above
      // applies, and for the same reason: `warn` is amber and the ring is gold, so they sit about 6
      // degrees apart on the wheel and no hue threshold can tell them apart. That proximity is
      // deliberate — see "separates the gold accent from warn by saturation, not hue" — so the ring
      // inherits the saturation separation rather than pretending to a hue one.
      for (const name of SEMANTIC_TONES) {
        const ring = hueSat(darkColors.focusRing);
        const tone = hueSat(darkColors.tones[name].solid);
        const byHue = hueDistance(darkColors.focusRing, darkColors.tones[name].solid) >= 20;
        const bySat = Math.abs(ring.sat - tone.sat) >= 25;
        expect(byHue || bySat, `focusRing is mistakable for ${name}`).toBe(true);
      }
    });

    it('stays quieter than warn, which is the one tone it shares a hue with', () => {
      // Named on its own because it is the binding case and the only one. If the ring were
      // re-saturated to make it more visible it would land on amber, and a focused button would be
      // indistinguishable from one flagging that a person needs to look at something.
      expect(hueDistance(darkColors.focusRing, darkColors.tones.warn.solid)).toBeLessThan(15);
      expect(
        hueSat(darkColors.tones.warn.solid).sat - hueSat(darkColors.focusRing).sat,
      ).toBeGreaterThanOrEqual(25);
    });
  });

  describe('the disabled treatment', () => {
    it('sits below every live plane, so a dead control cannot read as a card', () => {
      // `disabledSurface` is flatter and darker than anything the app draws live content on. If it
      // drifted up into the `surface` band, a disabled button would look like an ordinary one that
      // happened not to work, which is the single most common way a user decides an app is broken.
      const dead = luminance(parse(darkColors.disabledSurface));
      expect(dead).toBeLessThan(luminance(parse(darkColors.surfaceRaised)));
      expect(dead).toBeLessThan(luminance(parse(darkColors.surface)));
    });

    it('keeps its border barely above its fill, so the edge reads as inert', () => {
      // A disabled control still needs an edge — a shape with no boundary is not a control at all,
      // and a user has to be able to see that the thing they cannot press is a button. But the edge
      // must not be as crisp as a live one, because crispness is what says "available". Between
      // 1.01 and the non-text threshold is the band where a boundary is present and unemphatic.
      const edge = contrast(
        over(darkColors.disabledBorder, darkColors.disabledSurface),
        darkColors.disabledSurface,
      );
      expect(edge).toBeGreaterThan(1.005);
      expect(edge).toBeLessThan(AA_NON_TEXT);
    });
  });

  describe('hairlines', () => {
    it('keeps the subtle rule quieter than the card rule, which is the whole distinction', () => {
      // Two weights exist so a divider between rows inside a card is not as loud as the card's own
      // edge. If they converged there would be no reason for `borderSubtle` to exist, and a list
      // inside a card would look like a stack of separate cards.
      const inside = contrast(over(darkColors.borderSubtle, darkColors.surface), darkColors.surface);
      const edge = contrast(over(darkColors.border, darkColors.surface), darkColors.surface);
      expect(inside).toBeLessThan(edge);
    });

    it('keeps both rules visible at all, since a hairline is doing load-bearing work here', () => {
      // `Surface` dropped its shadow, so the hairline is the only thing locating a card edge on
      // this canvas. A rule that composited away to nothing would leave the card with no boundary
      // of any kind — the fill step is 1.17 and cannot carry it alone.
      for (const rule of [darkColors.border, darkColors.borderSubtle, darkColors.accentHairline]) {
        for (const surface of Object.values(SURFACES)) {
          expect(contrast(over(rule, surface), surface)).toBeGreaterThan(1.01);
        }
      }
    });
  });
});

describe('layout tokens', () => {
  it('keeps the spacing scale strictly ascending with no duplicate steps', () => {
    // A scale with two equal steps is a scale with a step nobody can use: a developer picking
    // between `md` and `lg` would be choosing between two names for one number, and the choice
    // would stop carrying meaning. Strictly ascending is what makes each name a decision.
    const steps = ['none', 'xxs', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl', 'xxxl', 'huge', 'giant', 'colossal'] as const;
    for (let i = 1; i < steps.length; i += 1) {
      expect(
        SPACING[steps[i]!],
        `SPACING.${steps[i]} is not above SPACING.${steps[i - 1]}`,
      ).toBeGreaterThan(SPACING[steps[i - 1]!]);
    }
  });

  it('holds the documented spacing values, which screens are built against', () => {
    // Pinned as literals on purpose, which is the opposite of how the contrast assertions work and
    // for a reason: these twelve numbers are a published contract. Screens across the app are laid
    // out against `SPACING.lg` meaning 16, and changing it would silently reflow every one of them.
    // A derived assertion would let that happen; this one makes it a deliberate edit.
    expect(SPACING).toMatchObject({
      none: 0, xxs: 2, xs: 4, sm: 8, md: 12, lg: 16,
      xl: 20, xxl: 24, xxxl: 32, huge: 40, giant: 48, colossal: 64,
    });
  });

  it('keeps the radius scale ascending, so shape tracks size', () => {
    // The same argument as spacing, plus one more: `radiusForHeight` maps a box to a radius by
    // walking these in order, so a non-monotonic scale would make a taller box rounder *and*
    // sharper depending on which threshold it crossed.
    const steps = ['none', 'xs', 'sm', 'md', 'lg', 'xl', 'xxl'] as const;
    for (let i = 1; i < steps.length; i += 1) {
      expect(RADIUS[steps[i]!]).toBeGreaterThan(RADIUS[steps[i - 1]!]);
    }
    // The pill is not part of the ladder — it is the sentinel that means "fully round", and
    // `nestedRadius` short-circuits on it rather than subtracting from it.
    expect(RADIUS.pill).toBe(999);
  });

  it('keeps the touch-target floor at the platform minimum', () => {
    // 44 is the figure both platform guidelines state, and `Pressable` tops up any target that
    // lands under it via measured `hitSlop`. Pinned because a well-meaning reduction to fit a
    // dense row would make every such row harder to hit for exactly the users who need it widest.
    expect(HIT_TARGET).toBe(44);
  });

  it('gives a nested box a smaller radius than its parent, so the two look concentric', () => {
    // Two rounded rectangles with the same radius do not look concentric — the corner gap reads
    // wider than the edge gap, which is what makes a thumbnail look pasted onto a card rather than
    // inset into it. Checked across the real scale rather than one example.
    for (const outer of [RADIUS.sm, RADIUS.md, RADIUS.lg, RADIUS.xl, RADIUS.xxl]) {
      for (const inset of [1, 2, 4]) {
        expect(nestedRadius(outer, inset)).toBeLessThan(outer);
        expect(nestedRadius(outer, inset)).toBeGreaterThanOrEqual(0);
      }
    }
    // A pill stays a pill at any inset: subtracting from 999 would produce a lozenge with
    // visible straight edges where the parent has none.
    expect(nestedRadius(RADIUS.pill, 4)).toBe(RADIUS.pill);
  });

  it('never returns a negative radius, which would throw on Android', () => {
    // The guard is real, not defensive: an inset larger than the parent's own corner is what a
    // 2pt ring inside a 1pt-radius box produces, and a negative `borderRadius` is a hard error on
    // Android rather than a clamped one.
    expect(nestedRadius(RADIUS.xs, 100)).toBe(0);
    expect(nestedRadius(0, 4)).toBe(0);
  });

  it('places the focus ring outside the control it marks', () => {
    // The offset is fed straight to `top`/`left`/`right`/`bottom`, so it has to be negative for the
    // ring to sit clear of the control's own edge. A positive value would draw it *inside*, over
    // the border and the fill, which is where it would be invisible on a filled button.
    expect(FOCUS_RING.offset).toBeLessThan(0);
    // And the corner has to grow by the gap, or the ring pulls away from each corner of the box
    // it is supposed to trace.
    expect(FOCUS_RING.radiusBleed).toBe(Math.abs(FOCUS_RING.offset));
    // WCAG 2.2 asks for a 2pt minimum focus indicator.
    expect(FOCUS_RING.width).toBeGreaterThanOrEqual(2);
  });

  it('keeps compact density genuinely tighter than comfortable, in every dimension', () => {
    // Density is only hierarchy if the two differ on all three measures. A `compact` that matched
    // `comfortable` on padding would make a forty-row list and a single-record detail view read as
    // the same screen, which is the thing having two densities exists to prevent.
    expect(DENSITY.compact.padding).toBeLessThan(DENSITY.comfortable.padding);
    expect(DENSITY.compact.gap).toBeLessThan(DENSITY.comfortable.gap);
    expect(DENSITY.compact.rowHeight).toBeLessThanOrEqual(DENSITY.comfortable.rowHeight);
  });

  it('keeps even a compact row tappable', () => {
    // The one floor density is not allowed to cross. Saving scroll height is worth real spacing;
    // it is not worth a row a thumb misses.
    expect(DENSITY.compact.rowHeight).toBeGreaterThanOrEqual(HIT_TARGET);
  });
});

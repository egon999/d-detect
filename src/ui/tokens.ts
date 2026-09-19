/**
 * Design tokens.
 *
 * This module is deliberately free of any React Native import so it can be read by
 * tests, scripts and the Cloud Functions type checking without pulling in a runtime.
 * Everything here is plain data.
 *
 * The palette is split into two layers:
 *
 *   1. `palette` — raw, unnamed-by-purpose values. Never referenced by a component.
 *   2. `lightColors` / `darkColors` — semantic roles. Components only ever reference
 *      these, so re-theming never means hunting for a hex literal.
 *
 * ## The visual direction
 *
 * A precision instrument, not an app that wants attention. Deep royal navy canvas, surfaces
 * that separate by *lightness plus a hairline* rather than by shadow, machine-readable type,
 * and one narrow accent reserved for the things the user acts through. The reference is a
 * forensic lab console: dense, calm, authoritative, and legible for an hour at a time.
 *
 * The restraint that keeps it from being decorative: **saturation carries meaning**. A chip
 * is amber because a finding is medium severity, not because amber looks nice there. The
 * gradient never appears behind body text, only on controls and as a sub-2% surface sheen.
 *
 * ## Epistemic colour is the load-bearing decision
 *
 * This product reports what it does and does not know: "possible conflict", "suggested
 * relationship", "unsupported claim", "needs review", "corroborated". Misreading one of
 * those is a real harm to a real case, so the tone scale is built for *discriminability*
 * before beauty, and verified rather than eyeballed:
 *
 *   - Every `fg` clears WCAG AA (4.5:1) on `canvas`, `surface` and `surfaceRaised`, and
 *     again on its own `bg` after that translucent fill is composited over each of those
 *     surfaces — a chip's text is read against the blend, not against the nominal colour.
 *   - Every `solid` clears AA against white, because solid chips draw their label in white.
 *   - The seven `fg` hues are held at least ~30° apart *or* separated by a large saturation
 *     step. `neutral` and `accent` share a hue on purpose — they are the same blue at 20%
 *     and 100% saturation, so "inert" and "active" read as one family — but no two
 *     *semantic* tones (ok / warn / danger / info / ai) are near each other on the wheel.
 *     `info` is deliberately pulled to teal rather than left at sky blue, which would have
 *     sat 25° from `accent` and made "informational" and "actionable" look alike.
 *
 * The rule that follows from all this: **never style an uncertain finding so it looks
 * certain.** `ok` is the only tone that reads as settled. `warn` means a person must look;
 * `ai` means a model produced it and nobody has confirmed it; `neutral` means unsupported,
 * which is a legitimate state and not an error. That is why `MIXED_REVIEW` is amber and
 * not red in `semantics.ts`, and why nothing uncertain is ever given the `ok` green.
 */

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/**
 * Font families, keyed by the exact string registered with `useFonts`.
 *
 * `src/ui/fonts.ts` builds its loader map *from* these constants, so the family name a
 * style asks for and the name the asset was registered under cannot drift apart.
 *
 * Two families, and the split is not decorative — it is the product's central claim
 * expressed typographically. Machine-extracted values are set in monospace, human
 * authored text in the sans. A reader can therefore see, without any legend or badge,
 * which parts of a case came out of a document and which a person typed. See
 * `src/ui/primitives/ProvenanceValue.tsx`.
 *
 * Plus Jakarta Sans for the human voice: geometric enough to feel like a modern app,
 * with enough humanist warmth in the `a`, `g` and `y` that a screenful of it does not
 * read as a spreadsheet. IBM Plex Mono for the machine voice, deliberately from a
 * different family — the contrast between the two is the point, so pairing a sans with
 * its own monospace sibling would blunt exactly the signal this product depends on.
 */
export const FONT_FAMILY = {
  sansRegular: 'PlusJakartaSans_400Regular',
  sansMedium: 'PlusJakartaSans_500Medium',
  sansSemiBold: 'PlusJakartaSans_600SemiBold',
  sansBold: 'PlusJakartaSans_700Bold',
  sansExtraBold: 'PlusJakartaSans_800ExtraBold',
  monoRegular: 'IBMPlexMono_400Regular',
  monoMedium: 'IBMPlexMono_500Medium',
  monoSemiBold: 'IBMPlexMono_600SemiBold',
} as const;

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const palette = {
  // Paper — white through to a cool blue-tinted near-white. The canvas is never pure
  // white: a faint royal cast makes the white cards read as raised without needing a
  // heavier shadow to say so, and keeps the light scheme in the same hue family as the
  // dark one rather than looking like a different product in daylight.
  white: '#FFFFFF',
  paper050: '#FBFCFE',
  paper075: '#F6F8FC',
  paper100: '#F2F5FC',
  paper150: '#EAEFF8',
  paper200: '#E3E9F5',
  paper300: '#D3DCEC',
  paper400: '#B0BBD4',
  paper500: '#8894B0',
  paper600: '#5E6B85',
  paper700: '#3B4763',
  paper800: '#243048',
  paper900: '#141D33',

  // Ink — indigo-navy neutrals. Retained because older surfaces reference them; the dark
  // scheme itself is now built from the `royal` ramp below.
  ink900: '#080A16',
  ink850: '#0E1120',
  ink800: '#141829',
  ink750: '#171B2E',
  ink700: '#1E2338',
  ink600: '#262C44',
  ink500: '#353D5A',
  ink400: '#4E5675',
  ink300: '#737A9B',
  ink200: '#A2A8C4',
  ink100: '#CACEE2',
  ink050: '#ECEEF8',

  // Brand — indigo-violet. Kept for the `ai` tone, which is the only place violet is
  // allowed to appear (see `semantics.ts`).
  violet300: '#B9AEFA',
  violet400: '#9182F5',
  violet500: '#7C6BEE',
  violet600: '#6A5AE0',
  violet700: '#5A48D6',
  violet800: '#4936B8',

  /**
   * Royal — the spine of the dark scheme.
   *
   * Re-cut so the four dark surfaces are separated by a real, even lightness step instead
   * of the near-identical values the previous ramp produced. On an OLED phone at low
   * brightness two surfaces 2% apart are indistinguishable, and the card edges vanish;
   * that flatness is a large part of what read as "cheap". Each step below is roughly
   * +4–6% relative luminance on the one before it, which survives both a dim screen and
   * a mid-range LCD.
   *
   * The hue is held at ~223° across the whole ramp — a single royal blue getting lighter,
   * never drifting toward purple or teal — so layered translucent glass stacks stay in one
   * colour family however many layers deep they go.
   */
  royal990: '#040814',
  royal950: '#070D21',
  royal900: '#0A1229',
  royal880: '#0E1836',
  royal850: '#122043',
  royal800: '#16224A',
  royal750: '#1B2C5C',
  royal700: '#22376F',
  royal650: '#294489',
  royal600: '#3153A6',
  royal500: '#3D6AC9',
  royal400: '#3D7BFF',
  royal300: '#7CA9FF',
  royal200: '#A8C6FF',
  royal100: '#CFDFFF',
  royal050: '#E9F0FF',

  // Aged gold — the brand accent.
  //
  // The values before these (`#FDE047 … #CA8A04`) were a lemon-yellow ramp, they were not
  // referenced by a single token or component, and yellow is not what "gold" means on a
  // serious tool: it reads as a highlighter pen. These are struck metal instead, and they
  // are now actually wired (see `accent` in both schemes).
  //
  // Why gold at all: the old accent `royal400` sits 220.8° on the hue wheel and the dark
  // canvas sits 226.2° — 5.3° apart. An accent that shares its hue with the surface behind
  // it cannot read as an accent, which is the whole reason the dark scheme looked flat.
  // Gold lands at ~46°, ~180° away, and clears AA on every surface in the app.
  //
  // ## Why this gold is muted, and why that is the load-bearing part
  //
  // A bright gold (`#D4AF37`, saturation 65%) sits 2.6° from `amber400`, which is `warn`.
  // Two chips side by side, one meaning "brand" and one meaning "a person must look at
  // this", would have been the same colour. On an evidence tool that is not a cosmetic
  // problem.
  //
  // The fix belongs on the gold side, not the amber side. Every orange `warn` could move
  // to lands 24-38° from `danger`, against the 43.3° of headroom it has today — confusing
  // caution with error is worse than confusing chrome with caution. So gold is separated
  // from amber by **saturation** instead, which is the escape hatch this file already
  // documents (see the `tones` contract above) and already relies on for `neutral` vs
  // `accent`. Gold is 42% saturated against amber's 96%: a 54-point gap, where the
  // neutral/accent precedent is 80.
  //
  // That the result is also quieter is the point — "subtle gold accents" was the brief,
  // and polished metal in a display case is not a highlighter.
  //
  // `tests/theme-contrast.test.ts` pins both the contrast ratios and that saturation gap,
  // so nobody can brighten this back up without a red test.
  //
  // The dark ramp is text-safe on the royal canvas (8.23:1 for `gold500`). The light ramp
  // is *not* the same colour darkened by eye — gold on white measures 2.34:1, so the light
  // scheme uses struck brass, which holds the hue at a luminance paper can carry.
  gold300: '#D4C491', // 8.89:1 worst-case on dark surfaces — accent *text* and the wordmark.
  gold500: '#BEA860', // 6.58:1 worst-case on dark surfaces — the accent proper.
  gold600: '#96844A', // 4.18:1 worst-case — pressed and hairline states (non-text, AA is 3).
  brass600: '#635B21', // 5.82:1 worst-case on paper — light-mode accent.
  brass700: '#4D461A', // 8.04:1 worst-case — light-mode accent text.
  brass800: '#3A3413', // 10.56:1 — light-mode pressed.
  brass050: '#F7F3E3', // Light-mode accent wash; carries `brass600` at 6.19:1.

  rose400: '#FF8A8A',
  rose500: '#EF4444',
  rose600: '#C22B2B',

  amber400: '#FBBF24',
  amber500: '#F59E0B',
  amber600: '#B45309',

  mint400: '#42DD94',
  mint500: '#10B981',
  mint600: '#047857',

  // Cyan, pulled a further ~4-8° off green than it used to be.
  //
  // The docblock at the top of this file promises no two semantic tones sit near each other
  // on the hue wheel, and `info` was quietly breaking it: at `#2FD4E0` / `#076B75` it landed
  // 26° from `ok` in dark and 24.5° in light. "Corroborated" and "for information" are
  // different answers about a piece of evidence, so a reader must not have to compare two
  // teals to tell them apart. These sit ~30° off `ok` and ~30° off `accent` in both schemes.
  sky400: '#43C7DB',
  sky500: '#0EA5E9',
  sky600: '#0B5A6E',

  orchid400: '#C4A6FF',
  orchid500: '#A855F7',
  orchid600: '#7C3AED',
} as const;

// ---------------------------------------------------------------------------
// Semantic colours
// ---------------------------------------------------------------------------

/**
 * A semantic role. Components never name a hue — they name an intent, and the theme
 * decides what that intent looks like on the current surface.
 */
export type Tone = 'neutral' | 'accent' | 'danger' | 'warn' | 'ok' | 'info' | 'ai';

export interface ToneColors {
  /** Text and icon colour, readable against `bg` and against the app canvas. */
  fg: string;
  /** A low-saturation fill for chips, callouts and icon tiles. */
  bg: string;
  /** A hairline that separates the fill from the canvas. */
  border: string;
  /** Saturated fill for a solid badge or a timeline node, with `onSolid` text over it. */
  solid: string;
}

/** A gradient, as the `colors` tuple `expo-linear-gradient` expects. */
export type GradientStops = readonly [string, string, ...string[]];

/**
 * The layered-translucency values `GlassSurface` composes.
 *
 * Grouped into their own object rather than scattered across `ColorScheme` because they
 * are only meaningful together: a sheen without its matching hairline reads as a
 * rendering bug, and the numbers were balanced as a set against each surface.
 *
 * All of these are deliberately *low* contrast. Real frosted glass modulates what is
 * behind it by a few percent; the moment a translucent panel is strong enough to be
 * noticed on its own it stops looking like a material and starts looking like a sticker.
 */
export interface GlassTokens {
  /**
   * The body wash, painted over the surface colour. Top-to-bottom, light to nothing —
   * this is the single cue that sells a panel as glass, because it reproduces the way a
   * sheet catches light along its upper edge.
   */
  sheen: GradientStops;
  /** A stronger wash for the one hero panel per screen. Same shape, more presence. */
  sheenStrong: GradientStops;
  /** The 1px top highlight: the lit edge of the sheet. The detail that reads as precision. */
  highlight: string;
  /** The hairline around the panel. Cool and low-alpha — a bright border reads as cheap. */
  border: string;
  /** An inner hairline just inside the border, giving the edge perceived thickness. */
  innerBorder: string;
  /** Fill for a glass panel that sits directly on the canvas rather than over content. */
  fill: string;
  /** A denser fill for panels that must stay readable over photographs or the graph. */
  fillStrong: string;
  /** Tint for `expo-blur`'s `BlurView` where it is used. */
  blurTint: 'light' | 'dark' | 'default';
  /** Blur intensity that matches the non-blurred fallback's density. */
  blurIntensity: number;
}

/**
 * Paper: the document's own voice.
 *
 * The app's second material, and the only one besides glass. It exists because of a problem
 * that no amount of retuning glass could solve: this is a tool for reading documents, and
 * every screen rendered the *app's* summary of a document in the same translucent navy panel
 * as the app's own navigation, its filters and its buttons. A reader had no way to tell, at a
 * glance, which words came off their evidence and which the software wrote.
 *
 * So the split is now material, not typographic:
 *
 *   - **glass** — the app speaking. Cool, navy, translucent, layered.
 *   - **paper** — the document speaking. Warm, opaque-looking, flat, quoted verbatim.
 *
 * That distinction is load-bearing in a way a font change is not. The mono/sans split already
 * marks individual *values* as machine-read (see `FONT_FAMILY`); paper marks whole *passages*
 * as somebody else's words, which is the claim that matters when a reader is deciding whether
 * to trust a figure in a demand letter.
 *
 * ## Why warmth, and why so little of it
 *
 * On a royal-navy canvas held at 223°, a light panel does not read as paper — it reads as a
 * white box, or worse as a rendering error. What reads as paper is *hue*: a wash pulled round
 * to roughly 45°, the colour of aged manila, at a luminance low enough to belong on a dark
 * screen. `theme-contrast.test.ts` pins that hue distance, because a paper token that drifted
 * back towards the canvas hue would quietly cost the app its second material while every
 * contrast assertion still passed.
 *
 * The wash itself is a few percent, for the same reason the glass sheen is: a strong tint
 * stops being a material and becomes a coloured box. The warmth of `text` does most of the
 * work, and it is nearly free.
 *
 * In the light scheme the logic inverts — the canvas is already paper-white — so the wash
 * goes *down* in luminance rather than up, towards a photocopy on a desk.
 */
export interface PaperTokens {
  /** The ground a quoted passage sits on, painted over whatever surface it lands on. */
  fill: string;
  /** Its edge. A sheet has one; this is what stops the wash reading as a stain. */
  border: string;
  /** The document's words. Warmer than `text`, on purpose and measurably. */
  text: string;
  /** The reading stamp beneath them — how these characters were obtained. */
  meta: string;
}

export interface ColorScheme {
  // Surfaces, from furthest back to furthest forward.
  canvas: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;
  /** Scrim behind sheets and modals. */
  overlay: string;

  border: string;
  borderStrong: string;

  text: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;
  textAccent: string;

  accent: string;
  accentPressed: string;
  /** Tinted accent surface, for selected rows and active nav items. */
  accentSurface: string;
  onAccent: string;

  /**
   * The primary button.
   */
  cta: string;
  ctaPressed: string;
  onCta: string;

  skeleton: string;
  skeletonHighlight: string;
  focusRing: string;

  /**
   * A barely-there wash for the top of a scroll view.
   *
   * The only gradient the product has. The three-stop brand gradient that used to live
   * beside it — blue into violet into rose — is gone: violet carries a specific meaning
   * here (AI-derived content, and nothing else), so a decorative sweep through it was
   * spending a semantic colour on ornament.
   */
  gradientWash: GradientStops;

  tones: Record<Tone, ToneColors>;

  /** Layered-translucency values. See `GlassTokens`. */
  glass: GlassTokens;

  /** The document's voice. See `PaperTokens`. */
  paper: PaperTokens;
}

export const lightColors: ColorScheme = {
  canvas: palette.paper100,
  surface: palette.white,
  surfaceRaised: palette.white,
  surfaceSunken: '#E7ECF7',
  overlay: 'rgba(7, 13, 33, 0.45)',

  border: '#DCE3F0',
  borderStrong: '#C4CFE4',

  text: '#0A1330',
  textSecondary: '#465577',
  // Raised from the old `#718096`, which measured 4.31:1 on the canvas and 3.98:1 on the
  // sunken surface — both below AA. Tertiary text carries timestamps and source lines, so
  // it is exactly the text a user squints at; it does not get to fail contrast.
  textTertiary: palette.paper600,
  textInverse: palette.white,
  textAccent: palette.brass700,

  // Brass, not the dark scheme's gold. Gold is a *light* colour — `gold500` measures 2.34:1
  // on white — so no amount of it will ever read as text on paper. The light scheme holds
  // the hue (53° against gold's 46°, close enough that the brand reads as one colour across
  // themes) and drops the luminance until it carries: 6.31:1 on the canvas, 6.89:1 on a card.
  //
  // It also lands 20° off `warn` here, on top of a 37-point saturation gap — light mode has
  // more hue room than dark because brass can go darker than amber ever will.
  accent: palette.brass600,
  accentPressed: palette.brass800,
  accentSurface: palette.brass050,
  onAccent: palette.white,

  cta: '#0C1734',
  ctaPressed: '#060D20',
  onCta: palette.white,

  skeleton: '#E3E9F5',
  skeletonHighlight: '#F2F5FC',
  focusRing: palette.brass600,

  gradientWash: ['rgba(36, 86, 201, 0.07)', 'rgba(36, 86, 201, 0)'],

  tones: {
    neutral: { fg: '#4A5877', bg: '#EDF1F9', border: '#D3DCEC', solid: '#64748B' },
    // Blue on purpose, like its dark counterpart — chips encode meaning and would collide
    // with `warn`. The rationale is written out in full in `darkColors.tones.accent`.
    accent: { fg: '#1D46A8', bg: '#E9F0FF', border: '#C6D8FB', solid: '#2456C9' },
    danger: { fg: '#B32424', bg: '#FDEDED', border: '#F7C9C9', solid: '#C22B2B' },
    warn: { fg: '#93540A', bg: '#FEF6E7', border: '#F7DFAE', solid: '#B45309' },
    ok: { fg: '#04724F', bg: '#E6F8F1', border: '#B2E6D2', solid: '#047857' },
    info: { fg: '#0F566B', bg: '#E6F4F9', border: '#A9D5E6', solid: '#116074' },
    ai: { fg: '#6D28D9', bg: '#F2ECFE', border: '#DCCEFA', solid: '#7C3AED' },
  },

  // On a light canvas the "glass" is the *paper* catching light, so the sheen is white and
  // the borders are a cool grey-blue. Pushing a dark-mode style translucency here would
  // grey the cards out and lose the crispness the light scheme depends on.
  glass: {
    sheen: ['rgba(255, 255, 255, 0.92)', 'rgba(255, 255, 255, 0.55)', 'rgba(240, 244, 252, 0.32)'],
    sheenStrong: [
      'rgba(255, 255, 255, 0.97)',
      'rgba(246, 249, 254, 0.78)',
      'rgba(233, 240, 255, 0.46)',
    ],
    highlight: 'rgba(255, 255, 255, 0.95)',
    border: 'rgba(36, 86, 201, 0.13)',
    innerBorder: 'rgba(255, 255, 255, 0.7)',
    fill: 'rgba(255, 255, 255, 0.72)',
    fillStrong: 'rgba(255, 255, 255, 0.9)',
    blurTint: 'light',
    blurIntensity: 40,
  },

  // On white, paper cannot separate by getting lighter, so it goes the other way: a manila
  // wash pulled down in luminance, which is what a photocopy on a desk actually looks like
  // beside a bright screen. The text is a warm near-black at 51 degrees against the body
  // text's cool 226 - far enough apart to feel like different ink on the same page.
  paper: {
    fill: 'rgba(150, 132, 74, 0.075)',
    border: 'rgba(150, 132, 74, 0.22)',
    text: '#332F1E',
    meta: '#645C40',
  },
};

export const darkColors: ColorScheme = {
  // Four distinct steps up the royal ramp. Separation here is what gives the dark scheme
  // depth without a single shadow — see the `royal` ramp's comment for the luminance maths.
  canvas: palette.royal950,
  surface: palette.royal880,
  surfaceRaised: palette.royal800,
  surfaceSunken: palette.royal990,
  overlay: 'rgba(4, 8, 20, 0.84)',

  // Borders carry elevation in dark mode, so they are tuned as light *sources* rather than
  // outlines: a low-alpha cool white, not a lighter navy. A saturated blue hairline at
  // full opacity is the single most recognisable tell of a cheap dark theme.
  border: 'rgba(150, 178, 232, 0.16)',
  borderStrong: 'rgba(160, 188, 240, 0.30)',

  text: '#EEF3FF',
  textSecondary: '#AFC0E0',
  textTertiary: '#8394B8',
  textInverse: palette.royal990,
  textAccent: palette.gold300,

  // Gold, not blue. See the `gold` ramp for the hue-separation measurement that forced this.
  //
  // Read the consumer list before changing it: `accent` is used for icon tints, focus and
  // selection borders, the pull-to-refresh spinner, the text cursor and quote rules. It is
  // *structure*, never a semantic state — which is what makes gold safe here and unsafe
  // fifteen lines below in `tones.accent`.
  accent: palette.gold500,
  accentPressed: palette.gold600,
  accentSurface: 'rgba(190, 168, 96, 0.16)',
  // Gold is a light colour: white on it measures 2.34:1. Anything filled with `accent` has
  // to put dark ink on top, so this is the canvas, not white.
  onAccent: palette.royal990,

  // Darkened from the old `#2563EB`: white on that measured 3.68:1, under AA for the app's
  // single most important button. `#2B5FD9` clears it while staying the same blue.
  cta: '#2B5FD9',
  ctaPressed: '#1E40AF',
  onCta: '#FFFFFF',

  skeleton: palette.royal850,
  skeletonHighlight: palette.royal750,
  focusRing: palette.gold300,

  gradientWash: ['rgba(61, 123, 255, 0.16)', 'rgba(61, 123, 255, 0)'],

  tones: {
    neutral: {
      fg: '#A3ADC2',
      bg: 'rgba(163, 173, 194, 0.10)',
      border: 'rgba(163, 173, 194, 0.20)',
      solid: '#5B6B8C',
    },
    // Deliberately still blue, while `colors.accent` above is gold. This is not an oversight
    // and it should not be "tidied up" into matching.
    //
    // `colors.accent` paints structure. `tones.accent` paints chips and tiles that sit in a
    // row beside `warn`, `ok` and `danger`, where the colour *is* the meaning. Gold sits at
    // 46° on the hue wheel and `warn` at 43.3° — 2.6° apart, and the saturation gap that
    // keeps them apart everywhere else (42% against 96%) is exactly what a small saturated
    // chip destroys. On a tool whose job is to show a reader where records disagree,
    // "primary" and "needs attention" cannot be the same colour.
    //
    // The second reason is mechanical: `Chip` renders solid variants with white text, and
    // white on gold is 2.34:1. A gold `solid` would be unreadable.
    accent: {
      fg: palette.royal300,
      bg: 'rgba(61, 123, 255, 0.15)',
      border: 'rgba(61, 123, 255, 0.32)',
      solid: '#2B5FD9',
    },
    danger: {
      fg: palette.rose400,
      bg: 'rgba(248, 113, 113, 0.14)',
      border: 'rgba(248, 113, 113, 0.30)',
      solid: palette.rose600,
    },
    warn: {
      fg: palette.amber400,
      bg: 'rgba(245, 158, 11, 0.14)',
      border: 'rgba(245, 158, 11, 0.30)',
      solid: palette.amber600,
    },
    ok: {
      fg: palette.mint400,
      bg: 'rgba(16, 185, 129, 0.14)',
      border: 'rgba(16, 185, 129, 0.30)',
      solid: palette.mint600,
    },
    // Teal rather than sky blue. At `#38BDF8` this sat 25° from `accent` at a similar
    // saturation, so "informational" and "actionable" were being told apart by a shade —
    // not acceptable when one of them means a person still has to act.
    info: {
      fg: palette.sky400,
      bg: 'rgba(67, 199, 219, 0.13)',
      border: 'rgba(67, 199, 219, 0.28)',
      solid: palette.sky600,
    },
    ai: {
      fg: palette.orchid400,
      bg: 'rgba(168, 120, 255, 0.14)',
      border: 'rgba(168, 120, 255, 0.30)',
      solid: palette.orchid600,
    },
  },

  glass: {
    // Cool white at 6–8%, not a lighter blue. Lightening with the surface hue makes a panel
    // look like a flat swatch; lightening with white makes it look lit from above.
    sheen: ['rgba(168, 198, 255, 0.075)', 'rgba(168, 198, 255, 0.022)', 'rgba(10, 18, 41, 0)'],
    sheenStrong: [
      'rgba(180, 208, 255, 0.13)',
      'rgba(168, 198, 255, 0.045)',
      'rgba(10, 18, 41, 0)',
    ],
    highlight: 'rgba(196, 218, 255, 0.34)',
    border: 'rgba(150, 178, 232, 0.17)',
    innerBorder: 'rgba(168, 198, 255, 0.07)',
    fill: 'rgba(22, 34, 74, 0.62)',
    fillStrong: 'rgba(18, 32, 67, 0.88)',
    blurTint: 'dark',
    blurIntensity: 34,
  },

  // Manila at 45 degrees, 178 degrees off the royal canvas - as far from it as the wheel
  // allows without landing on a tone. The wash is 5.5%, barely a tint; almost all of the
  // effect comes from `text`, which is warm bone against the app's cool `#EEF3FF`. Set the
  // two side by side and the second one looks like it was printed rather than rendered.
  paper: {
    fill: 'rgba(228, 214, 182, 0.055)',
    border: 'rgba(228, 214, 182, 0.15)',
    text: '#E2D8C2',
    meta: '#A89C81',
  },
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * 4pt base scale, and genuinely on the grid.
 *
 * ## Why this scale was re-cut
 *
 * The previous scale spent its range on values nothing needs and starved the middle, which
 * is the mechanical cause of the app reading as cramped and uniform. `sm` was *6* — off the
 * 8pt grid — and was the single most-used value in the codebase; `xs` 4, `sm` 6 and `md` 8
 * sat within two points of one another, so a designer asking for "a small gap" and "a
 * medium gap" got a difference nobody can see, while the jump from `md` 8 to `lg` 12 was
 * the only real step in the range every card uses.
 *
 * Five values crowded into 0–12 meant that in practice *everything* rendered between 4 and
 * 12 points, so no card had internal rhythm: the gap between a label and its value, between
 * two rows, and between two cards were all within a couple of points of each other. That
 * flatness, not any one too-small number, is what reads as cheap.
 *
 * The new scale is 4pt-based throughout (`xxs` 2 and `xs` 4 are the only sub-4 values, and
 * they exist for drawing — a dot inset, a hairline offset) and puts real distance between
 * the steps, so a layout gets *proportion* rather than contrast of a shade:
 *
 *     xs 4  →  sm 8  →  md 12  →  lg 16  →  xl 20  →  xxl 24  →  xxxl 32
 *
 * Two consequences worth stating, because they are the point rather than side effects:
 *
 *   - `lg` is the most common card padding in the app. It moves 12 → 16, which opens every
 *     card at once. This is the intended fix for the density measurement (157 uses at ≤12pt
 *     against 23 at ≥20pt): the padding was not wrong per card, the scale was too small.
 *   - `md` is the default gap of `Row` and `Stack`. It moves 8 → 12, so ordinary stacked
 *     content gains air without any call site changing.
 *
 * Only these tokens are read by components. Nothing outside this file hard-codes a spacing
 * number, which is what makes re-cutting the scale a one-file change rather than a sweep.
 */
export const SPACING = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  giant: 48,
  colossal: 64,
} as const;

/**
 * Corner radii. Generous by the standards of a data tool, because the softness is what
 * keeps a screen of dense findings from reading as a database console.
 */
export const RADIUS = {
  none: 0,
  xs: 6,
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  xxl: 32,
  pill: 999,
} as const;

export const BORDER_WIDTH = {
  none: 0,
  hairline: 1,
  thick: 2,
} as const;

/** Minimum touch target, per platform accessibility guidance. */
export const HIT_TARGET = 44;

export const LAYOUT = {
  /**
   * The gutter either side of screen content.
   *
   * Deliberately held at 20 while the rest of the scale opened up. The density fix this
   * release is about belongs *inside* the cards — a wider outer gutter would buy air by
   * taking it out of the content, and on a 360pt phone this product is rendering monospace
   * amounts, case references and long claim sentences that need the width more than the
   * margin does.
   */
  screenPadding: SPACING.xl,
  /** Keeps long prose readable on tablets instead of stretching to 1200px. */
  maxContentWidth: 720,
  /**
   * Excludes the safe-area inset, which the tab bar adds on top.
   *
   * This must equal the height `src/features/navigation/tab-bar.tsx` actually renders. It
   * was 62 against a bar that rendered 66, so every tab screen — each of which pads its
   * scroll content by this token — left its last 4pt of content underneath the bar. The
   * bar now reads this token instead of carrying its own literal, so the two cannot drift
   * apart again.
   */
  tabBarHeight: 66,
  headerHeight: 52,
  /** A single-line row in a dense list. */
  rowHeight: 56,
  /** The square pastel tile that leads most rows and cards. */
  tileSize: 40,
  tileSizeLarge: 48,
} as const;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export interface TypeStyle {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

/** Builds a type style. Weight lives in `fontFamily` because RN synthesises fake bold for custom fonts. */
const type = (
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
  letterSpacing = 0,
): TypeStyle => ({ fontFamily, fontSize, lineHeight, letterSpacing });

/**
 * The type scale.
 *
 * ## Why the sizes moved
 *
 * The variants were individually well-specified and collectively too quiet: 65% of all text
 * in the app rendered at 13.5pt or below, and the steps between adjacent variants were small
 * enough that a heading and the prose under it differed by about a point. When every rank is
 * within a couple of points of every other rank, type stops being hierarchy and becomes
 * texture — which is most of what "everything looks the same size" means.
 *
 * So the scale was re-cut with a real ratio at the top and a lifted floor at the bottom:
 *
 *     display 36 → title 28 → heading 22 → subheading 17.5 → body 15.5 → bodySmall 14
 *
 * The top four steps sit at roughly 1.27× each, which is a wide enough interval that a
 * reader ranks two levels without comparing them. Below `body` the steps deliberately
 * narrow to fractions of a point, because down there the distinction is carried by *weight
 * and tracking* rather than size — `label` is SemiBold at 13.5, `caption` is Medium at 12,
 * `overline` is Bold and tracked +0.9 at 11. Separating those by size as well would push
 * captions back under 11pt, which is where the old scale lost its legibility.
 *
 * Nothing here is large for effect. `display` at 36 is one string per screen, and it earns
 * the size by being the thing the screen is about.
 *
 * ## The mono ranks are paired, not independent
 *
 * `Text`'s `mono` prop swaps the *family* at a fixed size, so a value that turns out to have
 * been read from a document keeps the rhythm of the line it sits in. That only works while
 * each mono rank matches a sans rank exactly:
 *
 *     monoValue ↔ body · mono ↔ label · monoSmall ↔ caption · monoOverline ↔ overline
 *
 * Changing one side of a pair without the other reintroduces the baseline drift in every
 * card that mixes machine and human text, which is most cards in this product.
 */
export const TYPE = {
  /** Screen-level hero. Used sparingly — one per screen at most. */
  display: type(FONT_FAMILY.sansExtraBold, 36, 42, -1.2),
  title: type(FONT_FAMILY.sansBold, 28, 34, -0.8),
  heading: type(FONT_FAMILY.sansBold, 22, 29, -0.45),
  subheading: type(FONT_FAMILY.sansSemiBold, 17.5, 24, -0.2),

  /** Human-authored prose. The default body style. */
  body: type(FONT_FAMILY.sansRegular, 15.5, 23.5),
  bodyMedium: type(FONT_FAMILY.sansMedium, 15.5, 23.5),
  bodySmall: type(FONT_FAMILY.sansRegular, 14, 21),
  label: type(FONT_FAMILY.sansSemiBold, 13.5, 19, -0.05),
  caption: type(FONT_FAMILY.sansMedium, 12, 16.5, 0.05),

  /** Small, tracked-out, uppercase. Section headers and field names. */
  overline: type(FONT_FAMILY.sansBold, 11, 15, 0.9),

  /**
   * The large figure on a summary tile. Extra-bold and tight — at this size the weight
   * is what makes a count readable in a glance rather than a read.
   */
  statValue: type(FONT_FAMILY.sansExtraBold, 32, 36, -1.2),

  /**
   * Machine-read values. Every one of these is monospace — see `FONT_FAMILY` above
   * for why that is a product decision rather than a stylistic one.
   *
   * Sizes are pinned to their sans counterparts; see this block's docblock.
   */
  monoValue: type(FONT_FAMILY.monoMedium, 15.5, 23, -0.3),
  mono: type(FONT_FAMILY.monoRegular, 13.5, 20.5, -0.2),
  monoSmall: type(FONT_FAMILY.monoRegular, 12, 17.5, -0.1),
  monoOverline: type(FONT_FAMILY.monoSemiBold, 11, 15, 0.6),
} as const;

export type TypeToken = keyof typeof TYPE;

/**
 * How far each rank may grow when the reader has raised the system font size.
 *
 * ## Why there is a cap at all
 *
 * Font scaling is left *on* everywhere in this app — a user assembling evidence for a refund
 * or a deposit dispute is reading closely, often on a phone they have already turned up, and
 * text they cannot read is not a cosmetic failure. So the question is never whether to scale,
 * only how far, and the honest answer differs by rank.
 *
 * ## Why the caps are not uniform
 *
 * A single multiplier applied to the whole scale magnifies the ranks that need it least. The
 * reader who sets Android to 2× did so because `caption` at 12pt is unreadable to them; they
 * did not ask for `display` at 72pt, which is a masthead consuming half the screen and pushing
 * the content it labels below the fold. The caps below therefore *compress* the scale under
 * magnification rather than multiplying it:
 *
 *     1×    36 · 28 · 22 · 17.5 · 15.5 · 14 · 13.5 · 12 · 11     (range 3.27×)
 *     max   50 · 42 · 35 · 29.8 · 27.1 · 25 · 24.3 · 22.8 · 21   (range 2.41×)
 *
 * The small end nearly doubles, the large end grows by less than half, and the ordering
 * survives with real gaps between adjacent ranks at every step — which matters, because the
 * whole argument of the scale above is that hierarchy the reader cannot rank is texture. A
 * flat 2× would have put `subheading` and `body` within a point of each other at the top of
 * the range and undone that for exactly the users who are reading hardest.
 *
 * This mirrors what the platforms do with their own scales: iOS Dynamic Type grows its title
 * ranks proportionally less than its body ranks for the same reason.
 *
 * ## The mono ranks are pinned to their sans partners
 *
 * `TYPE`'s docblock pairs each mono rank with a sans rank at an identical size, so a value
 * that turns out to have been read from a document keeps the rhythm of the line it sits in.
 * A cap is part of that size. Capping `monoValue` differently from `body` would hold the pair
 * together at 1× and split it at 1.75×, reintroducing the baseline drift in every card that
 * mixes machine and human text — which is most cards in this product. `type-scaling.test.ts`
 * asserts each pair rather than trusting this paragraph.
 */
export const TYPE_SCALE_CAP = {
  display: 1.4,
  title: 1.5,
  heading: 1.6,
  subheading: 1.7,

  body: 1.75,
  bodyMedium: 1.75,
  bodySmall: 1.8,
  label: 1.8,
  caption: 1.9,

  overline: 1.9,

  // Paired with `display` rather than with its own 32pt size: a stat figure is a headline
  // made of digits, and it sits on a tile beside a `caption` that is scaling by 1.9.
  statValue: 1.4,

  // Pinned to body / label / caption / overline respectively. See the docblock.
  monoValue: 1.75,
  mono: 1.8,
  monoSmall: 1.9,
  monoOverline: 1.9,
} as const satisfies Record<TypeToken, number>;

/**
 * The cap for a label inside a compact control — a chip, a count badge, a segment, a button.
 *
 * These are the elements the per-rank caps above are wrong for, because their box is sized
 * from the label rather than from the page. A chip is a pill whose height was chosen so the
 * caption sits *in* it (see `Chip`); a segmented control is a row that has to stay a row. Let
 * their labels reach 1.9× and a status row stops fitting the screen width and a three-option
 * control becomes a column — the layout does not degrade, it stops being the control.
 *
 * 1.5 is a derived figure rather than a comfortable one. The binding control is the 26pt chip,
 * whose height was chosen so a `caption` sits *in* the pill rather than pressed against both
 * edges: a 16.5pt line box reaches 24.75pt at 1.5 and overflows the pill at 1.6. So 1.5 is the
 * largest tenth-step at which the boxes with no vertical padding to give — the 26pt chip, the
 * 40pt segment, the 44pt avatar — still hold their label at the geometry they were drawn with.
 * `type-scaling.test.ts` derives that from the real tokens, so a future re-cut of the type
 * scale or of a control's height fails the test instead of quietly clipping a label on a
 * stranger's phone.
 *
 * A button is the exception that explains the rule. Its padding is derived from its own line
 * box, so it grows to hold whatever it is handed and wants no height ceiling at all — it takes
 * this cap for the *other* axis. A button cannot widen past the screen it is on, and until the
 * label was allowed a second line the overflow went to an ellipsis: "Continue without an
 * account" rendered as "Continue without an acco…" on a 375pt phone at 100% scale. See
 * `Button.tsx`.
 *
 * It is also the scale the product is most often judged at: 150% is where a layout that was
 * never tested above 100% visibly breaks.
 */
export const CONTROL_SCALE_CAP = 1.5;

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * Durations are short on purpose. A tool that animates slowly feels like it is
 * thinking when it is not; the motion here exists to preserve continuity of place,
 * not to entertain.
 */
export const MOTION = {
  duration: {
    instant: 90,
    fast: 150,
    normal: 220,
    slow: 320,
    deliberate: 480,
  },
  /** Standard deceleration. Anything entering the screen uses this. */
  easeOut: [0.16, 1, 0.3, 1] as const,
  /** For elements leaving, and for anything the user just threw. */
  easeIn: [0.7, 0, 0.84, 0] as const,
  easeInOut: [0.65, 0, 0.35, 1] as const,
  spring: {
    /** For layout that settles. Slight overshoot reads as physical. */
    gentle: { damping: 20, stiffness: 180, mass: 0.9 },
    /** For things the user directly manipulated and released. */
    snappy: { damping: 26, stiffness: 320, mass: 0.7 },
    /** For the compose button and anything that should feel light. */
    bouncy: { damping: 14, stiffness: 260, mass: 0.8 },
  },
  /** Stagger between siblings appearing together, e.g. dashboard cards. */
  stagger: 45,

  /**
   * How far a `SlideUpIn` travels before settling, in points.
   *
   * Small on purpose. A long slide is a transition; a short one is the content *arriving*,
   * which is the only thing entrance motion should communicate in a tool like this.
   */
  enterDistance: 12,

  /**
   * Ambient loop durations, for motion that never stops.
   *
   * These are long — seconds, not milliseconds — because anything that repeats forever at
   * a noticeable rate becomes the most distracting thing on screen within a minute. A user
   * reads a case for half an hour; ambient motion has to survive that.
   */
  ambient: {
    /** One shimmer sweep across a skeleton block. */
    shimmer: 1450,
    /** Gap between sweeps, so the sweep reads as periodic rather than as a spinner. */
    shimmerGap: 420,
    /** One `PulseDot` breath, in and out. */
    pulse: 1600,
    /** The slowest tier: ambient drift. Deliberately near the edge of perception. */
    drift: 4200,
  },

  /**
   * Ceiling on a staggered entrance, in milliseconds.
   *
   * A 45ms stagger over a 40-row list would leave the last row arriving 1.8s after the
   * first, long after the user has started scrolling. `Stagger` clamps the accumulated
   * delay here, so a long list still cascades at the top and is simply *there* below.
   */
  staggerCap: 300,
} as const;

// ---------------------------------------------------------------------------
// Elevation
// ---------------------------------------------------------------------------

/**
 * Shadow presets, tinted royal rather than black.
 *
 * A neutral-black shadow under a white card on a cool canvas reads as dirt. Tinting the
 * shadow toward the canvas hue is what makes a card look like it is lifting off this
 * particular background rather than sitting on a generic one.
 *
 * ## Why these were strengthened
 *
 * `low` was `shadowOpacity: 0.05` at an 8pt radius. Against a `paper100` canvas that is
 * below the threshold where a shadow is visible at all — so a default `Surface` was, in
 * practice, a white box with a hairline round it and nothing else. The app had 52 borders
 * against 17 shadows, and the shadows it did have were invisible; "every card is a grey box
 * with a line round it" is the direct consequence.
 *
 * These now carry a card on their own, which is what lets `Surface` drop its border in the
 * light scheme (see `Surface`) and stop stating the same edge twice. They are still quiet —
 * 10% at 12pt is a soft contact shadow, not a drop shadow — because the lift is supposed to
 * read as the card being *on* the page, not floating above it.
 *
 * In dark mode shadows behave completely differently; see `ELEVATION_DARK`.
 */
export const ELEVATION = {
  none: {},
  low: {
    shadowColor: '#16224A',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  medium: {
    shadowColor: '#16224A',
    shadowOpacity: 0.13,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 5,
  },
  high: {
    shadowColor: '#16224A',
    shadowOpacity: 0.17,
    shadowRadius: 36,
    shadowOffset: { width: 0, height: 16 },
    elevation: 12,
  },
} as const;

export type ElevationToken = keyof typeof ELEVATION;

/**
 * The dark scheme's shadows.
 *
 * Same tokens, different physics. On a near-black canvas a soft grey shadow is invisible,
 * so these go the other way: almost pure black at a *higher* opacity and a tighter radius,
 * which darkens the few pixels immediately under a card and lets the panel's lit top edge
 * (see `GlassTokens.highlight`) do the real separating.
 *
 * ## Why `low` was raised
 *
 * `low` was 0.4 opacity at a 6pt radius with a 2pt offset, which on this canvas produced no
 * perceptible edge — a `Surface` at `elevation="low"` in dark mode did not read as raised in
 * any way, and since `low` is the default, that was every card in the app. The shadow was
 * being asked to darken a canvas that is already `#070D21`; at a 6pt radius the darkened
 * band was too narrow to see before it fell off.
 *
 * The fix is radius and offset rather than opacity alone: 14pt at a 4pt offset puts a
 * readable pool of shadow under the card, against which `surfaceRaised` (`#16224A`) reads as
 * a genuinely lifted plane. Opacity went 0.4 → 0.55 to carry that wider radius.
 *
 * Android's `elevation` is kept lower than the iOS shadow suggests on purpose — Android
 * draws its own grey ambient shadow from that number, and a high value on a dark surface
 * produces a visible grey halo rather than depth. These went up by one step each, not to
 * match the iOS values.
 */
export const ELEVATION_DARK = {
  none: {},
  low: {
    shadowColor: '#01040C',
    shadowOpacity: 0.55,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  medium: {
    shadowColor: '#01040C',
    shadowOpacity: 0.62,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  high: {
    shadowColor: '#01040C',
    shadowOpacity: 0.78,
    shadowRadius: 38,
    shadowOffset: { width: 0, height: 18 },
    elevation: 8,
  },
} as const satisfies Record<ElevationToken, object>;

/**
 * Picks the right shadow preset for a scheme.
 *
 * A free function rather than another field on `ColorScheme` because shadows are not
 * colours — they are style fragments, and `ColorScheme` is consumed by `Text`'s
 * `colorToken` prop as a map of colour names. Adding a non-colour key there would let
 * `colorToken="shadow"` typecheck.
 */
export function shadowFor(
  scheme: 'dark' | 'light',
  token: ElevationToken,
): (typeof ELEVATION)[ElevationToken] {
  return scheme === 'dark' ? ELEVATION_DARK[token] : ELEVATION[token];
}

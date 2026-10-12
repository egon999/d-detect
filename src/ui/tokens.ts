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

const palette = {

  royal990: '#040814',
  royal950: '#070D21',
  royal900: '#0A1530',
  royal880: '#0E1D44',
  royal850: '#112349',
  royal800: '#13285D',
  royal750: '#1A3270',
  royal700: '#22376F',
  royal650: '#294489',
  royal600: '#3153A6',
  royal500: '#3D6AC9',
  royal400: '#3D7BFF',
  royal300: '#7CA9FF',
  royal200: '#A8C6FF',
  royal100: '#CFDFFF',
  royal050: '#E9F0FF',

  gold300: '#D4C491', 
  gold500: '#BEA860', 
  gold600: '#96844A', 

  rose400: '#FF8A8A',
  rose500: '#EF4444',
  rose600: '#C22B2B',

  amber400: '#FACC33',
  amber500: '#F59E0B',
  amber600: '#9A6B0C',

  mint400: '#4ADB86',
  mint500: '#10B981',
  mint600: '#0A7A3A',

  sky400: '#40C0D2',
  sky500: '#0EA5E9',
  sky600: '#0B5A6E',

  orchid400: '#C4A6FF',
  orchid500: '#A855F7',
  orchid600: '#7C3AED',
} as const;

export type Tone = 'neutral' | 'accent' | 'danger' | 'warn' | 'ok' | 'info' | 'ai';

export interface ToneColors {

  fg: string;

  bg: string;

  border: string;

  solid: string;

  onSolid: string;
}

export type GradientStops = readonly [string, string, ...string[]];

export interface GlassTokens {

  sheen: GradientStops;

  sheenStrong: GradientStops;

  highlight: string;

  border: string;

  innerBorder: string;

  fill: string;

  fillStrong: string;

  chromeFill: string;

  blurTint: 'light' | 'dark' | 'default';

  blurIntensity: number;
}

export interface PaperTokens {

  fill: string;

  border: string;

  text: string;

  meta: string;
}

export interface ColorScheme {

  canvas: string;
  surface: string;
  surfaceRaised: string;
  surfaceSunken: string;

  overlay: string;

  border: string;
  borderStrong: string;

  borderSubtle: string;

  text: string;
  textSecondary: string;
  textTertiary: string;
  textInverse: string;
  textAccent: string;

  textDisabled: string;

  accent: string;
  accentPressed: string;

  accentSurface: string;
  onAccent: string;

  cta: string;
  ctaPressed: string;
  onCta: string;

  skeleton: string;
  skeletonHighlight: string;
  focusRing: string;

  disabledSurface: string;
  disabledBorder: string;

  accentHairline: string;

  track: string;

  pressOverlay: string;

  gradientWash: GradientStops;

  backdrop: {

    wash: GradientStops;

    pool: GradientStops;

    barFill: string;

    sparkle: string;
  };

  tones: Record<Tone, ToneColors>;

  glass: GlassTokens;

  paper: PaperTokens;
}

export const darkColors: ColorScheme = {

  canvas: palette.royal950,
  surface: palette.royal880,
  surfaceRaised: palette.royal800,
  surfaceSunken: palette.royal990,
  overlay: 'rgba(4, 8, 20, 0.84)',

  border: 'rgba(150, 178, 232, 0.16)',
  borderStrong: 'rgba(160, 188, 240, 0.30)',
  borderSubtle: 'rgba(150, 178, 232, 0.10)',

  text: '#EEF3FF',
  textSecondary: '#AFC0E0',
  textTertiary: '#8394B8',
  textDisabled: '#6B7A96',
  textInverse: palette.royal990,
  textAccent: palette.gold300,

  accent: palette.gold500,
  accentPressed: palette.gold600,
  accentSurface: 'rgba(190, 168, 96, 0.16)',

  onAccent: palette.royal990,

  cta: '#2B5FD9',
  ctaPressed: '#1E40AF',
  onCta: '#FFFFFF',

  skeleton: palette.royal850,
  skeletonHighlight: palette.royal750,
  focusRing: palette.gold300,

  disabledSurface: '#111C3A',
  disabledBorder: 'rgba(150, 178, 232, 0.08)',

  accentHairline: 'rgba(190, 168, 96, 0.45)',

  track: 'rgba(150, 178, 232, 0.20)',

  pressOverlay: 'rgba(168, 198, 255, 0.09)',

  gradientWash: ['rgba(61, 123, 255, 0.16)', 'rgba(61, 123, 255, 0)'],

  backdrop: {
    wash: ['rgba(63, 104, 199, 0.20)', 'rgba(41, 68, 137, 0.07)', 'rgba(7, 13, 33, 0)'],
    pool: ['rgba(61, 123, 255, 0.13)', 'rgba(61, 123, 255, 0)'],

    barFill: '#121F42',

    sparkle: 'rgba(190, 168, 96, 0.55)',
  },

  tones: {
    neutral: {
      fg: '#A3ADC2',
      bg: 'rgba(163, 173, 194, 0.10)',
      border: 'rgba(163, 173, 194, 0.20)',
      solid: '#5B6B8C',
      onSolid: '#FFFFFF',
    },

    accent: {
      fg: palette.royal300,
      bg: 'rgba(61, 123, 255, 0.15)',
      border: 'rgba(61, 123, 255, 0.32)',
      solid: '#2B5FD9',
      onSolid: '#FFFFFF',
    },
    danger: {
      fg: palette.rose400,
      bg: 'rgba(248, 113, 113, 0.14)',
      border: 'rgba(248, 113, 113, 0.30)',
      solid: palette.rose600,
      onSolid: '#FFFFFF',
    },

    warn: {
      fg: palette.amber400,
      bg: 'rgba(240, 160, 20, 0.16)',
      border: 'rgba(240, 160, 20, 0.34)',
      solid: palette.amber600,
      onSolid: '#FFFFFF',
    },
    ok: {
      fg: palette.mint400,
      bg: 'rgba(74, 219, 134, 0.14)',
      border: 'rgba(74, 219, 134, 0.30)',
      solid: palette.mint600,
      onSolid: '#FFFFFF',
    },

    info: {
      fg: palette.sky400,
      bg: 'rgba(64, 192, 210, 0.14)',
      border: 'rgba(64, 192, 210, 0.30)',
      solid: palette.sky600,
      onSolid: '#FFFFFF',
    },
    ai: {
      fg: palette.orchid400,
      bg: 'rgba(168, 120, 255, 0.14)',
      border: 'rgba(168, 120, 255, 0.30)',
      solid: palette.orchid600,
      onSolid: '#FFFFFF',
    },
  },

  glass: {

    sheen: ['rgba(168, 198, 255, 0.075)', 'rgba(168, 198, 255, 0.022)', 'rgba(168, 198, 255, 0)'],
    sheenStrong: [
      'rgba(180, 208, 255, 0.13)',
      'rgba(168, 198, 255, 0.045)',
      'rgba(168, 198, 255, 0)',
    ],
    highlight: 'rgba(196, 218, 255, 0.34)',
    border: 'rgba(150, 178, 232, 0.17)',
    innerBorder: 'rgba(168, 198, 255, 0.07)',

    fill: 'rgba(19, 40, 93, 0.62)',
    fillStrong: 'rgba(17, 35, 73, 0.88)',
    chromeFill: 'rgba(14, 30, 72, 0.64)',
    blurTint: 'dark',
    blurIntensity: 34,
  },

  paper: {
    fill: 'rgba(228, 214, 182, 0.055)',
    border: 'rgba(228, 214, 182, 0.15)',
    text: '#E2D8C2',
    meta: '#A89C81',
  },
};

export const lightColors: ColorScheme = {
  canvas: '#F4F7FC',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#E9EEF6',
  overlay: 'rgba(8, 17, 38, 0.50)',

  border: 'rgba(8, 17, 38, 0.08)',
  borderStrong: 'rgba(8, 17, 38, 0.18)',
  borderSubtle: 'rgba(8, 17, 38, 0.04)',

  text: '#081126',
  textSecondary: '#4A5568',
  textTertiary: '#596780',
  textDisabled: '#A0AEC0',
  textInverse: '#FFFFFF',
  textAccent: '#92600E',

  accent: '#92600E',
  accentPressed: '#78350F',
  accentSurface: 'rgba(146, 96, 14, 0.10)',
  onAccent: '#FFFFFF',

  cta: '#2563EB',
  ctaPressed: '#1D4ED8',
  onCta: '#FFFFFF',

  skeleton: '#E2E8F0',
  skeletonHighlight: '#F1F5F9',
  focusRing: '#2563EB',

  disabledSurface: '#EDF2F7',
  disabledBorder: 'rgba(8, 17, 38, 0.06)',

  accentHairline: 'rgba(146, 96, 14, 0.35)',

  track: 'rgba(8, 17, 38, 0.08)',
  pressOverlay: 'rgba(8, 17, 38, 0.04)',

  gradientWash: ['rgba(37, 99, 235, 0.06)', 'rgba(37, 99, 235, 0)'],

  backdrop: {
    wash: ['rgba(219, 234, 254, 0.40)', 'rgba(239, 246, 255, 0.20)', 'rgba(244, 247, 252, 0)'],
    pool: ['rgba(37, 99, 235, 0.06)', 'rgba(37, 99, 235, 0)'],
    barFill: '#F4F7FC',
    sparkle: 'rgba(146, 96, 14, 0.30)',
  },

  tones: {
    neutral: {
      fg: '#4A5568',
      bg: 'rgba(74, 85, 104, 0.08)',
      border: 'rgba(74, 85, 104, 0.18)',
      solid: '#4A5568',
      onSolid: '#FFFFFF',
    },
    accent: {
      fg: '#1D4ED8',
      bg: 'rgba(37, 99, 235, 0.08)',
      border: 'rgba(37, 99, 235, 0.20)',
      solid: '#2563EB',
      onSolid: '#FFFFFF',
    },
    danger: {
      fg: '#DC2626',
      bg: 'rgba(220, 38, 38, 0.08)',
      border: 'rgba(220, 38, 38, 0.22)',
      solid: '#DC2626',
      onSolid: '#FFFFFF',
    },
    warn: {
      fg: '#B45309',
      bg: 'rgba(180, 83, 9, 0.09)',
      border: 'rgba(180, 83, 9, 0.24)',
      solid: '#D97706',
      onSolid: '#FFFFFF',
    },
    ok: {
      fg: '#15803D',
      bg: 'rgba(21, 128, 61, 0.09)',
      border: 'rgba(21, 128, 61, 0.22)',
      solid: '#16A34A',
      onSolid: '#FFFFFF',
    },
    info: {
      fg: '#0284C7',
      bg: 'rgba(2, 132, 199, 0.08)',
      border: 'rgba(2, 132, 199, 0.20)',
      solid: '#0284C7',
      onSolid: '#FFFFFF',
    },
    ai: {
      fg: '#7C3AED',
      bg: 'rgba(124, 58, 237, 0.08)',
      border: 'rgba(124, 58, 237, 0.22)',
      solid: '#7C3AED',
      onSolid: '#FFFFFF',
    },
  },

  glass: {
    sheen: ['rgba(255, 255, 255, 0.85)', 'rgba(255, 255, 255, 0.40)', 'rgba(255, 255, 255, 0)'],
    sheenStrong: ['rgba(255, 255, 255, 0.95)', 'rgba(255, 255, 255, 0.60)', 'rgba(255, 255, 255, 0)'],
    highlight: 'rgba(255, 255, 255, 0.90)',
    border: 'rgba(8, 17, 38, 0.08)',
    innerBorder: 'rgba(255, 255, 255, 0.60)',
    fill: 'rgba(255, 255, 255, 0.85)',
    fillStrong: 'rgba(255, 255, 255, 0.95)',
    chromeFill: 'rgba(255, 255, 255, 0.90)',
    blurTint: 'light',
    blurIntensity: 24,
  },

  paper: {
    fill: 'rgba(247, 244, 234, 0.70)',
    border: 'rgba(210, 195, 170, 0.60)',
    text: '#2C2518',
    meta: '#6E614A',
  },
};

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

export const HIT_TARGET = 44;

export const LAYOUT = {

  screenPadding: SPACING.xl,

  maxContentWidth: 720,

  tabBarHeight: 66,
  headerHeight: 52,

  rowHeight: 56,

  tileSize: 40,
  tileSizeLarge: 48,
} as const;

export interface TypeStyle {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
}

const type = (
  fontFamily: string,
  fontSize: number,
  lineHeight: number,
  letterSpacing = 0,
): TypeStyle => ({ fontFamily, fontSize, lineHeight, letterSpacing });

export const TYPE = {

  display: type(FONT_FAMILY.sansExtraBold, 36, 40, -1.2),

  title: type(FONT_FAMILY.sansBold, 28, 34, -0.9),

  titleSmall: type(FONT_FAMILY.sansBold, 24, 30, -0.6),

  heading: type(FONT_FAMILY.sansBold, 22, 28, -0.4),

  subheading: type(FONT_FAMILY.sansSemiBold, 18, 24, -0.15),

  bodyLarge: type(FONT_FAMILY.sansRegular, 18, 27, -0.1),

  body: type(FONT_FAMILY.sansRegular, 16, 24),
  bodyMedium: type(FONT_FAMILY.sansMedium, 16, 24),
  bodySmall: type(FONT_FAMILY.sansRegular, 14, 21),

  label: type(FONT_FAMILY.sansSemiBold, 13, 18, -0.05),
  caption: type(FONT_FAMILY.sansMedium, 12, 17, 0.05),

  overline: type(FONT_FAMILY.sansBold, 11, 15, 0.9),

  statValue: type(FONT_FAMILY.sansExtraBold, 32, 36, -1.2),

  monoValue: type(FONT_FAMILY.monoMedium, 16, 24, -0.3),
  mono: type(FONT_FAMILY.monoRegular, 13, 18, -0.2),
  monoSmall: type(FONT_FAMILY.monoRegular, 12, 17, -0.1),
  monoOverline: type(FONT_FAMILY.monoSemiBold, 11, 15, 0.6),
} as const;

export type TypeToken = keyof typeof TYPE;

export const TYPE_SCALE_CAP = {
  display: 1.4,
  title: 1.5,
  titleSmall: 1.5,
  heading: 1.55,
  subheading: 1.7,

  bodyLarge: 1.6,

  body: 1.75,
  bodyMedium: 1.75,

  bodySmall: 1.8,
  label: 1.8,
  caption: 1.8,
  overline: 1.8,

  statValue: 1.4,

  monoValue: 1.75,
  mono: 1.8,
  monoSmall: 1.8,
  monoOverline: 1.8,
} as const satisfies Record<TypeToken, number>;

export const CONTROL_SCALE_CAP = 1.5;

export const TABULAR: { fontVariant: ['tabular-nums'] } = { fontVariant: ['tabular-nums'] };

export const MONO_ADVANCE_RATIO = 0.6;

export const SANS_FIGURE_ADVANCE: Record<string, number> = {
  '₹': 0.687,
  $: 0.647,
  '€': 0.777,
  '¥': 0.672,
  '0': 0.732,
  '1': 0.413,
  '2': 0.6,
  '3': 0.612,
  '4': 0.662,
  '5': 0.616,
  '6': 0.604,
  '7': 0.564,
  '8': 0.633,
  '9': 0.604,
  ',': 0.386,
  '.': 0.408,

  '-': 0.634,

  ' ': 0.18,

  A: 0.732,
  B: 0.693,
  C: 0.781,
  D: 0.742,
  E: 0.612,
  F: 0.587,
  G: 0.821,
  H: 0.736,
  I: 0.287,
  J: 0.396,
  K: 0.687,
  L: 0.547,
  M: 0.912,
  N: 0.742,
  O: 0.878,
  P: 0.649,
  Q: 0.878,
  R: 0.667,
  S: 0.647,
  T: 0.552,
  U: 0.724,
  V: 0.712,
  W: 1.032,
  X: 0.682,
  Y: 0.672,
  Z: 0.584,
};

const SANS_FIGURE_ADVANCE_FALLBACK = 1.032;

export function sansFigureAdvance(character: string): number {
  return SANS_FIGURE_ADVANCE[character] ?? SANS_FIGURE_ADVANCE_FALLBACK;
}

export function isMonoRank(fontFamily: string): boolean {
  return fontFamily.includes('Mono');
}

export function measureFigure(text: string, fontFamily: string, fontSize: number): number {
  if (isMonoRank(fontFamily)) return text.length * MONO_ADVANCE_RATIO * fontSize;
  let ems = 0;
  for (const character of text) ems += sansFigureAdvance(character);
  return ems * fontSize;
}

export const FOCUS_RING = {

  width: BORDER_WIDTH.thick,

  offset: -3,

  radiusBleed: 3,
} as const;

export function radiusForHeight(height: number): number {
  if (height <= 24) return RADIUS.xs;
  if (height <= 40) return RADIUS.sm;
  if (height <= 64) return RADIUS.md;
  if (height <= 120) return RADIUS.lg;
  return RADIUS.xl;
}

export function nestedRadius(outer: number, inset: number): number {
  if (outer >= RADIUS.pill) return RADIUS.pill;
  return Math.max(0, outer - inset);
}

export const DENSITY = {
  comfortable: {

    padding: SPACING.lg,

    gap: SPACING.md,

    rowHeight: LAYOUT.rowHeight,
  },
  compact: {
    padding: SPACING.md,
    gap: SPACING.sm,
    rowHeight: 48,
  },
} as const;

export type Density = keyof typeof DENSITY;

export const MOTION = {
  duration: {
    instant: 90,
    fast: 150,
    normal: 220,
    slow: 320,
    deliberate: 480,
  },

  easeOut: [0.16, 1, 0.3, 1] as const,

  easeIn: [0.7, 0, 0.84, 0] as const,
  easeInOut: [0.65, 0, 0.35, 1] as const,

  spring: {
    snappy: { damping: 26, stiffness: 320, mass: 0.7 },
  },

  stagger: 45,

  enterDistance: 12,

  ambient: {

    shimmer: 1450,

    shimmerGap: 420,

    pulse: 1600,
  },

  staggerCap: 300,
} as const;

export const ELEVATION = {
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
} as const;

export type ElevationToken = keyof typeof ELEVATION;

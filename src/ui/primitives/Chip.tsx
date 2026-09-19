/**
 * Status and badge primitives.
 *
 * These render domain state, so they take a *tone* rather than a colour — see
 * `semantics.ts` for the mapping from an enum member to a tone. A component that accepts
 * a colour directly invites a call site to invent one, and a status colour that means
 * different things on different screens has stopped being information.
 *
 * ## Why chip labels are sans, not mono
 *
 * The app's typographic rule is that monospace means "this string came off a document".
 * A chip reading `Active` or `High` is not that: it is a state the app assigned, in the
 * app's own vocabulary. Setting it in mono would claim a provenance it does not have and
 * would blunt the signal everywhere it *is* true. Values that genuinely came out of a
 * document go through `ProvenanceValue`.
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from '../icon';
import { BORDER_WIDTH, CONTROL_SCALE_CAP, SPACING, type Tone } from '../tokens';
import { useTheme } from '../theme';
import { Text } from './Text';

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

export interface ChipProps {
  label: string;
  tone?: Tone;
  /** Leading glyph. Omit for pure text chips, which is the denser option in a list. */
  icon?: IconName;
  size?: 'sm' | 'md';
  /**
   * `soft` is the default: a pastel fill with no border, which is what makes a row of
   * chips read as a palette of states rather than a row of tiny buttons. `outline` is
   * for chips over an already-tinted surface, where a fill would muddy. `solid` is the
   * saturated version, for the one chip that must win a crowded card.
   */
  emphasis?: 'soft' | 'outline' | 'solid' | 'filled';
  /** A leading tone dot instead of an icon. Cheaper visually in a dense list. */
  dot?: boolean;
  /** Ellipsise rather than wrap when the container is narrow. */
  shrink?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A small status pill.
 *
 * Uses `alignSelf: 'flex-start'` so a chip inside a column never stretches to the full
 * width — a stretched pill reads as a button, which is the single most common way a
 * status chip gets mistaken for something tappable.
 */
export function Chip({
  label,
  tone = 'neutral',
  icon,
  size = 'sm',
  emphasis = 'soft',
  dot = false,
  shrink = false,
  style,
}: ChipProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);

  const compact = size === 'sm';
  // Sized from the caption's line box rather than picked. `caption` is 12/16.5, so a 24pt
  // pill leaves under 4pt of padding above and below the label — the chip reads as text
  // pressed against two edges. 26/32 gives the label room to sit in the pill.
  const height = compact ? 26 : 32;
  const paddingHorizontal = compact ? SPACING.md : SPACING.lg;

  const solid = emphasis === 'solid';
  // `filled` is kept as an alias for `soft` so older call sites keep working.
  const soft = emphasis === 'soft' || emphasis === 'filled';

  const background = solid ? palette.solid : soft ? palette.bg : 'transparent';
  const foreground = solid ? '#FFFFFF' : palette.fg;

  return (
    <View
      style={[
        styles.chip,
        {
          // `minHeight`, not `height`. `allowFontScaling` is left on throughout this app, so a
          // user at a large accessibility size gets a taller label inside a pill that was told
          // exactly how tall to be — and the label clips. Growing is the correct failure.
          minHeight: height,
          paddingHorizontal,
          borderRadius: theme.radius.pill,
          backgroundColor: background,
          borderWidth: soft || solid ? 0 : BORDER_WIDTH.hairline,
          borderColor: palette.border,
          alignSelf: 'flex-start',
          maxWidth: shrink ? '100%' : undefined,
        },
        style,
      ]}
    >
      {dot ? (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: solid ? '#FFFFFF' : palette.solid,
          }}
        />
      ) : icon ? (
        <Icon name={icon} size={compact ? 12 : 14} color={foreground} />
      ) : null}

      <Text
        variant="caption"
        style={[{ color: foreground }, shrink ? styles.shrinkText : null]}
        numberOfLines={1}
        // A chip is bounded by its pill, not by the page, so it takes the control ceiling
        // rather than `caption`'s own 1.9. At 1.5 the label still sits inside the 26pt pill
        // it was drawn for, and a row of status chips stays a row instead of wrapping into a
        // column of pills taller than the card that holds them.
        maxFontSizeMultiplier={CONTROL_SCALE_CAP}
        // The chip is a single readable unit; screen readers should say "High severity"
        // rather than spelling out an icon and a label separately.
        accessibilityLabel={label}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * A chip whose value is transient. Shows a spinner in place of the icon, because a state
 * like PROCESSING is ongoing and a static glyph would imply it had settled.
 */
export function ProgressChip({ label, tone = 'info' }: { label: string; tone?: Tone }) {
  const theme = useTheme();
  const palette = theme.tone(tone);
  return (
    <View
      style={[
        styles.chip,
        {
          // `minHeight` for the same reason `Chip` above uses one: this pill was told exactly
          // how tall to be, and the label inside it is the one thing on the row whose size the
          // user controls.
          minHeight: 26,
          paddingHorizontal: SPACING.md,
          borderRadius: theme.radius.pill,
          backgroundColor: palette.bg,
          alignSelf: 'flex-start',
        },
      ]}
    >
      <ActivityIndicator size="small" color={palette.fg} style={styles.spinner} />
      <Text variant="caption" style={{ color: palette.fg }} maxFontSizeMultiplier={CONTROL_SCALE_CAP}>
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Counter badge
// ---------------------------------------------------------------------------

export interface CountBadgeProps {
  count: number;
  tone?: Tone;
  /** Rendered instead of the number when `count` exceeds it, e.g. "9+". */
  max?: number;
  /** Saturated fill with white text, for an unread count on a tab or a bell. */
  solid?: boolean;
}

/** A tab-bar / section-header count. */
export function CountBadge({ count, tone = 'neutral', max = 99, solid = false }: CountBadgeProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);
  const label = count > max ? `${max}+` : String(count);
  return (
    <View
      style={[
        styles.countBadge,
        {
          backgroundColor: solid ? palette.solid : palette.bg,
          borderRadius: theme.radius.pill,
        },
      ]}
    >
      <Text
        variant="caption"
        style={{ color: solid ? '#FFFFFF' : palette.fg }}
        // Capped and not disabled. `minWidth`/`minHeight` let the badge grow around the
        // figure, so the number a user raised their font size to read stays readable — an
        // unread count they cannot make out is the one thing this component is for.
        maxFontSizeMultiplier={CONTROL_SCALE_CAP}
      >
        {label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Severity / state dot
// ---------------------------------------------------------------------------

/**
 * A small dot carrying a tone. Used in dense lists where a full chip would dominate the
 * row, and as the leading marker on a timeline entry.
 */
export function ToneDot({ tone, size = 8 }: { tone: Tone; size?: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.tone(tone).solid,
      }}
    />
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexShrink: 0,
  },
  shrinkText: { flexShrink: 1 },
  spinner: { transform: [{ scale: 0.7 }], width: 12, height: 12 },
  countBadge: {
    minWidth: 24,
    // `minHeight`, not `height`: the badge is a circle drawn around a figure, and at a raised
    // font scale the figure is what decides how big that circle has to be. A fixed 22 clipped
    // the digits it exists to show.
    minHeight: 22,
    paddingHorizontal: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/**
 * Buttons.
 *
 * Four variants, and the restraint is deliberate: a screen that offers a primary, a
 * secondary and a tertiary action has already made its hierarchy legible, and adding a
 * fifth style would only dilute it.
 *
 *   - `primary`   one per screen — the action the screen exists for. Deep navy, filled.
 *   - `secondary` white with a hairline border, for a real but subordinate action
 *   - `ghost`     text only, for actions inside dense rows
 *   - `danger`    destructive; always confirmed by the caller before it runs
 *
 * There was a fifth, `gradient`, painted in the brand gradient and reserved for the single
 * most consequential action in a flow. It is gone. A gradient fill is decoration that
 * carries no information a filled primary does not already carry, and a product whose job
 * is to be believed about evidence cannot afford ornament that competes with its content.
 *
 * `loading` is a first-class state rather than something a caller fakes by disabling the
 * button and swapping the label. A button that has been tapped and is working must look
 * different from one that is merely unavailable, or users tap it again.
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from '../icon';
import { BORDER_WIDTH, CONTROL_SCALE_CAP, HIT_TARGET, SPACING, type Tone } from '../tokens';
import { useTheme } from '../theme';
import { Pressable } from './Layout';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Places the icon after the label — correct for "next" / "open" style actions. */
  iconTrailing?: boolean;
  loading?: boolean;
  disabled?: boolean;
  /** Stretch to fill the parent's width. */
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

interface VariantSkin {
  background: string;
  border: string;
  label: string;
  icon: string;
}

/**
 * Per-size geometry.
 *
 * Heights went up with the type scale and the spacing re-cut: a 46pt button carrying a
 * 17.5pt label has under 11pt of breathing room above and below the text, which reads as
 * cramped rather than as a control. The padding steps are now the scale's real 16/20/24,
 * which is the same geometry as before the re-cut — they only *look* larger because `xl`
 * and `xxl` moved up a step with `sm` and `md`.
 *
 * `paddingVertical` is derived from `height` rather than chosen beside it: `md` is 12 because
 * `subheading`'s 24pt line box with 12 above and below is exactly the 48 this button was drawn
 * at, and `lg` is 16 for the same reason at 56. `sm` lands half a point short of 40 and
 * `minHeight` rounds it back. Deriving it is what makes the box grow *correctly* — a second
 * line, or a line magnified by the OS font scale, keeps the air the designer drew instead of
 * pressing the text against the pill's edge, which is all a fixed height could offer.
 */
const DIMENSIONS = {
  sm: {
    height: 40,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    icon: 16,
  },
  md: {
    height: 48,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    gap: SPACING.sm,
    icon: 18,
  },
  lg: {
    height: 56,
    paddingHorizontal: SPACING.xxl,
    paddingVertical: SPACING.lg,
    gap: SPACING.md,
    icon: 20,
  },
};

export function Button({
  label,
  onPress,
  variant = 'secondary',
  size = 'md',
  icon,
  iconTrailing = false,
  loading = false,
  disabled = false,
  fullWidth = false,
  style,
  accessibilityHint,
}: ButtonProps) {
  const theme = useTheme();

  const skin = skinFor(variant, theme);
  const inert = disabled || loading;
  const dimensions = DIMENSIONS[size];
  // `sm` is the one size that does not take the full subheading step — at 40pt tall a
  // 17.5pt label leaves too little room, so the small button steps to `bodyMedium` and
  // `md`/`lg` carry the subheading.
  const textVariant = size === 'sm' ? 'bodyMedium' : 'subheading';

  // Pill on the taller sizes, softly rounded on the small one — a 36pt pill next to a
  // 36pt rounded-rect input looks like it belongs to a different screen.
  const borderRadius = size === 'sm' ? theme.radius.sm : theme.radius.pill;

  const content = (
    <>
      {loading ? (
        <ActivityIndicator size="small" color={skin.label} />
      ) : icon && !iconTrailing ? (
        <Icon name={icon} size={dimensions.icon} color={skin.icon} />
      ) : null}

      <Text
        variant={textVariant}
        style={[styles.label, { color: skin.label }]}
        // Two lines, not one. At 375pt — the most common phone width — a `fullWidth` md button
        // leaves its label 227pt, and "Continue without an account" wants 238 at the *default*
        // font size, so the sign-in screen's own escape hatch rendered as "Continue without an
        // acco…" for everybody. Truncation is the worst of the failures available here: it is
        // silent, it takes the end of the sentence rather than the middle, and the user taps
        // the button anyway. With `minHeight` and derived padding below, a second line costs a
        // taller button and nothing else.
        numberOfLines={2}
        // Width is the one axis a button cannot grow in, which is what this ceiling is for
        // rather than the height. Two lines at 1.5 holds every label this product ships even
        // on a 320pt screen; `subheading`'s own 1.7 does not. A label that defeats both is a
        // copy problem, and it now surfaces as an ellipsis on the second line rather than the
        // first.
        maxFontSizeMultiplier={CONTROL_SCALE_CAP}
      >
        {label}
      </Text>

      {icon && iconTrailing && !loading ? (
        <Icon name={icon} size={dimensions.icon} color={skin.icon} />
      ) : null}
    </>
  );

  const inner = {
    // `minHeight`, not `height`: `allowFontScaling` is on across the app, and a fixed 40/48/56
    // box clips its own label the moment the OS font scale goes up. A button that grows is
    // ugly on one screen; a button whose label is cut in half is unusable.
    //
    // The padding is what actually defines the box now — at rest it reproduces these heights
    // exactly (see `DIMENSIONS`), so `minHeight` is a floor rather than the mechanism.
    minHeight: dimensions.height,
    paddingHorizontal: dimensions.paddingHorizontal,
    paddingVertical: dimensions.paddingVertical,
    gap: dimensions.gap,
    borderRadius,
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      haptic={!inert && (variant === 'danger' || variant === 'primary')}
      pressScale={0.975}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={[
        { borderRadius, alignSelf: fullWidth ? 'stretch' : 'flex-start' },
        fullWidth ? styles.fullWidth : null,
        // The lift belongs to the filled variant only. A shadow under an outlined
        // button makes it compete with the primary action it is supposed to sit below.
        //
        // The shadow keeps the elevation token's own near-black colour. Tinting it `cta` gave
        // the primary action a saturated blue glow under a blue fill inside a blue border —
        // three statements of one colour, and the exact halo `Field.tsx:15-17` argues against
        // for focus rings. A lift should say "this is above the page", not "this is blue".
        variant === 'primary' ? theme.elevation.medium : null,
        style,
      ]}
    >
      <View
        style={[
          styles.button,
          inner,
          {
            backgroundColor: skin.background,
            borderWidth: variant === 'ghost' ? 0 : BORDER_WIDTH.hairline,
            borderColor: skin.border,
          },
        ]}
      >
        {content}
      </View>
    </Pressable>
  );
}

function skinFor(variant: ButtonVariant, theme: ReturnType<typeof useTheme>): VariantSkin {
  switch (variant) {
    case 'primary':
      return {
        background: theme.colors.cta,
        border: theme.colors.cta,
        label: theme.colors.onCta,
        icon: theme.colors.onCta,
      };
    case 'danger': {
      const tone = theme.tone('danger');
      return { background: tone.bg, border: tone.border, label: tone.fg, icon: tone.fg };
    }
    case 'ghost':
      return {
        background: 'transparent',
        border: 'transparent',
        label: theme.colors.textAccent,
        icon: theme.colors.textAccent,
      };
    case 'secondary':
    default:
      return {
        background: theme.colors.surfaceRaised,
        border: theme.colors.border,
        label: theme.colors.text,
        icon: theme.colors.textSecondary,
      };
  }
}

// ---------------------------------------------------------------------------
// Icon button
// ---------------------------------------------------------------------------

export interface IconButtonProps {
  icon: IconName;
  onPress: () => void;
  /** Required — an icon-only control has no visible text for a screen reader. */
  accessibilityLabel: string;
  tone?: Tone;
  size?: number;
  /** Draws a tinted circle behind the glyph. For header actions over a busy background. */
  filled?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A round, icon-only control for headers and list rows.
 *
 * `accessibilityLabel` is required rather than optional. An icon-only button without one
 * is invisible to a screen reader, and making it optional would mean it gets forgotten.
 */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  tone = 'neutral',
  size = 20,
  filled = false,
  disabled = false,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      pressScale={0.9}
      style={[styles.iconButton, { borderRadius: theme.radius.pill }, style]}
    >
      <View
        style={[
          styles.iconButtonInner,
          filled
            ? {
                backgroundColor: tone === 'neutral' ? theme.colors.surface : palette.bg,
                borderWidth: BORDER_WIDTH.hairline,
                borderColor: tone === 'neutral' ? theme.colors.border : palette.border,
              }
            : null,
        ]}
      >
        <Icon name={icon} size={size} color={palette.fg} disabled={disabled} />
      </View>
    </Pressable>
  );
}

/**
 * A segmented control for switching between a small set of views, e.g. List / Timeline /
 * Graph on the case screen. Kept here beside Button because the two are the same
 * decision made at different granularities.
 */
export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string; icon?: IconName }>;
  value: T;
  onChange: (next: T) => void;
  /** Stretch segments evenly. On by default; off for a compact, left-aligned control. */
  fill?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  fill = true,
}: SegmentedControlProps<T>) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.segmented,
        {
          backgroundColor: theme.colors.surfaceSunken,
          borderRadius: theme.radius.pill,
        },
      ]}
      accessibilityRole="tablist"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            pressScale={1}
            haptic
            noFeedback
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={option.label}
            style={[
              styles.segment,
              fill ? styles.segmentFill : null,
              {
                borderRadius: theme.radius.pill,
                backgroundColor: selected ? theme.colors.surface : 'transparent',
              },
              selected ? theme.elevation.low : null,
            ]}
          >
            {option.icon ? (
              <Icon
                name={option.icon}
                size={15}
                color={selected ? theme.colors.textAccent : theme.colors.textTertiary}
              />
            ) : null}
            <Text
              variant="label"
              style={{ color: selected ? theme.colors.text : theme.colors.textTertiary }}
              numberOfLines={1}
              // A segmented control has to stay a row of segments. Three labels at `label`'s
              // own 1.8 ceiling do not fit one line on a phone, and the control degrades into
              // three stacked pills that no longer read as a choice between alternatives.
              maxFontSizeMultiplier={CONTROL_SCALE_CAP}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
    overflow: 'hidden',
  },
  fullWidth: { alignSelf: 'stretch' },
  // `textAlign` matters only once the label wraps. A single line is shrink-to-fit inside a
  // row that already centres it, so this is invisible at rest; on two lines it is the
  // difference between a centred button and one with a ragged right edge.
  label: { flexShrink: 1, textAlign: 'center' },
  iconButton: {
    width: HIT_TARGET,
    height: HIT_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
  },
  iconButtonInner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmented: { flexDirection: 'row', padding: SPACING.xs, gap: SPACING.xs },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    // `minHeight`, like the button above. A segment carries a label and no vertical padding,
    // so a fixed 40 is the label's own box with nothing to spare.
    minHeight: 40,
    paddingHorizontal: SPACING.lg,
  },
  segmentFill: { flex: 1 },
});

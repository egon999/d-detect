/**
 * Layout and surface primitives.
 *
 * `Pressable` here is not a thin wrapper around React Native's — it is the app's single
 * definition of what "touching something" looks and feels like. Every tappable element in
 * the product goes through it, so press feedback is identical on every screen: the same
 * scale curve, the same haptic, the same disabled treatment. Building that once is also
 * why the app feels coherent rather than assembled.
 *
 * Press animation uses React Native's own `Animated` rather than Reanimated. The scale is
 * driven from the JS responder callbacks, which is the right trade here: Reanimated would
 * need these callbacks to be worklets, and the scheduling benefit is invisible at the
 * 60–150ms durations involved.
 */

import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable as RNPressable,
  StyleSheet,
  View,
  type PressableProps as RNPressableProps,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';

import { Icon, type IconName } from '../icon';
import { childLayoutStyleKeys, pressableLayoutWarning } from './pressable-style';
import {
  BORDER_WIDTH,
  HIT_TARGET,
  LAYOUT,
  SPACING,
  type ElevationToken,
  type GradientStops,
  type Tone,
} from '../tokens';
import { useTheme } from '../theme';
import { useReducedMotion } from './Motion';
import { GlassSurface } from './GlassSurface';

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

export interface SurfaceProps extends ViewProps {
  /** Which layer of the stack this surface sits on. */
  variant?: 'surface' | 'raised' | 'sunken' | 'accent';
  elevation?: ElevationToken;
  /**
   * Draw the hairline border.
   *
   * Defaults per scheme rather than to a fixed value — see the component docblock. Pass it
   * explicitly to override: `bordered={false}` on a card inside another bordered container,
   * `bordered` on a card that needs a stated edge in both schemes.
   */
  bordered?: boolean;
  /** Corner radius token. */
  radius?: keyof ReturnType<typeof useTheme>['radius'];
  /** Uniform padding token applied to all sides. */
  padding?: keyof ReturnType<typeof useTheme>['spacing'];
  /**
   * Opt into the liquid-glass treatment — gradient sheen, lit top edge, layered hairlines.
   *
   * Off by default, and that default is a compatibility promise rather than a preference:
   * 59 call sites across the app render a `Surface` today and every one of them must keep
   * the exact card it has. Passing `glass` hands off to `GlassSurface`, which is the same
   * box model (radius, border, elevation, padding) with the decorative layers added, so a
   * screen can adopt it one card at a time.
   */
  glass?: boolean;
  /** Forwarded to `GlassSurface`. Ignored unless `glass` is set. */
  glassVariant?: 'panel' | 'hero';
  /** Forwarded to `GlassSurface`: let the canvas show through. Ignored unless `glass`. */
  translucent?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * The container most content sits in.
 *
 * ## One edge treatment, not two
 *
 * The default used to be shadow *and* border, unconditionally. Since the light `low` shadow
 * was 5% opacity at an 8pt radius — below the threshold where a shadow is visible — what
 * that actually produced was a border and an invisible shadow: a flat box with a hairline
 * round it, 55 times over. That is the largest single contributor to the app reading as
 * cheap, because a bordered rectangle is what a layout looks like before anyone has decided
 * how it should sit on the page.
 *
 * A surface is now lifted **or** outlined, and which one depends on the scheme, because the
 * two schemes genuinely separate their planes by different means:
 *
 *   - **Light** — the shadow leads and there is no border. `ELEVATION.low` is now a real
 *     contact shadow (10% at 12pt), and a white card lifting off the cool canvas is the
 *     whole reason the canvas is tinted rather than white. A hairline on top of that states
 *     the same edge a second time and flattens it.
 *   - **Dark** — the hairline leads and the shadow supports it. `surface` (`#0E1836`) sits
 *     only ~1.08:1 from `canvas` (`#070D21`), so on a dim OLED panel the fill alone does not
 *     locate the card edge; the border is load-bearing there in a way it is not on paper.
 *     Dark keeps both, and that is not a contradiction of the rule above — the shadow is
 *     doing depth, the hairline is doing the edge.
 *
 * Two cases override the scheme default, because in both the border is the only thing left
 * to state the edge:
 *
 *   - `variant="sunken"` takes no shadow at all (a shadow under a recessed panel contradicts
 *     the name), so it is always bordered.
 *   - `elevation="none"` has nothing to separate it, so it is always bordered.
 *
 * And `variant="accent"` is always bordered because there the border is *information* — it
 * is how a selected row says it is selected — rather than an edge treatment.
 *
 * Elevation in dark mode is carried by surface lightness as well as shadow, which is why
 * `variant` and `elevation` are separate props rather than one prop that means both things.
 * The shadow *values* are swapped per scheme by the theme, so `elevation="low"` means the
 * right thing in both.
 */
export function Surface({
  variant = 'surface',
  elevation = 'low',
  bordered,
  radius = 'lg',
  padding,
  glass = false,
  glassVariant = 'panel',
  translucent = false,
  style,
  children,
  ...rest
}: SurfaceProps) {
  const theme = useTheme();

  // The glass path deliberately ignores `variant`'s background: a glass panel derives its
  // fill from the glass tokens, and layering a `surfaceSunken` under a sheen would produce
  // a muddy panel that matches neither treatment.
  //
  // It also keeps `bordered` defaulting to true rather than resolving it per scheme: the
  // outer hairline is layer 5 of the glass stack (see `GlassSurface`), so dropping it in
  // light mode would dismantle the material rather than simplify the card.
  if (glass) {
    return (
      <GlassSurface
        variant={glassVariant}
        elevation={variant === 'sunken' ? 'none' : elevation}
        radius={radius}
        padding={padding}
        translucent={translucent}
        bordered={bordered ?? true}
        tone={variant === 'accent' ? 'accent' : undefined}
        style={style}
        {...rest}
      >
        {children}
      </GlassSurface>
    );
  }

  const backgroundColor =
    variant === 'raised'
      ? theme.colors.surfaceRaised
      : variant === 'sunken'
        ? theme.colors.surfaceSunken
        : variant === 'accent'
          ? theme.colors.accentSurface
          : theme.colors.surface;

  /**
   * Whether this surface casts a shadow.
   *
   * Never in dark, which is the scheme this product ships in. The dark palette is built as four
   * distinct fills — canvas, surface, surfaceRaised, surfaceSunken — and its own comment says
   * that ramp is what "gives the dark scheme depth without a single shadow". Drawing the shadow
   * anyway meant every card stated its edge three times over: a fill a full luminance step above
   * its parent, a hairline, and a shadow. Three statements of one boundary is the texture a
   * reviewer reads as cheap, and the shadow was the one contributing least — a near-black glow
   * against a near-black canvas is invisible, and on Android it costs a real offscreen pass per
   * card to draw nothing.
   *
   * Light keeps it, because there the fill steps are within a few percent of each other and the
   * shadow is the only thing separating a card from the page.
   */
  const casts = variant !== 'sunken' && elevation !== 'none' && theme.scheme === 'light';

  /**
   * Whether this surface draws a hairline.
   *
   * Dark leads with the hairline, because it is now the only edge treatment left and because a
   * surface cannot know its parent's fill: a `default` card nested in another `default` card has
   * no luminance step to rely on. Light leads with the shadow and falls back to the hairline
   * only when there is no shadow to lead with. `accent` always states its edge.
   */
  const showBorder =
    bordered ?? (theme.scheme === 'dark' || !casts || variant === 'accent');

  return (
    <View
      style={[
        {
          backgroundColor,
          borderRadius: theme.radius[radius],
          borderWidth: showBorder ? BORDER_WIDTH.hairline : 0,
          borderColor: variant === 'accent' ? theme.colors.tones.accent.border : theme.colors.border,
          padding: padding ? theme.spacing[padding] : undefined,
        },
        casts ? theme.elevation[elevation] : null,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Pressable
// ---------------------------------------------------------------------------

export interface PressableProps extends Omit<RNPressableProps, 'style' | 'children'> {
  /**
   * The touch target's own box: padding, background, border, radius, size.
   *
   * Not the children's arrangement. `flexDirection`, `gap` and their four siblings are read
   * against the children of the node they sit on, and this style is applied to the outer
   * touch target — whose only child is the press wrapper. Written here they lay out one item
   * and the children stack. Use `contentStyle`; a dev build warns and names the property.
   */
  style?: StyleProp<ViewStyle>;
  /**
   * The box that actually holds the children.
   *
   * Where a row goes: `contentStyle={{ flexDirection: 'row', gap: SPACING.md, alignItems: 'center' }}`
   * arranges the children, because this style lands on the node they are inside. Anything
   * describing the *target* — its padding, its background, its radius — belongs in `style`,
   * since only that node receives the ripple and defines the pressable area.
   */
  contentStyle?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  /**
   * How far the surface scales down on press. `0` disables the scale entirely — correct
   * for large rows where the movement would be distracting, and for anything that is
   * already animating.
   */
  pressScale?: number;
  /** Dim on press, for surfaces where scaling would look wrong (full-width rows). */
  dimOnPress?: boolean;
  /** Fires a light impact haptic on press-in. Off for anything incidental. */
  haptic?: boolean;
  /** Disabled state: blocks the press and reduces opacity. */
  disabled?: boolean;
  /** Removes the ripple/overlay on Android, for surfaces that supply their own feedback. */
  noFeedback?: boolean;
}

/**
 * The app's one tappable primitive.
 *
 * Two feedback styles, chosen by the shape of the target rather than by taste: small
 * targets scale (the movement reads as the surface responding to a finger), large
 * full-width rows dim (scaling a 400pt-wide row is a visible jump, not a response).
 *
 * Disabled is enforced by the component, not by each call site passing `disabled` to the
 * underlying pressable — a disabled control that still fires onPress is a bug that only
 * shows up in a demo.
 */
export function Pressable({
  style,
  contentStyle,
  children,
  pressScale = 0.975,
  dimOnPress = false,
  haptic = false,
  disabled = false,
  noFeedback = false,
  onPressIn,
  onPressOut,
  onPress,
  onLayout,
  ...rest
}: PressableProps) {
  const theme = useTheme();
  const reduced = useReducedMotion() === true;

  /**
   * Whether the press animates, and how.
   *
   * Reduced motion asks us to drop *movement*, not acknowledgement — a control that no longer
   * reacts to a finger is worse for the person who turned the setting on, not better. So the
   * scale is suppressed and the opacity fade takes over, which means every target still visibly
   * receives its press. This is the one animation in the file that had no guard at all, and it
   * is the one behind all 48 buttons, 43 chips and every tappable row in the app.
   */
  const scales = pressScale !== 1 && pressScale > 0 && !reduced;
  const dims = dimOnPress || (reduced && pressScale !== 1 && pressScale > 0);

  /**
   * Tells a developer when a `style` would arrange nothing.
   *
   * See `./pressable-style` for the failure and why a type cannot catch it. Dev-only, and an
   * effect rather than a render-time call so a warning is printed once per style change
   * instead of on every re-render of the 48 buttons and 43 chips this component is behind.
   */
  useEffect(() => {
    if (!__DEV__) return;
    const misplaced = childLayoutStyleKeys(style);
    if (misplaced.length > 0) console.warn(pressableLayoutWarning(misplaced));
  }, [style]);

  /**
   * How far short of the 44pt floor this target actually landed.
   *
   * The `minHeight` below is applied before the caller's `style`, so anything a call site passes
   * wins — including `minHeight: 0`, which appears four times in this directory, and a fixed
   * `height`, which is how the dismiss button used at 37 `Notice` sites ended up 32pt tall. The
   * floor was therefore advisory, and silently so.
   *
   * Raising the floor above the caller's style would fix the touch area by breaking the layout
   * every one of those call sites asked for. Measuring instead means the visual box stays
   * exactly as designed and only the *touch* area is topped up, which is what `hitSlop` is for.
   * The half-point tolerance stops sub-pixel layout jitter from bouncing between two states
   * forever.
   */
  const [shortBy, setShortBy] = useState(0);
  const handleLayout = useCallback<NonNullable<RNPressableProps['onLayout']>>(
    (event) => {
      const missing = Math.max(0, HIT_TARGET - event.nativeEvent.layout.height);
      setShortBy((current) => (Math.abs(current - missing) < 0.5 ? current : missing));
      onLayout?.(event);
    },
    [onLayout],
  );

  // `Animated.Value` is created once and mutated, never re-created — re-creating it per
  // render would restart the animation on every parent update.
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback<NonNullable<RNPressableProps['onPressIn']>>(
    (event) => {
      if (haptic) {
        // Fire-and-forget: a haptic that fails must never block the press.
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      if (scales) {
        Animated.timing(scale, {
          toValue: pressScale,
          duration: theme.motion.duration.instant,
          useNativeDriver: true,
        }).start();
      }
      if (dims) {
        Animated.timing(opacity, {
          toValue: 0.62,
          duration: theme.motion.duration.instant,
          useNativeDriver: true,
        }).start();
      }
      onPressIn?.(event);
    },
    [haptic, scales, dims, pressScale, scale, opacity, theme.motion.duration.instant, onPressIn],
  );

  const handlePressOut = useCallback<NonNullable<RNPressableProps['onPressOut']>>(
    (event) => {
      if (scales) {
        // Spring back rather than reverse the timing curve: releasing a finger should
        // feel like letting go, and the small overshoot is what sells that.
        Animated.spring(scale, {
          toValue: 1,
          damping: theme.motion.spring.snappy.damping,
          stiffness: theme.motion.spring.snappy.stiffness,
          mass: theme.motion.spring.snappy.mass,
          useNativeDriver: true,
        }).start();
      }
      if (dims) {
        Animated.timing(opacity, {
          toValue: 1,
          duration: theme.motion.duration.fast,
          useNativeDriver: true,
        }).start();
      }
      onPressOut?.(event);
    },
    [scales, dims, scale, opacity, theme.motion, onPressOut],
  );

  const handlePress = useCallback<NonNullable<RNPressableProps['onPress']>>(
    (event) => {
      if (disabled) return;
      onPress?.(event);
    },
    [disabled, onPress],
  );

  return (
    <RNPressable
      // 44pt is the platform minimum. Applying it here means no screen has to remember —
      // and `hitSlop` below covers the call sites whose own style overrides it.
      style={[{ minHeight: HIT_TARGET, justifyContent: 'center' }, style]}
      onLayout={handleLayout}
      hitSlop={shortBy > 0 ? { top: shortBy / 2, bottom: shortBy / 2 } : undefined}
      disabled={disabled}
      android_ripple={
        noFeedback || disabled
          ? undefined
          : { color: theme.colors.surfaceRaised, borderless: false }
      }
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      accessibilityState={{ disabled }}
      {...rest}
    >
      <Animated.View
        style={[
          { transform: [{ scale }], opacity: disabled ? 0.42 : opacity },
          // The animated wrapper must not clip: it is transparent and only exists to
          // carry the transform.
          styles.animatedWrapper,
          contentStyle,
        ]}
      >
        {children}
      </Animated.View>
    </RNPressable>
  );
}

const styles = StyleSheet.create({
  animatedWrapper: { flexGrow: 0 },
  tile: { alignItems: 'center', justifyContent: 'center' },
});

// ---------------------------------------------------------------------------
// Gradient
// ---------------------------------------------------------------------------

export interface GradientProps extends ViewProps {
  /**
   * Required. There is no default brand gradient to fall back on, and the absence is the
   * point: a caller has to name the stops it wants, which makes every gradient in the app
   * a decision someone took rather than one that arrived by omission.
   */
  colors: GradientStops;
  /** Diagonal by default — a horizontal sweep on a square reads as a flat two-tone. */
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  radius?: keyof ReturnType<typeof useTheme>['radius'];
  padding?: keyof ReturnType<typeof useTheme>['spacing'];
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * A linear gradient, as a container.
 *
 * Used once, for the ambient wash at the top of the search screen. It never sits behind
 * body text: a gradient shifts the contrast ratio across the width of a line, so text over
 * it is legible at one end and marginal at the other.
 *
 * It used to paint buttons, icon tiles and the wordmark in a blue-violet-rose sweep. That
 * is gone. Ornament competes with content in a product whose entire job is to be believed
 * about documents, and violet specifically means AI-derived here — spending it on
 * decoration would blunt the one place it carries information.
 */
export function Gradient({
  colors,
  start = { x: 0, y: 0 },
  end = { x: 1, y: 1 },
  radius,
  padding,
  style,
  children,
  ...rest
}: GradientProps) {
  const theme = useTheme();

  return (
    <LinearGradient
      colors={colors}
      start={start}
      end={end}
      style={[
        {
          borderRadius: radius ? theme.radius[radius] : undefined,
          padding: padding ? theme.spacing[padding] : undefined,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------
// Icon tile
// ---------------------------------------------------------------------------

export interface IconTileProps {
  icon: IconName;
  /** Picks the pastel fill and the glyph colour from the theme's tone table. */
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  style?: StyleProp<ViewStyle>;
}

const TILE_SIZES = {
  sm: { box: 30, glyph: 15, radius: 'sm' as const },
  md: { box: LAYOUT.tileSize, glyph: 19, radius: 'md' as const },
  lg: { box: LAYOUT.tileSizeLarge, glyph: 22, radius: 'md' as const },
};

/**
 * The rounded pastel square that leads most rows and cards.
 *
 * It is doing real work, not decoration: the tone is derived from what the row *is* — an
 * invoice, a conflict, a claim — so a user scanning a long list sorts by colour before
 * reading a single word. That only holds while the mapping is consistent, which is why
 * callers pass a `Tone` and never a colour. See `src/ui/semantics.ts` for the mapping.
 *
 * There is deliberately no gradient-filled variant. One tile painted differently from
 * every other tile would read as a category the tone table does not have, which is the
 * opposite of what this component is for.
 */
export function IconTile({ icon, tone = 'neutral', size = 'md', style }: IconTileProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);
  const dims = TILE_SIZES[size];

  return (
    <View
      style={[
        styles.tile,
        {
          width: dims.box,
          height: dims.box,
          borderRadius: theme.radius[dims.radius],
          backgroundColor: palette.bg,
        },
        style,
      ]}
    >
      <Icon name={icon} size={dims.glyph} color={palette.fg} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------

export interface DividerProps {
  /** Insets the rule, so it can align with text rather than the container edge. */
  inset?: keyof ReturnType<typeof useTheme>['spacing'];
  /** Vertical space above and below. */
  spacing?: keyof ReturnType<typeof useTheme>['spacing'];
  /** Draws the rule in the accent colour, for section breaks inside a card. */
  accent?: boolean;
}

export function Divider({ inset, spacing = 'none', accent = false }: DividerProps) {
  const theme = useTheme();
  return (
    <View
      style={{
        height: BORDER_WIDTH.hairline,
        backgroundColor: accent ? theme.colors.accent : theme.colors.border,
        marginLeft: inset ? theme.spacing[inset] : 0,
        marginRight: inset ? theme.spacing[inset] : 0,
        marginTop: spacing ? theme.spacing[spacing] : 0,
        marginBottom: spacing ? theme.spacing[spacing] : 0,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Row / Stack
// ---------------------------------------------------------------------------

export interface RowProps extends ViewProps {
  gap?: keyof ReturnType<typeof useTheme>['spacing'];
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  /** Let children wrap onto multiple lines. */
  wrap?: boolean;
  /** Push children apart, overriding `justify`. */
  between?: boolean;
  children?: React.ReactNode;
}

/** Horizontal flex container. Defaults to centred, which is right far more often than not. */
export function Row({
  gap = 'md',
  align = 'center',
  justify,
  wrap = false,
  between = false,
  style,
  children,
  ...rest
}: RowProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: align,
          justifyContent: between ? 'space-between' : justify,
          gap: theme.spacing[gap],
          flexWrap: wrap ? 'wrap' : 'nowrap',
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

export interface StackProps extends ViewProps {
  gap?: keyof ReturnType<typeof useTheme>['spacing'];
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];
  /** Stretch this stack to fill its parent. */
  flex?: boolean;
  children?: React.ReactNode;
}

/** Vertical flex container. */
export function Stack({
  gap = 'md',
  align,
  justify,
  flex = false,
  style,
  children,
  ...rest
}: StackProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'column',
          alignItems: align,
          justifyContent: justify,
          gap: theme.spacing[gap],
          flex: flex ? 1 : undefined,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

/**
 * A flexible spacer for pushing siblings apart in a `Row`. Prefer `Row between` where it
 * fits; this is for the three-child case where only one gap should stretch.
 */
export function Spacer({ size }: { size?: keyof ReturnType<typeof useTheme>['spacing'] }) {
  const theme = useTheme();
  return <View style={{ flex: size ? 0 : 1, width: size ? theme.spacing[size] : undefined }} />;
}

export { SPACING };

/**
 * Liquid glass.
 *
 * The app's signature surface: a panel that reads as a sheet of tinted glass laid over the
 * canvas rather than a rectangle filled with a slightly different colour. It is the single
 * component most responsible for the product looking like an instrument instead of a form.
 *
 * ## How the effect is actually built
 *
 * Glass is not one colour, it is a stack, and each layer is doing one job:
 *
 *   1. **Base fill** — the surface colour, opaque or translucent depending on `translucent`.
 *   2. **Sheen** — a top-to-bottom gradient wash at 2–8% alpha. This is the layer that sells
 *      the material, because it reproduces how a real sheet is brightest along the edge that
 *      faces the light and falls off across its height.
 *   3. **Top highlight** — a 1px lit line inset just inside the top corners. The smallest
 *      layer and the one that carries the most weight: a bare rounded rectangle looks
 *      printed on, and this one line is what makes it look like it has a lit edge.
 *   4. **Inner border** — a hairline just inside the outer border, giving the edge apparent
 *      thickness so the panel reads as a slab with depth rather than an outline.
 *   5. **Outer border** — the hairline that separates panel from canvas.
 *
 * All five are static views. Nothing here animates or re-renders, so a screen can hold
 * twenty of these in a list without any per-frame cost.
 *
 * ## Why not `expo-blur` by default
 *
 * `expo-blur` *is* installed, and `blurred` opts into it. It is off by default for three
 * reasons specific to this app. Real blur on Android needs the content behind it wrapped in
 * a `BlurTargetView` whose ref is threaded into every `BlurView` — a structural requirement
 * on screens this component does not own. Below Android SDK 31 it falls back to RenderScript,
 * which the Expo docs describe as much less efficient, and this app targets mid-range
 * Android. And most importantly: this product renders monospace figures — amounts, dates,
 * invoice numbers — and a blurred panel over a column of digits makes a digit ambiguous,
 * which in an evidence tool is a correctness problem, not an aesthetic one. The layered
 * gradient below gives the same *material* impression with none of that.
 *
 * Note for `blurred` callers: per the Expo SDK 55 docs, `borderRadius` is not honoured on
 * a `BlurView` on either platform, so the radius is applied by a clipping wrapper here.
 */

import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { BORDER_WIDTH, type ElevationToken } from '../tokens';
import { useTheme } from '../theme';

export interface GlassSurfaceProps extends ViewProps {
  children?: React.ReactNode;
  /**
   * `panel` (default) is the standard card. `hero` uses the stronger sheen and a brighter
   * top highlight — for the one summary panel at the top of a screen, and deliberately not
   * for anything repeated in a list, where the extra lift stops meaning anything.
   */
  variant?: 'panel' | 'hero';
  /** Shadow token. Resolves to the dark-tuned table automatically in dark mode. */
  elevation?: ElevationToken;
  /** Corner radius token. Defaults to `lg`, matching `Surface`. */
  radius?: keyof ReturnType<typeof useTheme>['radius'];
  /** Uniform padding token applied to all sides. */
  padding?: keyof ReturnType<typeof useTheme>['spacing'];
  /**
   * Let the canvas show through the base fill. Correct when the panel sits over the
   * ambient gradient; wrong over a scrolling list, where moving content
   * behind text hurts legibility.
   */
  translucent?: boolean;
  /**
   * Use a real `expo-blur` backdrop. Read the note in this file's header before enabling:
   * it needs `BlurTargetView` wiring on Android and must never sit over monospace figures.
   */
  blurred?: boolean;
  /** Tint the sheen and borders with a tone, e.g. `danger` for a conflict panel. */
  tone?: keyof ReturnType<typeof useTheme>['colors']['tones'];
  /** Drop the outer hairline, for a panel that is already inside a bordered container. */
  bordered?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Style for the inner content wrapper, which sits above every decorative layer. */
  contentStyle?: StyleProp<ViewStyle>;
}

export function GlassSurface({
  children,
  variant = 'panel',
  elevation = 'low',
  radius = 'lg',
  padding,
  translucent = false,
  blurred = false,
  tone,
  bordered = true,
  style,
  contentStyle,
  ...rest
}: GlassSurfaceProps) {
  const theme = useTheme();
  const { glass } = theme.colors;
  const borderRadius = theme.radius[radius];
  const tonePalette = tone ? theme.tone(tone) : null;

  const sheen = variant === 'hero' ? glass.sheenStrong : glass.sheen;

  // A toned panel keeps the glass structure and swaps only the border for the tone's, so a
  // danger panel is unmistakably a danger panel while still reading as the same material.
  const outerBorder = tonePalette ? tonePalette.border : glass.border;

  const baseFill = translucent
    ? variant === 'hero'
      ? glass.fillStrong
      : glass.fill
    : theme.colors.surface;

  return (
    <View
      style={[
        {
          borderRadius,
          backgroundColor: blurred ? 'transparent' : baseFill,
          borderWidth: bordered ? BORDER_WIDTH.hairline : 0,
          borderColor: outerBorder,
          // Clips every decorative layer to the rounded shape. Also the documented
          // workaround for `BlurView` ignoring `borderRadius`.
          overflow: 'hidden',
        },
        theme.elevation[elevation],
        style,
      ]}
      {...rest}
    >
      {blurred ? (
        <BlurView
          intensity={glass.blurIntensity}
          tint={glass.blurTint}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : null}

      {/* Layer 2: the sheen. Vertical, because the light in this UI comes from above. */}
      <LinearGradient
        colors={sheen}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {/* Layer 2b: a tone wash, only when toned. Sits over the sheen so the tint survives. */}
      {tonePalette ? (
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: tonePalette.bg }]}
          pointerEvents="none"
        />
      ) : null}

      {/* Layer 4: the inner hairline, inset by one point to read as edge thickness. */}
      <View
        style={[
          StyleSheet.absoluteFill,
          styles.innerBorder,
          { borderRadius: Math.max(0, borderRadius - 1), borderColor: glass.innerBorder },
        ]}
        pointerEvents="none"
      />

      {/*
        Layer 3: the lit top edge. Inset horizontally by the corner radius so the line stops
        where the curve begins — running it corner to corner would draw a bright chord across
        two rounded corners, which is the exact detail that makes a fake-glass card look fake.
      */}
      <View
        style={[
          styles.highlight,
          {
            left: borderRadius * 0.5,
            right: borderRadius * 0.5,
            backgroundColor: glass.highlight,
            opacity: variant === 'hero' ? 1 : 0.66,
          },
        ]}
        pointerEvents="none"
      />

      <View style={[padding ? { padding: theme.spacing[padding] } : null, contentStyle]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  innerBorder: { borderWidth: BORDER_WIDTH.hairline, margin: 1 },
  highlight: {
    position: 'absolute',
    top: 0,
    /**
     * One point, not one physical pixel.
     *
     * This was `StyleSheet.hairlineWidth`, which is `1 / PixelRatio.get()` — 0.33pt on the 3×
     * screens this app targets. That is the right value for a *border*, where the goal is the
     * thinnest line the panel can draw. It is the wrong value here: the header calls this the
     * layer that "carries the most weight", and at a third of a point behind a 0.34 alpha it is
     * a line you have to be told is there. `1` is what "a 1px lit line" means — one logical
     * point, three physical pixels at 3×, which is a lit edge a reader actually perceives.
     */
    height: 1,
  },
});

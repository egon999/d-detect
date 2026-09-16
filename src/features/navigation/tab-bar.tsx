/**
 * The tab bar.
 *
 * Built by hand rather than configured, because the shape is load-bearing: five slots
 * where the middle one is not a tab at all but the app's compose action, raised above
 * the bar on the brand gradient. Getting that out of the stock bar means fighting it.
 *
 * ## What the middle button is, and is not
 *
 * It is not a route. Tapping it opens the "add evidence" flow for the case you are in,
 * or the "new case" flow when you are not in one. That makes it the only control in the
 * app whose destination depends on context — which is defensible here because the answer
 * is always "add the next thing", and the label under it says so.
 *
 * A raised button that navigated somewhere fixed would be worse: it would occupy the
 * most valuable position on the screen to do something a tab already does.
 *
 * ## The indicator
 *
 * The active tab is marked three ways at once: the glyph swaps to its filled variant, a
 * pill of accent surface appears behind it, and the label goes bold and accent-coloured.
 * Redundant by design — colour alone would fail for a colour-blind user.
 *
 * The pill is not animated and does not travel between slots. It is a fixed-size box
 * rendered inside whichever slot is active, so it cannot drift out of alignment when the
 * label text changes width or the safe-area inset changes on rotation — there is no
 * measured offset to go stale. Sliding it would mean adding Reanimated, whose Babel plugin
 * this project does not configure.
 */

import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';
import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@ui';
import { BORDER_WIDTH, FONT_FAMILY, LAYOUT, SPACING, Text, useTheme } from '@ui';

/** Routes in tab order. The compose button is spliced into the middle at render time. */
const TABS: ReadonlyArray<{
  name: string;
  label: string;
  icon: IconName;
  iconActive: IconName;
}> = [
  { name: 'index', label: 'Home', icon: 'home-outline', iconActive: 'home-variant' },
  { name: 'cases', label: 'Cases', icon: 'folder-outline', iconActive: 'folder' },
  { name: 'insights', label: 'Analysis', icon: 'text-box-search-outline', iconActive: 'text-box-search' },
  { name: 'profile', label: 'Profile', icon: 'account-outline', iconActive: 'account' },
];

export interface TabBarProps extends BottomTabBarProps {
  onCompose: () => void;
}

/**
 * How far the compose disc rises above the bar's top edge.
 *
 * Read by both the style that lifts it and the inset hook below, so the two cannot drift. A
 * literal in one place and a different literal in the other is how the overlap came back last
 * time.
 */
const COMPOSE_OVERHANG = 22;

/** The gap the bar floats above the bottom of the screen, on a device with and without an inset. */
function floatHeight(safeAreaBottom: number): number {
  return safeAreaBottom > 0 ? safeAreaBottom * 0.5 : SPACING.sm;
}

/**
 * The space a tab screen must leave free at the bottom of its scroll content.
 *
 * ## Why this is a hook here and not a token each screen adds up
 *
 * `LAYOUT.tabBarHeight` is only the middle of three parts. The bar floats: the wrapper adds
 * `floatHeight(insets.bottom)` *outside* the height box, and the compose disc is lifted
 * `COMPOSE_OVERHANG` above the box's top edge. So the real occluded height is the sum of all
 * three, and no screen was computing it — each of the four invented its own arithmetic from the
 * one token it could see. Two of them under-reserved and put their last row under the bar, which
 * is the regression the comment below this says was fixed once already; the other two padded by
 * `insets.bottom + giant` and left a dead band of empty canvas taller than a card.
 *
 * Returning it from a hook in this file means the number is derived where the geometry is
 * declared: change the float, the height or the overhang and every tab screen follows. The extra
 * `SPACING.xl` is breathing room, not clearance — content that stops exactly at the bar's edge
 * looks clipped even when it is fully visible.
 */
export function useTabBarInset(): number {
  const insets = useSafeAreaInsets();
  return floatHeight(insets.bottom) + LAYOUT.tabBarHeight + COMPOSE_OVERHANG + SPACING.xl;
}

export function TabBar({ state, navigation, onCompose }: TabBarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const activeRoute = state.routes[state.index]?.name;

  const go = useCallback(
    (name: string) => {
      if (name === activeRoute) return;
      void Haptics.selectionAsync().catch(() => {});
      navigation.navigate(name);
    },
    [navigation, activeRoute],
  );

  const compose = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onCompose();
  }, [onCompose]);

  const left = TABS.slice(0, 2);
  const right = TABS.slice(2);

  return (
    <View
      style={[
        styles.floatingWrapper,
        {
          paddingBottom: floatHeight(insets.bottom),
        },
      ]}
    >
      <View
        style={[
          styles.container,
          {
            height: LAYOUT.tabBarHeight,
            borderRadius: LAYOUT.tabBarHeight / 2,
            backgroundColor: theme.colors.surface,
            borderColor: theme.colors.border,
          },
          /*
            The theme's own elevation, for both platforms.

            This used to force `shadowColor: '#1E3A8A'` on iOS — a saturated royal blue at
            11.6× the luminance of the surface it fell on, which is not a shadow, it is a
            blue glow with no light source making it. The token carries the right value per
            scheme (navy-tinted on paper, near-black on the dark canvas) and the right
            Android `elevation` with it, so there is nothing left to override.
          */
          theme.elevation.high,
        ]}
      >
        {left.map((tab) => (
          <TabSlot key={tab.name} tab={tab} active={activeRoute === tab.name} onPress={() => go(tab.name)} />
        ))}

        <View style={styles.composeSlot}>
          <Pressable
            onPress={compose}
            accessibilityRole="button"
            accessibilityLabel="Create a case or add evidence"
            accessibilityHint="Opens the available case and evidence actions"
            style={({ pressed }) => [styles.composePress, { transform: [{ scale: pressed ? 0.9 : 1 }] }]}
          >
            {/*
              Flat, in the CTA blue, with a plain drop shadow.

              This was a gradient disc carrying a 40%-opacity blue glow at a 12pt radius —
              a light source with no object making it, sitting on top of every screen in the
              app. It is the most-seen control here, so it is also the one most worth
              settling down. White on `cta` measures 5.61:1.
            */}
            <View
              style={[
                styles.compose,
                {
                  backgroundColor: theme.colors.cta,
                  shadowColor: '#000000',
                  shadowOpacity: 0.18,
                  shadowRadius: 6,
                  shadowOffset: { width: 0, height: 2 },
                  elevation: 4,
                },
              ]}
            >
              <Icon name="plus" size={28} color={theme.colors.onCta} />
            </View>
          </Pressable>
        </View>

        {right.map((tab) => (
          <TabSlot key={tab.name} tab={tab} active={activeRoute === tab.name} onPress={() => go(tab.name)} />
        ))}
      </View>
    </View>
  );
}

function TabSlot({
  tab,
  active,
  onPress,
}: {
  tab: (typeof TABS)[number];
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={tab.label}
      style={styles.slot}
      android_ripple={{ color: theme.colors.accentSurface, borderless: true, radius: 28 }}
    >
      <View
        style={[
          styles.slotInner,
          {
            backgroundColor: active ? theme.colors.accentSurface : 'transparent',
            borderRadius: theme.radius.pill,
          },
        ]}
      >
        <Icon
          name={active ? tab.iconActive : tab.icon}
          size={22}
          color={active ? theme.colors.textAccent : theme.colors.textTertiary}
        />
      </View>
      <Text
        variant="caption"
        style={{
          color: active ? theme.colors.textAccent : theme.colors.textTertiary,
          // Weight comes from the family, never from `fontWeight`. With custom fonts
          // loaded, `fontWeight: '700'` makes Android synthesise a fake bold — it smears
          // the stems of a 12pt label, which is exactly where it shows worst. See the
          // explanation in `src/ui/primitives/Text.tsx`.
          fontFamily: active ? FONT_FAMILY.sansBold : FONT_FAMILY.sansMedium,
        }}
        numberOfLines={1}
      >
        {tab.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  floatingWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: SPACING.lg,
    pointerEvents: 'box-none',
  },
  /*
    `height` and `borderRadius` are applied at the call site from `LAYOUT.tabBarHeight`,
    not here. The height was a literal `66` while the token every tab screen pads its
    scroll content by said `62`, so the last 4pt of every screen sat under the bar. There
    is now one number and this file reads it.
  */
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: BORDER_WIDTH.hairline,
    paddingHorizontal: SPACING.sm,
  },
  slot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    height: '100%',
  },
  slotInner: {
    width: 44,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composeSlot: {
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composePress: {
    marginTop: -COMPOSE_OVERHANG,
  },
  compose: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

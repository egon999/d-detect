import { Stack } from 'expo-router';
import React from 'react';

import { useTheme } from '@ui';

/**
 * The case stack.
 *
 * ## Why there is no native header
 *
 * Every screen under this route draws its own masthead through `ScreenScroll` — a title, a
 * subtitle carrying the case name, and its own back control. A native header on top of that
 * is a second title bar saying a shorter version of the same thing.
 *
 * This is also why the per-screen `options={{ title }}` entries that used to be here are
 * gone rather than merely unused. `headerShown: false` on the navigator applies to every
 * route in it, so those nine titles rendered nowhere: they were not configuration, they were
 * a second set of screen names that no one could see and nothing checked. Predictably they
 * drifted out of step with the headings the screens actually display. A screen's title now
 * has exactly one home — the screen.
 *
 * Routes are not declared here either. Expo Router discovers them from the filesystem, so a
 * `Stack.Screen` is only needed to configure one. The two below are the two that have
 * something left to say.
 */
export default function CaseLayout() {
  const theme = useTheme();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.canvas },
        animation: 'default',
      }}
    >
      {/* Both are interruptions to the case you are reading rather than places within it,
          and a modal is the presentation that says so — it is dismissed, not navigated away
          from. This is real configuration: unlike a title, it survives a hidden header. */}
      <Stack.Screen name="upload" options={{ presentation: 'modal' }} />
      <Stack.Screen name="export" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

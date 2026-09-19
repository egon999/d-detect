/**
 * Root layout.
 *
 * The app's boot sequence, and the only place providers are assembled.
 *
 * ## The rule this file exists to enforce
 *
 * **The splash screen always lifts.** Every previous version of this file made hiding it
 * conditional on something: fonts loading, a preference being read, a provider resolving,
 * an effect running. Each of those is a way for the app to hang on a white screen with no
 * error, which is exactly what it did on device — the providers below never mounted, so
 * the effect that calls `hideAsync` never ran, so the native splash stayed up forever and
 * the user saw a frozen logo.
 *
 * The fix is to stop treating the splash as something the app dismisses when it is happy,
 * and start treating it as something that comes down on a timer no matter what. The
 * `SPLASH_FAILSAFE_MS` timeout at module scope is armed before React renders anything and
 * cannot be cancelled by a component failing to mount. If boot finishes sooner, the effect
 * hides it sooner. If boot never finishes, the user still gets a screen — and because the
 * tree is wrapped in `ErrorBoundary`, that screen says what went wrong.
 *
 * ## Boot order
 *
 * Three things are wanted before the first frame, and they are genuinely ordered:
 *
 *   1. **The colour preference**, read from storage, before the theme provider mounts —
 *      otherwise a user who chose dark gets a white flash.
 *   2. **The type faces**, so text does not render in the system font and reflow.
 *   3. **The storage adapter**, which decides whether this session talks to Firestore or
 *      to the device.
 *
 * None of them may *block* boot. Each has a deadline; past it, the app renders anyway with
 * a sensible default. A missing font is a cosmetic problem. A splash screen that never
 * lifts is a dead app.
 *
 * ## Auth gating
 *
 * There is no route-level guard on this Stack. Gating happens at the entry route:
 * `app/index.tsx` reads the session status from `useSession()` and redirects —
 * 'restoring' paints an empty canvas under the splash, 'signedIn' goes to /(tabs),
 * anything else goes to /sign-in. The tradeoff: the other routes still exist in the
 * navigator, so a deep link can land on a case screen while signed out. That is safe
 * because every screen loads its data through `useWorkspace(user?.id, ...)`, which
 * returns an empty workspace when there is no user, so the screen shows its own
 * unavailable state rather than anyone's data.
 */

import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RepositoryProvider, SessionProvider, useSession } from '@services';
import { useThemePreference } from '@services/preferences';
import { AnimatedSplashScreen, ErrorBoundary, ThemeProvider, ToastProvider, useAppFonts, useTheme } from '@ui';

/**
 * How long boot may take before the splash comes down regardless.
 *
 * Chosen against the slow path this app actually has: AsyncStorage read, font decode, and
 * possibly a Firestore handshake on a cold radio. Those finish well inside three seconds on
 * a mid-range Android device. Past that, whatever is outstanding is not going to arrive in
 * time to matter, and showing the user a working app beats showing them a logo.
 */
const SPLASH_FAILSAFE_MS = 1400;

// Held from module scope, before React mounts. Awaiting is pointless: the call either takes
// effect or the splash was already gone, and neither outcome changes what happens next.
void SplashScreen.preventAutoHideAsync().catch(() => {});

// A short cross-fade rather than an instant cut. 260ms reads as a transition without
// feeling like waiting. Guarded because `setOptions` warns and no-ops in Expo Go.
try {
  SplashScreen.setOptions({ duration: 260, fade: true });
} catch {
  // Cosmetic only.
}

/**
 * The unconditional failsafe, armed at module scope.
 *
 * This is the load-bearing line of the file. It runs whether or not React mounts, whether
 * or not a provider resolves, and whether or not a component throws.
 */
const splashFailsafe = setTimeout(() => {
  void SplashScreen.hideAsync().catch(() => {});
}, SPLASH_FAILSAFE_MS);

/** Hides the splash now and disarms the failsafe. Safe to call repeatedly. */
function hideSplash() {
  clearTimeout(splashFailsafe);
  void SplashScreen.hideAsync().catch(() => {});
}

export default function RootLayout() {
  const fonts = useAppFonts();
  const theme = useThemePreference();

  // A deadline on boot prerequisites, independent of the splash failsafe. Fonts that have
  // not decoded in two seconds are not going to; the app renders in the system font rather
  // than holding an empty screen over a problem the user cannot act on.
  const [deadlinePassed, setDeadlinePassed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDeadlinePassed(true), 1000);
    return () => clearTimeout(timer);
  }, []);

  // Fonts settle to `loaded` on success or to an error on failure; both are terminal.
  const fontsSettled = fonts.loaded || fonts.error !== null;
  const ready = (fontsSettled && theme.loaded) || deadlinePassed;

  // Belt and braces: if the tree below never reaches the effect that hides the splash, this
  // does it as soon as the root is able to paint.
  useEffect(() => {
    if (ready) hideSplash();
  }, [ready]);

  if (!ready) {
    // The native splash is still up, so this renders behind it. `null` rather than a
    // spinner avoids two loading indicators fighting over the same moment.
    return null;
  }

  return (
    <ErrorBoundary label="app root">
      <GestureHandlerRootView style={styles.fill}>
        <SafeAreaProvider>
          <ThemeProvider
            initialPreference={theme.preference}
            onPreferenceChange={theme.setPreference}
          >
            <RepositoryProvider>
              <SessionProvider>
                {/*
                  Mounted once, here, because `useToast()` resolves through context and any
                  screen may fire one. Inside `ThemeProvider` — the toast reads theme tokens —
                  and inside `SafeAreaProvider`, which its host uses to clear the notch.
                */}
                <ToastProvider>
                  <AppShell />
                </ToastProvider>
              </SessionProvider>
            </RepositoryProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

/**
 * The navigator.
 *
 * Sits inside the providers so it can read the session for the route guards and the theme
 * for the canvas colour — which is set on the container as well as on each screen, so the
 * gap revealed during a push transition is the app's background rather than white.
 */
function AppShell() {
  const theme = useTheme();
  const { status } = useSession();
  const [splashFinished, setSplashFinished] = useState(false);

  const restoring = status === 'restoring';

  // The animated splash is given a hard ceiling of its own. It is an overlay at a very high
  // z-index, so if its exit animation never completes — a dropped frame callback, a
  // backgrounded app — it would cover a working app indefinitely.
  const finishedRef = useRef(false);
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setSplashFinished(true);
  }, []);

  useEffect(() => {
    hideSplash();
    const timer = setTimeout(finish, SPLASH_FAILSAFE_MS);
    return () => clearTimeout(timer);
  }, [finish]);

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas }]}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />

      <ErrorBoundary label="navigation">
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.colors.canvas },
            animation: 'default',
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="onboarding" />
          <Stack.Screen name="sign-in" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="case" />
          <Stack.Screen name="new-case" options={{ presentation: 'modal' }} />
          <Stack.Screen name="notifications" options={{ presentation: 'modal' }} />
          <Stack.Screen name="search" options={{ presentation: 'modal' }} />
          <Stack.Screen name="previous-cases" options={{ title: 'Cases on this Device' }} />
          <Stack.Screen name="about" />
          <Stack.Screen name="+not-found" options={{ presentation: 'modal' }} />
        </Stack>
      </ErrorBoundary>

      {!splashFinished ? (
        <ErrorBoundary label="splash">
          <AnimatedSplashScreen isReady={!restoring} onFinish={finish} />
        </ErrorBoundary>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});

import { Stack, usePathname, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { configureApi, loadPersistedCustomApiBaseUrl } from '@api';
import { firebaseAuth } from '@data/firebase/auth';
import { SessionProvider, useSession } from '@services';
import {
  BOOT_DEADLINE_MS,
  SPLASH_FAILSAFE_MS,
  SPLASH_OVERLAY_BACKSTOP_MS,
  SPLASH_OVERLAY_EXIT_MS,
} from '@services/auth/launch';
import { shouldLeaveForSignIn } from '@services/auth/route-guard';
import { Reminders } from '@services/reminders';
import { LanguageProvider } from '@i18n';
import { AnimatedSplashScreen, ErrorBoundary, ThemeProvider, ToastProvider, useAppFonts, useTheme } from '@ui';

void SplashScreen.preventAutoHideAsync().catch(() => {});

try {
  SplashScreen.setOptions({ duration: SPLASH_OVERLAY_EXIT_MS, fade: true });
} catch {

}

const splashFailsafe = setTimeout(() => {
  void SplashScreen.hideAsync().catch(() => {});
}, SPLASH_FAILSAFE_MS);

function hideSplash() {
  clearTimeout(splashFailsafe);
  void SplashScreen.hideAsync().catch(() => {});
}

export default function RootLayout() {
  const fonts = useAppFonts();

  const [deadlinePassed, setDeadlinePassed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDeadlinePassed(true), BOOT_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, []);

  const fontsSettled = fonts.loaded || fonts.error !== null;
  const ready = fontsSettled || deadlinePassed;

  useEffect(() => {
    if (ready) hideSplash();
  }, [ready]);

  if (!ready) {

    return null;
  }

  return (

    <ErrorBoundary label="Starting the app">
      <GestureHandlerRootView style={styles.fill}>
        <SafeAreaProvider>
          <LanguageProvider>
            <ThemeProvider>
              <SessionProvider>
                {}
                <ApiAuthBridge />
                {}
                <SessionExitGuard />
                {}
                <Reminders />
                {}
                <ToastProvider>
                  <AppShell />
                </ToastProvider>
              </SessionProvider>
            </ThemeProvider>
          </LanguageProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

function ApiAuthBridge() {
  const { user, isLocal } = useSession();
  const ref = useRef({ user, isLocal });
  ref.current = { user, isLocal };

  useEffect(() => {
    void loadPersistedCustomApiBaseUrl().catch(() => {});
  }, []);

  useEffect(() => {
    configureApi(async (refresh) => {
      const { user: current, isLocal: local } = ref.current;
      if (!current) return null;
      if (local) return { deviceId: current.id };

      try {
        const auth = await firebaseAuth();
        if (!auth?.currentUser) return null;

        return await auth.currentUser.getIdToken(refresh?.forceRefresh ?? false);
      } catch {
        return null;
      }
    });
  }, []);

  return null;
}

function SessionExitGuard() {
  const { status } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const heldSession = useRef(false);

  useEffect(() => {
    if (status === 'signedIn') {
      heldSession.current = true;
      return;
    }

    if (status !== 'signedOut') return;

    const leave = shouldLeaveForSignIn({
      status,
      heldSession: heldSession.current,
      pathname,
    });

    if (heldSession.current) heldSession.current = false;

    if (leave) router.replace('/sign-in');
  }, [status, pathname, router]);

  return null;
}

function AppShell() {
  const theme = useTheme();
  const { status } = useSession();
  const [splashFinished, setSplashFinished] = useState(false);

  const restoring = status === 'restoring';

  const finishedRef = useRef(false);
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setSplashFinished(true);
  }, []);

  useEffect(() => {
    hideSplash();
    const timer = setTimeout(finish, SPLASH_OVERLAY_BACKSTOP_MS);
    return () => clearTimeout(timer);
  }, [finish]);

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas }]}>
      <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />

      <ErrorBoundary label="Moving between screens">
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
          {}
          <Stack.Screen name="legal" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="capture" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="record/[id]" />
          <Stack.Screen name="case/[id]" />
          <Stack.Screen name="case/new" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="case/item" />
          <Stack.Screen name="meeting/[id]" />
          <Stack.Screen name="ask" />
          <Stack.Screen name="attention" />
          <Stack.Screen name="recap" />
          {}
          <Stack.Screen name="search" />
          <Stack.Screen name="reminders" />
          <Stack.Screen name="+not-found" options={{ presentation: 'modal' }} />
        </Stack>
      </ErrorBoundary>

      {!splashFinished ? (
        <ErrorBoundary label="The opening screen">
          <AnimatedSplashScreen isReady={!restoring} onFinish={finish} />
        </ErrorBoundary>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});

import { Redirect } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSession } from '@services';
import { hasSeenOnboarding } from '@services/preferences';
import { useTheme } from '@ui';

/**
 * Root Route Dispatcher (/).
 *
 * Guarantees that opening the app never hits a 404 (+not-found) screen.
 * Resolves session status:
 * - 'restoring': renders a minimal canvas placeholder while the animated splash plays
 * - 'signedIn': routes immediately to the main dashboard /(tabs)
 * - signed-out, first launch: routes to /onboarding (once only, then remembered on device)
 * - signed-out, returning: routes to /sign-in
 */
export default function Index() {
  const { status, user } = useSession();
  const theme = useTheme();

  /**
   * `null` while the AsyncStorage read is in flight.
   *
   * We wait before redirecting so a returning user never sees the onboarding slide past
   * on their way to sign-in. The read is fast (a single key lookup) and the splash covers
   * the wait anyway.
   */
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [seenOnboarding, setSeenOnboarding] = useState(false);

  useEffect(() => {
    void hasSeenOnboarding()
      .then((seen) => {
        setSeenOnboarding(seen);
      })
      .catch(() => {
        // If the read fails, treat it as seen — a stuck onboarding loop is worse than a
        // user who never gets the intro.
        setSeenOnboarding(true);
      })
      .finally(() => {
        setOnboardingChecked(true);
      });
  }, []);

  // A signed-in user never sees onboarding, so this redirect does not wait on the flag read
  // and the app is not held back by a storage lookup it has no use for.
  if (status === 'signedIn' && user) {
    return <Redirect href="/(tabs)" />;
  }

  if (status === 'restoring' || !onboardingChecked) {
    return <View style={[styles.container, { backgroundColor: theme.colors.canvas }]} />;
  }

  if (!seenOnboarding) {
    return <Redirect href="/onboarding" />;
  }

  return <Redirect href="/sign-in" />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

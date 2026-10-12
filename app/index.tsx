import { Redirect, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';

import { useSession } from '@services';
import { launchDestination, STORAGE_DEADLINE_MS, STUCK_MS } from '@services/auth/launch';
import { hasSeenOnboarding } from '@services/preferences';
import {
  AmbientBackdrop,
  BORDER_WIDTH,
  Button,
  FadeIn,
  IndeterminateBar,
  LAYOUT,
  RADIUS,
  SPACING,
  Text,
  useTheme,
} from '@ui';

const BADGE_SIZE = SPACING.giant * 2;
const BADGE_IMAGE = SPACING.colossal;

export default function Index() {
  const { status, user } = useSession();
  const theme = useTheme();
  const router = useRouter();

  const [seenOnboarding, setSeenOnboarding] = useState<boolean | null>(null);
  const [storageDeadlinePassed, setStorageDeadlinePassed] = useState(false);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    let active = true;

    void hasSeenOnboarding()
      .then((seen) => {
        if (active) setSeenOnboarding(seen);
      })
      .catch(() => {
        if (active) setSeenOnboarding(true);
      });

    const storageTimer = setTimeout(() => {
      if (active) setStorageDeadlinePassed(true);
    }, STORAGE_DEADLINE_MS);

    const stuckTimer = setTimeout(() => {
      if (active) setStuck(true);
    }, STUCK_MS);

    return () => {
      active = false;
      clearTimeout(storageTimer);
      clearTimeout(stuckTimer);
    };
  }, []);

  const destination = useMemo(
    () =>
      launchDestination({
        status,
        hasUser: user !== null,
        seenIntroduction: seenOnboarding,
        storageDeadlinePassed,
      }),
    [status, user, seenOnboarding, storageDeadlinePassed],
  );

  if (destination === 'app') return <Redirect href="/(tabs)" />;
  if (destination === 'introduction') return <Redirect href="/onboarding" />;
  if (destination === 'signIn') return <Redirect href="/sign-in" />;

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.canvas }]}>
      <AmbientBackdrop />
      {}
      <View style={styles.stage}>
        <View
          style={[
            styles.badge,
            { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.accent },
          ]}
        >
          <Image
            source={require('../assets/dd.png')}
            style={styles.badgeImage}
            resizeMode="contain"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        </View>

        <Text variant="title" center style={{ marginTop: theme.spacing.xxl }}>
          D-Detect
        </Text>

        {}
        <View style={[styles.bar, { marginTop: theme.spacing.xxxl }]}>
          <IndeterminateBar accessibilityLabel="Opening D-Detect" />
        </View>
      </View>

      {stuck ? (
        <FadeIn>
          <View
            style={[styles.escape, { paddingBottom: theme.spacing.colossal }]}

            accessibilityLiveRegion="polite"
          >
            <Text variant="body" colorToken="textSecondary" center>
              This is taking longer than it should.
            </Text>
            <Text
              variant="caption"
              colorToken="textTertiary"
              center
              style={{ marginTop: theme.spacing.sm }}
            >
              Your records are safe. Sign in and carry on from there.
            </Text>

            <Button
              label="Go to sign in"
              variant="primary"
              size="lg"
              fullWidth
              onPress={() => router.replace('/sign-in')}
              style={{ marginTop: theme.spacing.xl }}
              accessibilityHint="Opens the sign-in screen without waiting any longer"
            />
          </View>
        </FadeIn>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'space-between',
  },
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: LAYOUT.screenPadding,
  },
  badge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: RADIUS.xl,
    borderWidth: BORDER_WIDTH.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  badgeImage: {
    width: BADGE_IMAGE,
    height: BADGE_IMAGE,
  },

  bar: {
    width: '44%',
  },
  escape: {
    paddingHorizontal: LAYOUT.screenPadding,
  },
});

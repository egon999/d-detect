import { useRouter } from 'expo-router';
import React, { useCallback } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { markOnboardingSeen } from '@services/preferences';
import {
  AmbientBackdrop,
  BORDER_WIDTH,
  Button,
  FadeIn,
  GlassSurface,
  LAYOUT,
  RADIUS,
  SPACING,
  SlideUpIn,
  Text,
  useTheme,
} from '@ui';

export default function OnboardingScreen() {
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const finish = useCallback(() => {
    void markOnboardingSeen();
    router.replace('/sign-in');
  }, [router]);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.canvas }]}>
      <AmbientBackdrop />

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: insets.top + SPACING.giant,
            paddingBottom: insets.bottom + SPACING.xxl,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <SlideUpIn distance={-theme.motion.enterDistance}>
          {}
          <View style={styles.masthead}>
            <View
              style={[
                styles.logoBadge,
                {
                  backgroundColor: theme.colors.surfaceRaised,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Image
                source={require('../assets/dd.png')}
                style={styles.logoImage}
                resizeMode="contain"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            </View>
            <Text variant="heading" style={{ marginTop: theme.spacing.lg }}>
              D-Detect
            </Text>
          </View>
        </SlideUpIn>

        <FadeIn>
          <GlassSurface
            variant="hero"
            radius="xl"
            elevation="medium"

            style={styles.card}
            contentStyle={styles.cardContent}
          >
            <Text variant="title" center>
              Keep the proof of what happened
            </Text>

            <Text
              variant="body"
              colorToken="textSecondary"
              center
              style={{ marginTop: theme.spacing.lg }}
            >
              Bills, payment screenshots, receipts, documents, and recordings of meetings.
              D-Detect keeps them in one place and reads them, so you can find what you need
              later — including when someone says it did not happen that way.
            </Text>

            {}
            <Text
              variant="body"
              colorToken="textSecondary"
              center
              style={{ marginTop: theme.spacing.lg }}
            >
              When you add a file it is sent to be read, and what is read is kept in your
              account. You can delete anything you have added, whenever you want.
            </Text>
          </GlassSurface>
        </FadeIn>
      </ScrollView>

      {}
      <SlideUpIn delay={theme.motion.stagger}>
        <View
          style={[
            styles.footer,
            {
              paddingLeft: LAYOUT.screenPadding + insets.left,
              paddingRight: LAYOUT.screenPadding + insets.right,
              paddingBottom: insets.bottom + theme.spacing.xl,
            },
          ]}
        >
          <Button
            label="Get started"
            icon="arrow-right"
            iconTrailing
            variant="primary"
            size="lg"
            fullWidth
            onPress={finish}
            accessibilityHint="Goes to sign in"
          />

          {}
          <View style={styles.legalLink}>
            <Button
              label="What happens to your files"
              variant="ghost"
              size="sm"
              onPress={() => router.push('/legal')}
              accessibilityHint="Opens what the app keeps, where it keeps it, and how to delete it"
            />
          </View>
        </View>
      </SlideUpIn>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  wash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '46%',
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: LAYOUT.screenPadding,
  },
  masthead: {
    alignItems: 'center',
    marginBottom: SPACING.xxxl,
  },
  logoBadge: {
    width: LAYOUT.tileSizeLarge,
    height: LAYOUT.tileSizeLarge,
    borderRadius: RADIUS.md,
    borderWidth: BORDER_WIDTH.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoImage: {
    width: SPACING.colossal,
    height: SPACING.colossal,
  },

  card: {
    width: '100%',
    maxWidth: LAYOUT.maxContentWidth / 2,
    alignSelf: 'center',
  },
  cardContent: {
    alignItems: 'center',
    paddingVertical: SPACING.xxxl,
    paddingHorizontal: SPACING.xxl,
  },
  footer: {
    paddingTop: SPACING.md,
  },
  legalLink: {
    alignItems: 'center',
  },
});

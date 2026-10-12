import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KEEP_SIGNED_IN_STORAGE_KEY, readableAuthError, useSession } from '@services';
export { KEEP_SIGNED_IN_STORAGE_KEY };
import {
  MIN_PASSWORD_LENGTH,
  problemWithEmail,
  problemWithName,
  problemWithPassword,
  whySubmitBlocked,
} from '@services/auth/credentials';
import {
  AmbientBackdrop,
  BORDER_WIDTH,
  Button,
  CheckboxPill,
  DetectiveMascot,
  Divider,
  DraggableBanner,
  FadeIn,
  FloatingPillInput,
  GooglePillButton,
  GradientPillButton,
  Icon,
  Notice,
  Pressable,
  RADIUS,
  Row,
  SPACING,
  SegmentedControl,
  ShinyText,
  SlideUpIn,
  Text,
  useTheme,
} from '@ui';

type Mode = 'signIn' | 'signUp';

const googleConfigured = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim().length > 0;

export default function SignInScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const {
    status,
    accountsAvailable,
    signIn,
    signUp,
    signInWithGoogle,
    continueOffline,
    sendPasswordReset,
  } = useSession();

  React.useEffect(() => {
    if (status === 'signedIn') {
      router.replace('/(tabs)');
    }
  }, [status, router]);

  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [keepSignedIn, setKeepSignedIn] = useState(true);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(KEEP_SIGNED_IN_STORAGE_KEY)
      .then((saved) => {
        if (active && saved !== null) {
          setKeepSignedIn(saved === 'true');
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const handleToggleKeepSignedIn = useCallback((checked: boolean) => {
    setKeepSignedIn(checked);
    AsyncStorage.setItem(KEEP_SIGNED_IN_STORAGE_KEY, checked ? 'true' : 'false').catch(() => {});
  }, []);

  const [busy, setBusy] = useState<'submit' | 'google' | 'device' | 'reset' | null>(null);

  const [formError, setFormError] = useState<string | null>(null);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);

  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const [attempted, setAttempted] = useState(false);

  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  const googleAvailable = googleConfigured;
  const deviceAvailable = __DEV__ || !accountsAvailable;

  const alternatives = googleAvailable || deviceAvailable;

  const emailProblem = problemWithEmail(email);
  const passwordProblem = problemWithPassword(password, mode);
  const nameProblem = problemWithName(displayName, mode);

  const showProblem = useCallback(
    (field: string, problem: string | null): string | null =>
      problem && (attempted || touched[field]) ? problem : null,
    [attempted, touched],
  );

  const markTouched = useCallback((field: string) => {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }, []);

  const nameError = showProblem('name', nameProblem);
  const emailError = showProblem('email', emailProblem);
  const passwordError = showProblem('password', passwordProblem);

  const blockedReason = whySubmitBlocked({ mode, name: displayName, email, password });

  const switchMode = useCallback((next: Mode) => {
    setMode(next);
    setFormError(null);
    setResetSentTo(null);
    setAttempted(false);
    setTouched({});
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;
    setAttempted(true);
    setFormError(null);
    setResetSentTo(null);

    if (emailProblem || passwordProblem || nameProblem) return;

    setBusy('submit');
    try {
      if (mode === 'signIn') {
        await signIn(email.trim(), password);
      } else {
        await signUp(email.trim(), password, displayName.trim());
      }
      await AsyncStorage.setItem(
        KEEP_SIGNED_IN_STORAGE_KEY,
        keepSignedIn ? 'true' : 'false',
      ).catch(() => {});
      router.replace('/(tabs)');
    } catch (caught) {
      setFormError(readableAuthError(caught));
    } finally {
      setBusy(null);
    }
  }, [
    busy,
    displayName,
    email,
    emailProblem,
    keepSignedIn,
    mode,
    nameProblem,
    password,
    passwordProblem,
    router,
    signIn,
    signUp,
  ]);

  const resetPassword = useCallback(async () => {
    if (busy) return;
    markTouched('email');
    setFormError(null);
    setResetSentTo(null);

    if (emailProblem) return;

    const target = email.trim();
    setBusy('reset');
    try {
      await sendPasswordReset(target);
      setResetSentTo(target);
    } catch (caught) {
      setFormError(readableAuthError(caught));
    } finally {
      setBusy(null);
    }
  }, [busy, email, emailProblem, markTouched, sendPasswordReset]);

  const handleGoogleSignIn = useCallback(async () => {
    if (busy) return;
    setFormError(null);
    setResetSentTo(null);
    setBusy('google');
    try {
      const signedIn = await signInWithGoogle();
      if (signedIn) {
        await AsyncStorage.setItem(
          KEEP_SIGNED_IN_STORAGE_KEY,
          keepSignedIn ? 'true' : 'false',
        ).catch(() => {});
        router.replace('/(tabs)');
      }
    } catch (caught: any) {
      const errorMsg = String(caught?.message || caught || '');
      const errorCode = String(caught?.code || '');

      if (
        errorCode === 'auth/popup-closed-by-user' ||
        errorCode === 'auth/cancelled-popup-request' ||
        errorCode === 'SIGN_IN_CANCELLED' ||
        /cancel/i.test(errorMsg)
      ) {
        return;
      }
      setFormError(readableAuthError(caught));
    } finally {
      setBusy(null);
    }
  }, [busy, keepSignedIn, router, signInWithGoogle]);

  const handleDeviceOnly = useCallback(async () => {
    if (busy) return;
    setFormError(null);
    setResetSentTo(null);
    setBusy('device');
    try {
      await continueOffline();
      router.replace('/(tabs)');
    } catch (caught) {
      setFormError(readableAuthError(caught));
    } finally {
      setBusy(null);
    }
  }, [busy, continueOffline, router]);

  const anyBusy = busy !== null;

  const bannerTitle =
    mode === 'signUp' ? 'Your account was not created' : 'You are not signed in yet';

  return (
    <KeyboardAvoidingView
      style={[styles.fill, { backgroundColor: theme.colors.canvas }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <AmbientBackdrop />
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingBottom: insets.bottom + theme.spacing.huge,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {}
        <SlideUpIn>
          <DraggableBanner
            mascot={<DetectiveMascot size={105} />}
            style={[
              styles.bannerWrapper,
              { paddingTop: Math.max(insets.top, 16) + 4 },
            ]}
          >
            <View style={styles.bannerInfo}>
              <View style={styles.badgePill}>
                <Icon name="shield-check" size={13} color="#D4C491" />
                <Text variant="caption" style={styles.badgeText}>
                  SECURE VAULT
                </Text>
              </View>

              <ShinyText
                text="D-Detect."
                variant="display"
                colorToken="onCta"
                style={styles.brandTitle}
              />

              <Text variant="caption" style={styles.brandSubtitle} numberOfLines={2}>
                Private evidence vault &amp; intelligence timeline
              </Text>
            </View>
          </DraggableBanner>
        </SlideUpIn>

        {}
        <SlideUpIn delay={theme.motion.stagger}>
          <View style={styles.formContainer}>
            {}
            <View style={styles.headingBlock}>
              <ShinyText
                key={mode}
                text={mode === 'signIn' ? 'Welcome Back' : 'Create Account'}
                variant="title"
                style={styles.welcomeHeading}
              />
              <Text variant="bodyMedium" colorToken="textSecondary">
                {mode === 'signIn'
                  ? 'Sign in to access your secure evidence records'
                  : 'Start keeping tamper-evident records on this device'}
              </Text>
            </View>

            {accountsAvailable ? (
              <>
                {}
                <View style={styles.segmentedWrapper}>
                  <SegmentedControl<Mode>
                    value={mode}
                    onChange={switchMode}
                    options={[
                      { value: 'signIn', label: 'Sign in' },
                      { value: 'signUp', label: 'Create account' },
                    ]}
                  />
                </View>

                {}
                <View style={styles.fieldsGap}>
                  {mode === 'signUp' ? (
                    <FloatingPillInput
                      label="Full name"
                      placeholder="e.g. John Doe"
                      iconName="account-outline"
                      value={displayName}
                      onChangeText={setDisplayName}
                      onBlur={() => markTouched('name')}
                      autoCapitalize="words"
                      autoComplete="name"
                      textContentType="name"
                      returnKeyType="next"
                      editable={!anyBusy}
                      onSubmitEditing={() => emailRef.current?.focus()}
                      {...(nameError ? { error: nameError } : {})}
                    />
                  ) : null}

                  <FloatingPillInput
                    ref={emailRef}
                    label="Email address"
                    placeholder="name@domain.com"
                    iconName="email-outline"
                    value={email}
                    onChangeText={setEmail}
                    onBlur={() => markTouched('email')}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    textContentType="emailAddress"
                    returnKeyType="next"
                    editable={!anyBusy}
                    onSubmitEditing={() => passwordRef.current?.focus()}
                    {...(emailError ? { error: emailError } : {})}
                  />

                  <FloatingPillInput
                    ref={passwordRef}
                    label="Password"
                    placeholder={
                      mode === 'signUp'
                        ? `At least ${MIN_PASSWORD_LENGTH} characters`
                        : 'Your password'
                    }
                    iconName="lock-outline"
                    secureToggle
                    value={password}
                    onChangeText={setPassword}
                    onBlur={() => markTouched('password')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                    textContentType={mode === 'signIn' ? 'password' : 'newPassword'}
                    returnKeyType="done"
                    editable={!anyBusy}
                    onSubmitEditing={() => void submit()}
                    {...(passwordError ? { error: passwordError } : {})}
                  />
                </View>

                {}
                {mode === 'signIn' ? (
                  <View style={styles.utilityRow}>
                    <CheckboxPill
                      checked={keepSignedIn}
                      onToggle={handleToggleKeepSignedIn}
                      label="Keep me signed in"
                      disabled={anyBusy}
                    />

                    <Button
                      label="Forgot password?"
                      variant="ghost"
                      size="sm"
                      loading={busy === 'reset'}
                      disabled={anyBusy}
                      accessibilityHint={
                        emailProblem
                          ? 'Fill in your email address above first'
                          : 'Sends a password reset link to your email'
                      }
                      onPress={() => void resetPassword()}
                    />
                  </View>
                ) : null}
              </>
            ) : (
              <Notice
                tone="warn"
                icon="account-circle-outline"
                title="Signing in isn’t working in this app"
                message="You can still use D-Detect on this phone — everything you add is kept under it, and nothing is lost by starting here."
                style={{ marginBottom: theme.spacing.lg }}
              />
            )}

            {}
            {formError ? (
              <Notice
                tone="danger"
                icon="alert-circle-outline"
                title={bannerTitle}
                message={formError}
                onDismiss={() => setFormError(null)}
                style={{ marginTop: theme.spacing.md }}
              />
            ) : null}

            {}
            {resetSentTo ? (
              <Notice
                tone="info"
                icon="email-check-outline"
                title="Check your email"
                message={`If there is an account for ${resetSentTo}, a link for choosing a new password is on its way. Open it, pick a new password, then come back here and sign in.`}
                onDismiss={() => setResetSentTo(null)}
                style={{ marginTop: theme.spacing.md }}
              />
            ) : null}

            {}
            {accountsAvailable ? (
              <View style={styles.submitBlock}>
                <GradientPillButton
                  label={mode === 'signIn' ? 'Log In' : 'Create Account'}
                  onPress={() => void submit()}
                  loading={busy === 'submit'}
                  disabled={anyBusy || blockedReason !== null}
                  accessibilityLabel={
                    blockedReason ??
                    (mode === 'signIn'
                      ? 'Signs you in and opens your records'
                      : 'Creates your account and opens your records')
                  }
                />

                {blockedReason && !anyBusy ? (
                  <Text
                    variant="caption"
                    colorToken="textTertiary"
                    center
                    style={{ marginTop: theme.spacing.xs }}
                  >
                    {blockedReason}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {}
            {alternatives ? (
              <FadeIn delay={theme.motion.stagger * 2}>
                {accountsAvailable ? (
                  <Row gap="md" align="center" style={styles.dividerRow}>
                    <View style={styles.flex}>
                      <Divider />
                    </View>
                    <Text variant="caption" colorToken="textTertiary" uppercase>
                      or continue with
                    </Text>
                    <View style={styles.flex}>
                      <Divider />
                    </View>
                  </Row>
                ) : (
                  <View style={{ height: theme.spacing.lg }} />
                )}

                {}
                {googleAvailable ? (
                  <GooglePillButton
                    onPress={() => void handleGoogleSignIn()}
                    loading={busy === 'google'}
                    disabled={anyBusy}
                  />
                ) : null}

                {}
                {deviceAvailable ? (
                  <Button
                    label="Start on this phone"
                    icon="cellphone"
                    variant={accountsAvailable ? 'ghost' : 'primary'}
                    size={accountsAvailable ? 'md' : 'lg'}
                    fullWidth
                    disabled={anyBusy}
                    loading={busy === 'device'}
                    accessibilityHint="Keeps your records under this phone instead of an account"
                    onPress={() => void handleDeviceOnly()}
                    style={[
                      styles.socialButton,
                      googleAvailable ? { marginTop: theme.spacing.sm } : undefined,
                    ]}
                  />
                ) : null}
              </FadeIn>
            ) : null}

            {}
            <Row gap="xs" justify="center" align="center" style={styles.switcherRow}>
              <Text variant="caption" colorToken="textSecondary">
                {mode === 'signIn'
                  ? "Don't have an account?"
                  : 'Already have an account?'}
              </Text>
              <Pressable
                onPress={() => switchMode(mode === 'signIn' ? 'signUp' : 'signIn')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={
                  mode === 'signIn' ? 'Switch to create account' : 'Switch to sign in'
                }
              >
                <Text variant="caption" style={[styles.switchLink, { color: theme.colors.cta }]}>
                  {mode === 'signIn' ? 'Create Account' : 'Sign In'}
                </Text>
              </Pressable>
            </Row>

            {}
            <View style={styles.footerBlock}>
              <Text variant="caption" colorToken="textTertiary" center>
                By continuing you accept how D-Detect handles your records, and what it does and
                doesn’t claim to do.
              </Text>
              <Row gap="sm" justify="center" style={{ marginTop: theme.spacing.xs }}>
                <Button
                  label="Your records"
                  variant="ghost"
                  size="sm"
                  onPress={() => router.push('/legal')}
                  accessibilityHint="What the app keeps, where it keeps it, and how to delete it"
                />
                <Button
                  label="What it’s for"
                  variant="ghost"
                  size="sm"
                  onPress={() => router.push({ pathname: '/legal', params: { part: 'purpose' } })}
                  accessibilityHint="What the app does, and what it will not tell you"
                />
              </Row>
            </View>
          </View>
        </SlideUpIn>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  bannerWrapper: {
    marginBottom: SPACING.lg,
  },
  bannerInfo: {
    justifyContent: 'center',
    gap: 4,
  },
  badgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(212, 196, 145, 0.15)',
    borderColor: 'rgba(212, 196, 145, 0.35)',
    borderWidth: BORDER_WIDTH.hairline,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 8,
    paddingVertical: 2.5,
    marginBottom: 2,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: '#D4C491',
  },
  brandTitle: {
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  brandSubtitle: {
    color: '#ADC5F5',
    fontSize: 12,
    lineHeight: 16,
  },
  formContainer: {
    width: '100%',
    maxWidth: 440,
    alignSelf: 'center',
    paddingHorizontal: 20,
  },
  headingBlock: {
    marginBottom: SPACING.md,
  },
  welcomeHeading: {
    fontWeight: '700',
    letterSpacing: -0.4,
    marginBottom: SPACING.xxs,
  },
  segmentedWrapper: {
    marginBottom: SPACING.md,
  },
  fieldsGap: {
    gap: SPACING.xs,
  },
  utilityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.xs,
    marginBottom: SPACING.xxs,
  },
  submitBlock: {
    marginTop: SPACING.lg,
  },
  dividerRow: {
    marginVertical: SPACING.xl,
  },
  socialButton: {
    borderRadius: RADIUS.pill,
  },
  switcherRow: {
    marginTop: SPACING.xl,
  },
  switchLink: {
    fontWeight: '700',
    marginLeft: 2,
  },
  footerBlock: {
    marginTop: SPACING.xl,
  },
});

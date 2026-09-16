/**
 * Sign in, create an account, and the two ways in that do not need a password.
 *
 * ## Why one screen rather than two routes
 *
 * Signing in and signing up share every field but one, and a person who mistypes their
 * password wants the create-account option *beside* the field they just filled, not behind a
 * navigation. A `SegmentedControl` switches between them in place, which also means a failed
 * sign-in does not throw away the email the user typed.
 *
 * ## Validation happens before the request, and lands on the field
 *
 * Every rule the app can check for itself — a well-formed address, a password of the length
 * the backend enforces, a name on the account being created — is checked here, and the
 * sentence appears under the field it belongs to. A banner beside the submit button is where
 * a *server's* answer goes, because that is the only thing the user cannot have anticipated —
 * beside it rather than above the form, so an answer arriving does not move the fields or the
 * button that produced it. Field errors wait for a blur or a submit attempt: a field that
 * turns red while someone is still typing their address tells them they are wrong before they
 * have finished being right. The submit button is never disabled for an incomplete form,
 * because pressing it is what reveals those errors.
 *
 * ## Nothing from the SDK is shown as it arrived
 *
 * `readableAuthError` (see `./src/features/settings/auth-errors`) turns every failure into a
 * sentence. That includes the cases `describeAuthError` in the session provider does not
 * cover, and — more importantly — its `default:` branch, which would otherwise put
 * `Firebase: Error (auth/…)` on screen. The one deliberately vague message is the
 * wrong-password/unknown-account pair, which must stay indistinguishable: see the note in
 * that module.
 *
 * ## The keyboard is not allowed to hide the button
 *
 * `KeyboardAvoidingView` with `padding` on iOS, a scroll view that keeps taps alive, and a
 * `returnKeyType` that moves through the fields in order and submits from the last one. The
 * password-manager hints (`autoComplete`, `textContentType`) are set because the OS will not
 * offer to save or fill a credential it was not told about — and without them a user has to
 * retype a password they cannot see.
 *
 * ## The entrance is four steps, and none of them gate a tap
 *
 * This is the first screen every install shows, so it arrives in reading order rather than
 * hard-cutting from blank to fully-rendered: the masthead, then the form card, then the
 * secondary ways in, then the footnote. The delays are multiples of `motion.stagger` so the
 * rhythm matches the rest of the app rather than being tuned by eye here.
 *
 * Two things hold regardless of the animation. Every control is mounted and hit-testable from
 * the first frame — these primitives animate `opacity` and `transform` only, neither of which
 * affects hit testing, so a user who taps immediately is never waiting on motion. And a
 * reduced-motion user gets the finished screen, because `FadeIn`/`SlideUpIn` start at their
 * resting state and only move backwards once the accessibility query has come back `false`;
 * there is deliberately no `Animated` code in this file to undermine that.
 *
 * The block of secondary actions fades rather than slides. It is already inside the sliding
 * card, and a second translation on top of its parent's reads as the card arriving twice.
 *
 * ## What this screen deliberately does not do
 *
 * It does not check whether an email is already registered before trying to register it.
 * That answer is the server's, the call to get it is a second round trip, and asking early
 * is how an app leaks which addresses have accounts. It also does not offer any sign-in
 * method whose provider is not configured in this build: a button that can only fail is
 * worse than an absent one, which is what `googleAvailable` decides below.
 */

import { useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { readableAuthError } from '@features/settings/auth-errors';
import { useSession } from '@services';
import {
  BORDER_WIDTH,
  Button,
  Divider,
  FadeIn,
  IconButton,
  LAYOUT,
  Notice,
  RADIUS,
  Row,
  SPACING,
  SegmentedControl,
  SlideUpIn,
  Surface,
  Text,
  TextField,
  useTheme,
} from '@ui';

/** Which half of the screen is showing. */
type Mode = 'signIn' | 'signUp';

/**
 * Whether this build can complete a Google sign-in at all.
 *
 * Read from the environment rather than through `isGoogleSignInConfigured()` so the screen
 * does not pull the native Google module into its import graph — that module is absent in
 * Expo Go, and importing it there turns the whole sign-in screen into a red box.
 */
const googleAvailable = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim().length > 0;

/**
 * The shortest password the backend will accept.
 *
 * Firebase Auth enforces six characters; checking the same number here means the user is
 * told before a round trip rather than after one. Kept as one constant so the sign-up rule
 * and the field hint cannot drift apart.
 */
const MIN_PASSWORD_LENGTH = 6;

/**
 * A deliberately permissive address check.
 *
 * The one thing worth catching on the device is an address that cannot possibly be one — a
 * missing `@`, a stray space, a trailing dot. Anything stricter starts rejecting addresses
 * that are legal, and the authoritative answer is the server's either way.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function SignInScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn, signUp, signInWithGoogle, continueOffline, sendPasswordReset } = useSession();

  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  /** Which of the account actions is running, by name, so one spinner belongs to one button. */
  const [busy, setBusy] = useState<'submit' | 'google' | 'offline' | 'reset' | null>(null);
  /** The server's answer, shown above the form. Cleared on every new attempt and on submit. */
  const [formError, setFormError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  /** Fields the user has left, so an error waits until they have finished rather than interrupting. */
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  /** True once the form has been submitted, which shows every error at once. */
  const [attempted, setAttempted] = useState(false);

  // Focus chaining. Typing through a form with the keyboard's return key is the difference
  // between a form that feels native and one that feels like a web page in a shell.
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  /**
   * The messages for the fields, computed rather than stored.
   *
   * Derived from the values on every render so a corrected field clears itself the moment
   * the character that broke it is removed — a stored error string would need clearing by
   * hand at every keystroke, and one missed call site leaves a stale complaint on screen.
   */
  const emailProblem = (() => {
    const trimmed = email.trim();
    if (!trimmed) return 'Enter the email address for your account.';
    if (!EMAIL_PATTERN.test(trimmed)) return 'That does not look like an email address.';
    return null;
  })();

  const passwordProblem = (() => {
    if (!password) return 'Enter your password.';
    // Only on the way in: an existing account may predate the current minimum, and refusing
    // to submit its own correct password would lock someone out of their own data.
    if (mode === 'signUp' && password.length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    return null;
  })();

  const nameProblem =
    mode === 'signUp' && !displayName.trim() ? 'Enter the name to show on the account.' : null;

  /** Whether a field's error is allowed on screen yet. */
  const showProblem = useCallback(
    (field: string, problem: string | null): string | null =>
      problem && (attempted || touched[field]) ? problem : null,
    [attempted, touched],
  );

  const markTouched = useCallback((field: string) => {
    setTouched((current) => (current[field] ? current : { ...current, [field]: true }));
  }, []);

  // Pre-computed error visibility — one call per field instead of two in JSX, and the
  // variables are available to both the spread props and any conditional rendering above them.
  const nameError = showProblem('name', nameProblem);
  const emailError = showProblem('email', emailProblem);
  const passwordError = showProblem('password', passwordProblem);

  const switchMode = useCallback((next: Mode) => {
    setMode(next);
    // The alternative mode is a fresh question: an error about the last one, or a reset link
    // already sent, is about something the user is no longer doing.
    setFormError(null);
    setResetSent(false);
    setAttempted(false);
    setTouched({});
  }, []);

  const submit = useCallback(async () => {
    // The in-flight guard. The button is disabled while busy, but the keyboard's return key
    // is not a button and can fire twice on a laggy device — this is what makes the
    // no-double-submit requirement hold regardless of how the submit was triggered.
    if (busy) return;
    setAttempted(true);
    setFormError(null);
    setResetSent(false);

    if (emailProblem || passwordProblem || nameProblem) return;

    setBusy('submit');
    try {
      if (mode === 'signIn') {
        await signIn(email.trim(), password);
      } else {
        await signUp(email.trim(), password, displayName.trim());
      }
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
    setResetSent(false);

    // Checked here rather than by disabling the button: a disabled control with no stated
    // reason is a dead end, whereas this puts the reason under the field it is about.
    if (emailProblem) return;

    setBusy('reset');
    try {
      await sendPasswordReset(email.trim());
      setResetSent(true);
    } catch (caught) {
      setFormError(readableAuthError(caught));
    } finally {
      setBusy(null);
    }
  }, [busy, email, emailProblem, markTouched, sendPasswordReset]);

  const handleGoogleSignIn = useCallback(async () => {
    if (busy) return;
    setFormError(null);
    setResetSent(false);
    setBusy('google');
    try {
      // Native Google Sign-In, not a popup. Firebase's React Native build compiles
      // `signInWithPopup` out entirely, so the app gets an ID token from Google's own SDK and
      // exchanges it via `signInWithCredential` — see src/services/auth/google.ts.
      const signedIn = await signInWithGoogle();
      // `false` means the account chooser was dismissed. Navigating anyway would drop someone
      // who backed out into the app with no session.
      if (signedIn) router.replace('/(tabs)');
    } catch (caught) {
      setFormError(readableAuthError(caught));
    } finally {
      setBusy(null);
    }
  }, [busy, router, signInWithGoogle]);

  const handleOffline = useCallback(async () => {
    if (busy) return;
    setFormError(null);
    setResetSent(false);
    setBusy('offline');
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
      // `padding` on iOS only. Android resizes the window itself, and doing both double-counts
      // the keyboard's height — which is how a form ends up scrolling oddly on one platform.
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.layout.screenPadding,
          paddingTop: insets.top + theme.spacing.xxl,
          paddingBottom: insets.bottom + theme.spacing.colossal,
          flexGrow: 1,
          justifyContent: 'center',
        }}
        // Without this the first tap on a button only dismisses the keyboard, and the button
        // appears not to work.
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Step 1: the wordmark. The margin stays on the `Row` so the wrapper is purely a
            transform — moving it out here would change the spacing under reduced motion. */}
        <SlideUpIn>
          <Row gap="lg" align="center" style={[styles.masthead, { marginBottom: theme.spacing.xxl }]}>
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
                // The wordmark beside it already says the product's name, so the mark is
                // decoration to a screen reader rather than information.
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            </View>
            <View style={styles.flex}>
              <Text variant="title">{'Ddetect'}</Text>
              {/*
                What the app is for, not how it is built. This line read "Multi-source
                evidence consistency and cross-verification" — three compound nouns and no
                verb, on the first screen of an app a person has installed because a bank
                charged them for something they did not buy.
              */}
              <Text variant="caption" colorToken="textSecondary">
                Gather your documents and find where they disagree
              </Text>
            </View>
          </Row>
        </SlideUpIn>

        {/* Step 2: the form, one beat behind the wordmark. The whole card is one
            entrance — the fields arrive as a form to be filled, not as a list being
            assembled a row at a time. */}
        <SlideUpIn delay={theme.motion.stagger}>
          <Surface padding="xl" radius="xl" style={styles.formCard}>
            <View style={{ marginBottom: theme.spacing.lg }}>
              <SegmentedControl
                value={mode}
                onChange={(next) => switchMode(next as Mode)}
                options={[
                  { value: 'signIn', label: 'Sign in' },
                  { value: 'signUp', label: 'Create account' },
                ]}
              />
            </View>

            {/*
              Both notices used to sit here, above the fields. A failed sign-in therefore
              grew a three-line banner at the top of the card and pushed every field and the
              button itself down the screen — so the control the user had just pressed was no
              longer under their thumb, and on a short device the button they needed to press
              again had moved below the fold. They now render directly above that button,
              which is where the eye already is after a press, and nothing above them moves.
            */}
            <View style={{ gap: theme.spacing.lg }}>
              {mode === 'signUp' ? (
                <TextField
                  label="Full name"
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

              <TextField
                ref={emailRef}
                label="Email address"
                value={email}
                onChangeText={setEmail}
                onBlur={() => markTouched('email')}
                placeholder="you@domain.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                // Password follows email in both modes, so the return key always advances
                // rather than claiming to finish the form.
                returnKeyType="next"
                editable={!anyBusy}
                onSubmitEditing={() => passwordRef.current?.focus()}
                {...(emailError ? { error: emailError } : {})}
              />

              <TextField
                ref={passwordRef}
                label="Password"
                value={password}
                onChangeText={setPassword}
                onBlur={() => markTouched('password')}
                placeholder={
                  mode === 'signUp' ? `At least ${MIN_PASSWORD_LENGTH} characters` : 'Your password'
                }
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                // These two are what make the OS password manager offer to fill and to save.
                // `current-password` on the way in and `new-password` on the way up, so a
                // manager knows whether to offer an existing credential or generate one.
                autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                textContentType={mode === 'signIn' ? 'password' : 'newPassword'}
                returnKeyType="done"
                editable={!anyBusy}
                onSubmitEditing={() => void submit()}
                trailing={
                  <IconButton
                    icon={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                    // An eye toggle is the classic missed hit target, so the primitive's own
                    // 44pt square is used rather than a padded glyph inside an absolute view.
                    onPress={() => setShowPassword((current) => !current)}
                  />
                }
                {...(passwordError ? { error: passwordError } : {})}
              />
            </View>

            {mode === 'signIn' ? (
              <View style={styles.forgotRow}>
                <Button
                  label="Forgot your password?"
                  variant="ghost"
                  size="sm"
                  loading={busy === 'reset'}
                  disabled={anyBusy}
                  accessibilityHint="Sends a password reset link to the address above"
                  onPress={() => void resetPassword()}
                />
              </View>
            ) : null}

            {formError ? (
              <Notice
                tone="danger"
                icon="alert-circle-outline"
                title={bannerTitle}
                message={formError}
                onDismiss={() => setFormError(null)}
                style={{ marginBottom: theme.spacing.lg }}
              />
            ) : null}

            {resetSent ? (
              <Notice
                /*
                  `info`, not `ok`. `ok` is the app's settled-outcome tone, and a reset link
                  having been handed to an email provider is not a settled outcome — the user
                  still has to receive it, open it and choose a new password. Painting this
                  the same green as a finished result spends the one tone that means "done".
                */
                tone="info"
                icon="email-check-outline"
                title="Check your email"
                message={`If ${email.trim()} has a password account, a reset link is on its way. It can take a minute to arrive.`}
                onDismiss={() => setResetSent(false)}
                style={{ marginBottom: theme.spacing.lg }}
              />
            ) : null}

            <Button
              label={mode === 'signIn' ? 'Sign in' : 'Create account'}
              onPress={() => void submit()}
              variant="primary"
              size="lg"
              fullWidth
              /*
                `anyBusy` only. This was `disabled={!canSubmit}`, which greyed the one control
                on the screen out on first paint — before a single character had been typed,
                with nothing saying why, while the field errors that would have explained it
                were being suppressed as untouched. The reader was left pressing an inert
                button on the app's first screen.

                `submit` calls `setAttempted(true)` before it validates anything, so pressing
                it now reveals every field error at once and the reason arrives under the
                field it is about. The double-submit guard it used to carry is unaffected:
                `submit` returns early while `busy`, and `anyBusy` still disables the button.
              */
              disabled={anyBusy}
              loading={busy === 'submit'}
              style={{ marginTop: theme.spacing.xl }}
            />

            {/* Step 3: the ways in that are not the primary one. Grouped into a single
                entrance because they are one idea — "or not with a password" — and three
                separately-timed controls here would read as a queue forming. */}
            <FadeIn delay={theme.motion.stagger * 2}>
              <Row gap="lg" align="center" style={{ marginVertical: theme.spacing.xl }}>
                <View style={styles.flex}>
                  <Divider />
                </View>
                <Text variant="caption" colorToken="textTertiary" uppercase>
                  or
                </Text>
                <View style={styles.flex}>
                  <Divider />
                </View>
              </Row>

              {googleAvailable ? (
                <Button
                  label="Continue with Google"
                  icon="google"
                  variant="secondary"
                  fullWidth
                  disabled={anyBusy}
                  loading={busy === 'google'}
                  onPress={() => void handleGoogleSignIn()}
                />
              ) : null}

              <Button
                label="Continue without an account"
                icon="cellphone"
                variant="ghost"
                fullWidth
                disabled={anyBusy}
                loading={busy === 'offline'}
                accessibilityHint="Keeps your cases on this device only, with no email or password"
                onPress={() => void handleOffline()}
                style={{ marginTop: theme.spacing.sm }}
              />
            </FadeIn>
          </Surface>
        </SlideUpIn>

        {/* Step 4: the footnote. Last, and it says so — it is the only thing here the
            user is not being asked to act on.

            It was forty words long and three of them were "deterministic consistency
            checks", "provider key" and "AI suggestions" — a settings-page explanation and a
            liability hedge, in 12pt grey, under the first thing a person ever sees. What
            belongs here is the promise the product is making. How the readings are produced,
            and which of them are optional, is a question a user can only have after they
            have seen one, and Settings is where it is answered. */}
        <SlideUpIn delay={theme.motion.stagger * 3}>
          <Text
            variant="caption"
            colorToken="textTertiary"
            center
            style={styles.footer}
          >
            Your cases stay private to your account, and every conclusion links back to the
            document it came from.
          </Text>
        </SlideUpIn>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  masthead: {
    alignSelf: 'center',
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
    width: SPACING.huge,
    height: SPACING.huge,
  },
  // Half the app's content width, which is the measure onboarding's card and the home
  // screen's first-run block also take. It was a literal 440 — wider than a column of
  // form fields reads well at, and a fourth opinion about how wide a page is.
  formCard: {
    maxWidth: LAYOUT.maxContentWidth / 2,
    width: '100%',
    alignSelf: 'center',
  },
  forgotRow: {
    alignItems: 'flex-end',
    marginTop: SPACING.xxs,
  },
  // No `lineHeight` override: `TYPE.caption` carries its own, and 18 tightened it.
  footer: {
    marginTop: SPACING.xxl,
    maxWidth: LAYOUT.maxContentWidth / 2,
    alignSelf: 'center',
  },
});

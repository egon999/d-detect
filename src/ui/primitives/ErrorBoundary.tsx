/**
 * Root error boundary.
 *
 * The problem this solves is specific to release builds. In development a JavaScript error
 * raises a red box with a stack trace. In a release APK there is no red box: the error
 * propagates, React unmounts the tree, and the user is left looking at whatever was behind
 * it — which, during boot, is the native splash screen. The app appears to hang forever,
 * and the one piece of information that would explain it is thrown away.
 *
 * So this catches the error and *renders* it. Not a friendly "something went wrong" card —
 * the actual message and component stack, on screen, copyable. Being able to read the error
 * off the device is worth more than a polished failure state, because a failure state the
 * user cannot report is a bug that cannot be fixed.
 *
 * Deliberately no theme, no design tokens, no fonts: this must render even when the theme
 * provider is the thing that threw. Plain `View`, `Text`, hard-coded colours, system font.
 * A dependency here is a way for the error screen itself to fail.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  children: React.ReactNode;
  /** Shown above the error. Identifies which boundary caught it when there are several. */
  label?: string;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('[boundary] caught:', error.message);
  }

  private reset = () => {
    this.setState({ error: null, componentStack: null });
  };

  override render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <View style={styles.card}>
            <View style={styles.iconCircle}>
              {/*
                A literal ceiling, not the token — this file imports nothing by design (see the
                header), and a 52pt circle drawn around a 26pt glyph is the one box on this
                screen that cannot grow with it. Everything else here is inside a `ScrollView`
                and scales freely, which is what matters: the reader who needs this screen is
                reading an error message, not a decorative exclamation mark.
              */}
              <Text style={styles.iconText} maxFontSizeMultiplier={1.4}>
                !
              </Text>
            </View>

            <Text style={styles.title}>This screen stopped working</Text>
            <Text style={styles.subtitle}>
              Your cases and the evidence you have added are saved and unaffected. Try the screen again — if it stops
              again, the details below say why.
            </Text>

            {this.props.label ? (
              <Text style={styles.label}>Context: {this.props.label}</Text>
            ) : null}

            <View style={styles.errorBox}>
              <Text style={styles.message} numberOfLines={4} selectable>
                {error.message || 'No further detail was recorded.'}
              </Text>
            </View>

            <TouchableOpacity
              style={styles.primaryButton}
              onPress={this.reset}
              activeOpacity={0.8}
              // `TouchableOpacity` marks itself accessible but names no role, so this
              // announced as plain text on the one screen whose entire purpose is to offer
              // the reader a way out.
              accessibilityRole="button"
              accessibilityLabel="Try this screen again"
            >
              <Text style={styles.primaryButtonText}>Try this screen again</Text>
            </TouchableOpacity>

            {componentStack ? (
              <View style={styles.traceContainer}>
                <Text style={styles.traceTitle}>Technical detail</Text>
                <Text style={styles.mono} selectable numberOfLines={6}>
                  {componentStack.trim()}
                </Text>
              </View>
            ) : null}
          </View>
        </ScrollView>
      </View>
    );
  }
}

/*
  Every value below is a literal copy of the dark palette in `src/ui/tokens.ts` — royal990,
  royal950, royal880, royal800, the amber `warn` tone, `cta`, `text`, `textSecondary`,
  `textTertiary`. Copied rather than imported, and that is the point of this file: it must
  render when the theme provider is what threw, so it cannot depend on anything. Keeping the
  values identical means the one screen a user sees when the app breaks is at least the same
  app as the one that broke.
*/
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#070D21',
  },
  scroll: {
    flexGrow: 1,
    padding: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: '#0E1836',
    borderRadius: 16,
    padding: 24,
    borderWidth: 1,
    borderColor: '#16224A',
    alignItems: 'center',
  },
  iconCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(245, 158, 11, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.30)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  iconText: {
    color: '#FBBF24',
    fontSize: 26,
    fontWeight: '700',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#EEF3FF',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    color: '#AFC0E0',
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 16,
  },
  label: {
    fontSize: 12,
    color: '#8394B8',
    marginBottom: 12,
  },
  errorBox: {
    width: '100%',
    backgroundColor: '#040814',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#16224A',
  },
  message: {
    fontSize: 13,
    color: '#AFC0E0',
    lineHeight: 18,
    fontFamily: 'monospace',
  },
  primaryButton: {
    width: '100%',
    backgroundColor: '#2B5FD9',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  traceContainer: {
    width: '100%',
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#16224A',
  },
  traceTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8394B8',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  mono: {
    fontSize: 11,
    color: '#8394B8',
    lineHeight: 16,
    fontFamily: 'monospace',
  },
});

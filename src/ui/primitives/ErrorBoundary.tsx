import React from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  children: React.ReactNode;

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

    console.error('[boundary] caught:', this.props.label ?? 'unlabelled', error.message, info.componentStack ?? '');
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
              {}
              <Text style={styles.iconText} maxFontSizeMultiplier={1.4}>
                !
              </Text>
            </View>

            <Text style={styles.title}>This screen stopped working</Text>
            <Text style={styles.subtitle}>
              Nothing you have saved is affected. Try it again — if it stops a second time, close the app and reopen it.
            </Text>

            {this.props.label ? <Text style={styles.label}>{this.props.label}</Text> : null}

            <TouchableOpacity
              style={styles.primaryButton}
              onPress={this.reset}
              activeOpacity={0.8}

              accessibilityRole="button"
              accessibilityLabel="Try this screen again"
            >
              <Text style={styles.primaryButtonText}>Try this screen again</Text>
            </TouchableOpacity>

            {}
            {__DEV__ ? (
              <View style={styles.traceContainer}>
                <Text style={styles.traceTitle}>Development detail</Text>
                <Text style={styles.mono} selectable>
                  {error.message || 'No message on the error.'}
                </Text>
                {componentStack ? (
                  <Text style={[styles.mono, styles.traceStack]} selectable numberOfLines={12}>
                    {componentStack.trim()}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </ScrollView>
      </View>
    );
  }
}

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
    marginBottom: 20,
    textAlign: 'center',
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
  traceStack: {
    marginTop: 8,
  },
});

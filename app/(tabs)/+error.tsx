import type { ErrorBoundaryProps } from 'expo-router';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ErrorState, Row, Surface, errorDetail, readableError, useTheme } from '@ui';

export default function TabsRouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const theme = useTheme();
  const router = useRouter();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.canvas }]}>
      <Surface padding="xl" radius="xl" style={styles.card}>
        <ErrorState
          title="Screen encountered an issue"
          message={readableError(error, 'An unexpected error occurred while displaying this tab.')}
          detail={errorDetail(error)}
          onRetry={retry}
          retryLabel="Try again"
        />
        <Row gap="sm" style={styles.actions}>
          <Button
            label="Return Home"
            variant="primary"
            icon="home"
            onPress={() => router.replace('/(tabs)')}
          />
        </Row>
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    alignItems: 'center',
  },
  actions: {
    marginTop: 16,
    justifyContent: 'center',
  },
});

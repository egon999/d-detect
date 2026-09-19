import type { ErrorBoundaryProps } from 'expo-router';
import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, ErrorState, Row, Surface, errorDetail, readableError, useTheme } from '@ui';

export default function CaseRouteErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const theme = useTheme();
  const router = useRouter();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.canvas }]}>
      <Surface padding="xl" radius="xl" style={styles.card}>
        <ErrorState
          title="Case view encountered an issue"
          message={readableError(error, 'An unexpected error occurred while displaying this case.')}
          detail={errorDetail(error)}
          onRetry={retry}
          retryLabel="Try again"
        />
        <Row gap="sm" style={styles.actions}>
          <Button
            label="Go back"
            variant="secondary"
            icon="arrow-left"
            onPress={() => router.back()}
          />
          <Button
            label="All cases"
            variant="ghost"
            icon="folder-outline"
            onPress={() => router.replace('/cases')}
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

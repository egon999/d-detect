import { Stack as RouterStack, useRouter } from 'expo-router';
import React from 'react';

import { Button, Screen, Stack, Surface, Text, useTheme } from '@ui';

export default function NotFoundScreen() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <Screen style={{ alignItems: 'center', justifyContent: 'center' }}>
      <RouterStack.Screen options={{ title: 'Page not found' }} />
      <Surface
        padding="xl"
        radius="xl"
        style={{ width: '100%', maxWidth: theme.layout.maxContentWidth, alignItems: 'center' }}
      >
        <Stack gap="xl" align="center">
          <Stack gap="xs" align="center">
            {}
            <Text variant="title" center>
              This page is not here
            </Text>
            <Text variant="bodySmall" colorToken="textSecondary" center>
              The link may be out of date, or whatever it pointed to may have been deleted.
            </Text>
          </Stack>

          <Button
            label="Go to Daybook"
            variant="primary"
            icon="home"
            onPress={() => router.replace('/(tabs)')}
            accessibilityHint="Open the daybook, where your records are"
          />
        </Stack>
      </Surface>
    </Screen>
  );
}

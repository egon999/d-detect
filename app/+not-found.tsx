import { useRouter, Stack } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Surface, Text, useTheme } from '@ui';

export default function NotFoundScreen() {
  const theme = useTheme();
  const router = useRouter();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.canvas }]}>
      <Stack.Screen options={{ title: 'Page not found' }} />
      <Surface padding="xl" radius="xl" style={styles.card}>
        {/*
          This was a `display`-sized "404". An HTTP status code is a fact about a web server,
          and the person reading it is here to work on a dispute — so the largest text on the
          screen said nothing they could use. The same space now carries the actual message.
        */}
        <Text variant="title" center>
          This page is not here
        </Text>
        <Text
          variant="bodySmall"
          colorToken="textSecondary"
          center
          style={{ marginTop: theme.spacing.xs, marginBottom: theme.spacing.xl }}
        >
          The link may be out of date, or the record it pointed to may have been deleted. Your
          cases and evidence are unaffected — go back to your cases and open it from there.
        </Text>

        <Button
          label="Return to Dashboard"
          variant="primary"
          icon="home"
          onPress={() => router.replace('/(tabs)')}
        />
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
    maxWidth: 400,
    alignItems: 'center',
  },
});

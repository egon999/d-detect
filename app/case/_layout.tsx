import { Stack } from 'expo-router';
import React from 'react';

export default function CaseRootLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: 'default',
      }}
    />
  );
}

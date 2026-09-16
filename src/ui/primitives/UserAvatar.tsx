import React, { useState, useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Text } from './Text';
import { useTheme } from '../theme';
import { accountInitials } from '@services/auth/account';

export interface UserAvatarProps {
  photoURL?: string | null;
  displayName?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function UserAvatar({ photoURL, displayName, size = 44, style }: UserAvatarProps) {
  const theme = useTheme();
  const [loadError, setLoadError] = useState(false);

  // Normalize photoURL: upgrade http to https, and clean trailing spaces
  const normalizedUrl = React.useMemo(() => {
    if (!photoURL) return null;
    let url = photoURL.trim();
    if (url.startsWith('http://')) {
      url = 'https://' + url.slice(7);
    }
    return url;
  }, [photoURL]);

  useEffect(() => {
    setLoadError(false);
  }, [normalizedUrl]);

  const initials = accountInitials(displayName || 'User');
  const borderRadius = Math.round(size / 2);

  if (normalizedUrl && !loadError) {
    return (
      <View
        style={[
          styles.container,
          {
            width: size,
            height: size,
            borderRadius,
            backgroundColor: theme.colors.surfaceRaised,
            borderColor: theme.colors.border,
          },
          style,
        ]}
      >
        <ExpoImage
          source={{ uri: normalizedUrl }}
          style={{ width: size, height: size, borderRadius }}
          contentFit="cover"
          cachePolicy="disk"
          transition={200}
          onError={() => setLoadError(true)}
          accessibilityLabel={`${displayName || 'User'}'s avatar`}
        />
      </View>
    );
  }

  // Fallback to high-fidelity initials avatar
  return (
    <View
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius,
          backgroundColor: theme.colors.accentSurface,
          borderColor: theme.colors.accent,
        },
        style,
      ]}
      accessibilityLabel={`${displayName || 'User'}'s avatar`}
    >
      {/*
        No `fontWeight`. With the Plus Jakarta families loaded, weight has to come from the
        `fontFamily` the variant selects — `label` is already SemiBold, `title` already
        Bold. Setting `fontWeight: '700'` on top of that made Android synthesise a fake
        bold over an already-weighted face, which smears the two initials this component
        exists to render. See `src/ui/primitives/Text.tsx`.
      */}
      <Text variant={size >= 56 ? 'title' : 'label'} style={{ color: theme.colors.accent }}>
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1,
  },
});

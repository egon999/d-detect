import React, { useState, useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Icon } from '../icon';
import { Text } from './Text';
import { useTheme } from '../theme';
import { CONTROL_SCALE_CAP } from '../tokens';
import { accountInitials, hasPersonalName, personalName } from '@services/auth/account';

export interface UserAvatarProps {
  photoURL?: string | null;
  displayName?: string | null;
  size?: number;
  style?: StyleProp<ViewStyle>;
}

export function UserAvatar({ photoURL, displayName, size = 44, style }: UserAvatarProps) {
  const theme = useTheme();
  const [loadError, setLoadError] = useState(false);

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

  const name = personalName(displayName);
  const named = hasPersonalName(displayName);
  const initials = accountInitials(displayName);
  const borderRadius = Math.round(size / 2);

  const label = named ? `${name}'s avatar` : 'Your avatar';

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
          accessibilityLabel={label}
        />
      </View>
    );
  }

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
      accessibilityLabel={label}
    >
      {named ? (

        <Text
          variant={size >= 56 ? 'title' : 'label'}
          style={{ color: theme.colors.accent }}
          maxFontSizeMultiplier={CONTROL_SCALE_CAP}
        >
          {initials}
        </Text>
      ) : (

        <Icon name="account-circle-outline" size={Math.round(size * 0.58)} color={theme.colors.accent} />
      )}
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

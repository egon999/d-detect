import React, { useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';

import { useTheme } from '../theme';
import { CONTROL_SCALE_CAP, FONT_FAMILY, RADIUS, SPACING } from '../tokens';
import { Pressable, Row } from './Layout';
import { Text } from './Text';
import { useReducedMotion } from './Motion';

export interface GooglePillButtonProps {
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  label?: string;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

const GOOGLE_LOGO_URI =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="%23EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="%234285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="%23FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="%2334A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

function OfficialGoogleLogo({ size = 20 }: { size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        justifyContent: 'center',
        alignItems: 'center',
      }}
      accessible={false}
      importantForAccessibility="no"
    >
      <Image
        source={{ uri: GOOGLE_LOGO_URI }}
        style={{ width: size, height: size }}
        contentFit="contain"
        priority="high"
      />
    </View>
  );
}

export function GooglePillButton({
  onPress,
  loading = false,
  disabled = false,
  label = 'Continue with Google',
  fullWidth = true,
  style,
  textStyle,
  accessibilityLabel,
  accessibilityHint = 'Uses your official Google account to sign in securely',
  testID = 'google-sign-in-pill',
}: GooglePillButtonProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = () => {
    if (disabled || loading) return;
    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    if (reduced) return;
    Animated.timing(scaleAnim, {
      toValue: 0.97,
      duration: 120,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    if (reduced) return;
    Animated.spring(scaleAnim, {
      toValue: 1,
      damping: 18,
      stiffness: 300,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View
      style={[
        fullWidth ? styles.fullWidth : styles.fitContent,
        { transform: [{ scale: scaleAnim }] },
        style,
      ]}
    >
      <Pressable
        testID={testID}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled || loading}
        pressScale={0}
        noDisabledOpacity
        focusRingRadius={RADIUS.pill}
        haptic={false}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: disabled || loading, busy: loading }}
        style={[
          styles.container,
          disabled && styles.disabledContainer,
        ]}
      >
        <Row
          gap="md"
          align="center"
          justify="center"
          style={loading ? styles.hiddenContent : styles.contentRow}
        >
          <View style={styles.iconWrapper}>
            <OfficialGoogleLogo size={20} />
          </View>

          <Text
            variant="bodyMedium"
            style={[
              styles.labelText,
              disabled && styles.disabledLabelText,
              textStyle,
            ]}
            maxFontSizeMultiplier={CONTROL_SCALE_CAP}
          >
            {label}
          </Text>
        </Row>

        {loading ? (
          <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
            <View style={styles.spinnerContainer}>
              <ActivityIndicator
                size="small"
                color="#4285F4"
                accessibilityLabel="Signing in with Google"
              />
            </View>
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fullWidth: {
    width: '100%',
  },
  fitContent: {
    alignSelf: 'flex-start',
  },
  container: {
    height: 52,
    minHeight: 52,
    borderRadius: RADIUS.pill,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DADCE0',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 5,
    elevation: 3,
  },
  disabledContainer: {
    backgroundColor: '#F1F3F4',
    borderColor: '#E8EAED',
    shadowOpacity: 0,
    elevation: 0,
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapper: {
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelText: {
    color: '#1F1F1F',
    fontFamily: FONT_FAMILY.sansMedium,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  disabledLabelText: {
    color: '#9AA0A6',
  },
  hiddenContent: {
    opacity: 0,
  },
  spinnerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

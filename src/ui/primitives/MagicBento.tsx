import React from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { FONT_FAMILY } from '../tokens';
import { Text } from './Text';

export interface BentoCardProps {
  title: string;
  subtitle?: string;
  label?: string;
  icon?: React.ReactNode;
  rightAction?: React.ReactNode;
  children?: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  glowColor?: string;
  badgeColor?: string;
}

export function BentoCard({
  title,
  subtitle,
  label,
  icon,
  rightAction,
  children,
  onPress,
  style,
  glowColor = '#2B5FD9',
  badgeColor = '#00F0FF',
}: BentoCardProps) {
  const scaleAnim = React.useRef(new Animated.Value(1)).current;
  const borderGlow = React.useRef(new Animated.Value(0.35)).current;

  const handlePressIn = () => {
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 0.97,
        friction: 7,
        tension: 400,
        useNativeDriver: true,
      }),
      Animated.timing(borderGlow, {
        toValue: 0.9,
        duration: 150,
        useNativeDriver: false,
      }),
    ]).start();

    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  };

  const handlePressOut = () => {
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1,
        friction: 7,
        tension: 300,
        useNativeDriver: true,
      }),
      Animated.timing(borderGlow, {
        toValue: 0.35,
        duration: 300,
        useNativeDriver: false,
      }),
    ]).start();
  };

  const Wrapper = onPress ? Pressable : View;

  return (
    <Animated.View style={[{ transform: [{ scale: scaleAnim }] }, style]}>
      <Wrapper
        onPress={onPress}
        onPressIn={onPress ? handlePressIn : undefined}
        onPressOut={onPress ? handlePressOut : undefined}
        accessible
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={`${label ? `${label}, ` : ''}${title}${subtitle ? `. ${subtitle}` : ''}`}
        style={styles.card}
      >
        {}
        <LinearGradient
          colors={['#0C1635', '#091228', '#060B1C']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />

        {}
        <View
          pointerEvents="none"
          style={[
            styles.cornerGlow,
            { backgroundColor: glowColor },
          ]}
        />

        {}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.borderRing,
            {
              borderColor: badgeColor,
              opacity: borderGlow,
            },
          ]}
        />

        {}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            {icon ? <View style={styles.iconSlot}>{icon}</View> : null}
            {label ? (
              <View style={[styles.badge, { borderColor: badgeColor }]}>
                <Text style={[styles.badgeText, { color: badgeColor }]}>
                  {label}
                </Text>
              </View>
            ) : null}
          </View>
          {rightAction ? <View>{rightAction}</View> : null}
        </View>

        {}
        <View style={styles.body}>
          <Text style={styles.title}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>

        {}
        {children ? <View style={styles.extra}>{children}</View> : null}
      </Wrapper>
    </Animated.View>
  );
}

export function BentoGrid({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.grid, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  grid: {
    gap: 12,
  },
  card: {
    position: 'relative',
    borderRadius: 20,
    overflow: 'hidden',
    padding: 18,
    minHeight: 120,
    justifyContent: 'space-between',
    backgroundColor: '#0A1329',
  },
  cornerGlow: {
    position: 'absolute',
    top: -40,
    right: -40,
    width: 130,
    height: 130,
    borderRadius: 65,
    opacity: 0.18,
  },
  borderRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 20,
    borderWidth: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
    zIndex: 2,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconSlot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(43, 95, 217, 0.25)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
    backgroundColor: 'rgba(0, 240, 255, 0.08)',
  },
  badgeText: {
    fontFamily: FONT_FAMILY.monoMedium,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  body: {
    zIndex: 2,
    gap: 4,
  },
  title: {
    fontFamily: FONT_FAMILY.sansBold,
    fontSize: 16,
    lineHeight: 22,
    color: '#FFFFFF',
  },
  subtitle: {
    fontFamily: FONT_FAMILY.sansRegular,
    fontSize: 13,
    lineHeight: 18,
    color: '#A0B4D8',
  },
  extra: {
    marginTop: 12,
    zIndex: 2,
  },
});

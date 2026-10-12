import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Icon, type IconName } from '../icon';
import { FONT_FAMILY } from '../tokens';
import { useReducedMotion } from './Motion';

export interface AIChatComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  isListening?: boolean;
  onToggleVoice?: () => void;
  isBusy?: boolean;
  placeholder?: string;
  onAttach?: () => void;
  style?: StyleProp<ViewStyle>;
  maxLength?: number;
}

export function AIChatComposer({
  value,
  onChangeText,
  onSubmit,
  isListening = false,
  onToggleVoice,
  isBusy = false,
  placeholder = 'Ask anything about your timeline, expenses, meetings...',
  onAttach,
  style,
  maxLength = 500,
}: AIChatComposerProps) {
  const reduced = useReducedMotion();
  const [isFocused, setIsFocused] = useState(false);

  const focusRingAnim = useRef(new Animated.Value(0)).current;
  const pulseMicAnim = useRef(new Animated.Value(1)).current;
  const sendScaleAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(focusRingAnim, {
      toValue: isFocused ? 1 : 0,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [isFocused, focusRingAnim]);

  useEffect(() => {
    if (!isListening || reduced) {
      pulseMicAnim.setValue(1);
      return;
    }

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseMicAnim, {
          toValue: 1.35,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulseMicAnim, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();

    return () => pulse.stop();
  }, [isListening, reduced, pulseMicAnim]);

  const handleSendPress = () => {
    if (!value.trim() || isBusy) return;
    Animated.sequence([
      Animated.spring(sendScaleAnim, {
        toValue: 0.85,
        friction: 6,
        tension: 400,
        useNativeDriver: true,
      }),
      Animated.spring(sendScaleAnim, {
        toValue: 1,
        friction: 6,
        tension: 300,
        useNativeDriver: true,
      }),
    ]).start();

    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    onSubmit();
  };

  const handleVoicePress = () => {
    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    onToggleVoice?.();
  };

  const borderColor = focusRingAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(58, 134, 255, 0.25)', '#00F0FF'],
  });

  const canSend = value.trim().length > 0 && !isBusy;

  return (
    <Animated.View
      style={[
        styles.container,
        { borderColor },
        style,
      ]}
    >
      {}
      <LinearGradient
        colors={['#0C1635', '#081026', '#060B1C']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />

      {}
      {onAttach && (
        <Pressable
          onPress={onAttach}
          accessibilityLabel="Attach document or record"
          style={({ pressed }) => [styles.sideBtn, pressed && styles.btnPressed]}
        >
          <Icon name="paperclip" size={20} color="#7B92B8" />
        </Pressable>
      )}

      {}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={isListening ? 'Listening... Speak now' : placeholder}
        placeholderTextColor="#5C7299"
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        onSubmitEditing={onSubmit}
        multiline
        maxLength={maxLength}
        style={styles.input}
        returnKeyType="send"
      />

      {}
      {onToggleVoice && (
        <View style={styles.voiceWrapper}>
          {isListening && (
            <Animated.View
              style={[
                styles.pulseRing,
                { transform: [{ scale: pulseMicAnim }] },
              ]}
            />
          )}
          <Pressable
            onPress={handleVoicePress}
            accessibilityLabel={isListening ? 'Stop voice listening' : 'Start voice input'}
            style={({ pressed }) => [
              styles.micBtn,
              isListening && styles.micBtnActive,
              pressed && styles.btnPressed,
            ]}
          >
            <Icon
              name={isListening ? 'microphone' : 'microphone-outline'}
              size={20}
              color={isListening ? '#00F0FF' : '#7B92B8'}
            />
          </Pressable>
        </View>
      )}

      {}
      <Animated.View style={{ transform: [{ scale: sendScaleAnim }] }}>
        <Pressable
          onPress={handleSendPress}
          disabled={!canSend}
          accessibilityLabel="Send question"
          style={({ pressed }) => [
            styles.sendBtn,
            canSend && styles.sendBtnReady,
            pressed && canSend && styles.btnPressed,
          ]}
        >
          {isBusy ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Icon
              name="arrow-up"
              size={20}
              color={canSend ? '#FFFFFF' : '#455A7E'}
            />
          )}
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 26,
    borderWidth: 1.5,
    paddingHorizontal: 8,
    paddingVertical: 6,
    overflow: 'hidden',
    minHeight: 52,
    gap: 6,
    backgroundColor: '#0A1329',
  },
  input: {
    flex: 1,
    fontFamily: FONT_FAMILY.sansRegular,
    fontSize: 15,
    color: '#F0F4FF',
    paddingVertical: 6,
    paddingHorizontal: 8,
    maxHeight: 100,
  },
  sideBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
  },
  voiceWrapper: {
    position: 'relative',
    width: 38,
    height: 38,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1.5,
    borderColor: 'rgba(0, 240, 255, 0.5)',
    backgroundColor: 'rgba(0, 240, 255, 0.1)',
  },
  micBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  micBtnActive: {
    backgroundColor: 'rgba(0, 240, 255, 0.15)',
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(58, 134, 255, 0.2)',
  },
  sendBtnReady: {
    backgroundColor: '#2B5FD9',
  },
  btnPressed: {
    opacity: 0.8,
  },
});

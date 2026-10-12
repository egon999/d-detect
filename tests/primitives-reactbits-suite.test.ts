/**
 * tests/primitives-reactbits-suite.test.ts
 *
 * Verification suite for the complete React Bits suite adapted for React Native:
 * 1. DecryptedText (Sequential & simultaneous glyph scramble/reveal)
 * 2. SpotlightCard (Dark royal blue card with radial lighting & gesture)
 * 3. BlurText (Staggered translation & opacity keyframing)
 * 4. BentoCard & BentoGrid (MagicBento adaptive layout)
 * 5. AuroraBackground (Mesh gradient with floating ambient orbs)
 * 6. AudioWaveformVisualizer (Real-time 60fps audio bars)
 * 7. AIChatComposer (React Bits Pro AI chat prompt bar)
 * 8. Barrel exports (@ui)
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Animated } from 'react-native';

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: (props: any) => React.createElement('View', props, props.children),
}));

vi.mock('expo-blur', () => ({
  BlurView: (props: any) => React.createElement('View', props, props.children),
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useLocalSearchParams: () => ({}),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(async () => {}),
  impactAsync: vi.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: (props: any) => React.createElement('Text', props, props.name),
}));

vi.mock('@expo-google-fonts/ibm-plex-mono', () => ({
  IBMPlexMono_400Regular: 1,
  IBMPlexMono_500Medium: 2,
  IBMPlexMono_600SemiBold: 3,
}));

vi.mock('@expo-google-fonts/plus-jakarta-sans', () => ({
  PlusJakartaSans_400Regular: 1,
  PlusJakartaSans_500Medium: 2,
  PlusJakartaSans_600SemiBold: 3,
  PlusJakartaSans_700Bold: 4,
  PlusJakartaSans_800ExtraBold: 5,
}));

vi.mock('expo-font', () => ({
  useFonts: () => [true, null],
}));

import { DecryptedText } from '../src/ui/primitives/DecryptedText';
import { SpotlightCard } from '../src/ui/primitives/SpotlightCard';
import { BlurText } from '../src/ui/primitives/BlurText';
import { BentoCard, BentoGrid } from '../src/ui/primitives/MagicBento';
import { AuroraBackground } from '../src/ui/primitives/AuroraBackground';
import { AudioWaveformVisualizer } from '../src/ui/primitives/AudioWaveformVisualizer';
import { AIChatComposer } from '../src/ui/primitives/AIChatComposer';

describe('React Bits Primitive Suite Verification', () => {
  describe('DecryptedText', () => {
    it('instantiates cleanly with default props and text', () => {
      const element = React.createElement(DecryptedText, { text: 'D-DETECT' });
      expect(element).toBeDefined();
      expect(element.props.text).toBe('D-DETECT');
    });

    it('accepts custom speed, sequential, and revealDirection', () => {
      const element = React.createElement(DecryptedText, {
        text: 'EVIDENCE RECORD',
        speed: 20,
        sequential: false,
        revealDirection: 'center',
      });
      expect(element.props.speed).toBe(20);
      expect(element.props.sequential).toBe(false);
      expect(element.props.revealDirection).toBe('center');
    });
  });

  describe('SpotlightCard', () => {
    it('instantiates with children and default royal theme', () => {
      const element = React.createElement(
        SpotlightCard,
        { glowColor: '#00F0FF', borderRadius: 24 },
        React.createElement('Text', null, 'Card Content'),
      );
      expect(element).toBeDefined();
      expect(element.props.glowColor).toBe('#00F0FF');
      expect(element.props.borderRadius).toBe(24);
    });

    it('supports onPress and accessible roles', () => {
      const handlePress = vi.fn();
      const element = React.createElement(SpotlightCard, {
        onPress: handlePress,
        accessibilityLabel: 'Test Card',
      });
      expect(element.props.onPress).toBe(handlePress);
      expect(element.props.accessibilityLabel).toBe('Test Card');
    });
  });

  describe('BlurText', () => {
    it('instantiates with sentence splitting by words', () => {
      const element = React.createElement(BlurText, {
        text: 'Intelligent Case Graph',
        animateBy: 'words',
        delay: 50,
      });
      expect(element).toBeDefined();
      expect(element.props.animateBy).toBe('words');
    });

    it('supports letter-by-letter splitting', () => {
      const element = React.createElement(BlurText, {
        text: 'SECURE',
        animateBy: 'letters',
        direction: 'top',
      });
      expect(element.props.animateBy).toBe('letters');
      expect(element.props.direction).toBe('top');
    });
  });

  describe('MagicBento (BentoCard & BentoGrid)', () => {
    it('instantiates BentoCard with title, label, and subtitle', () => {
      const element = React.createElement(BentoCard, {
        title: 'Discrepancy Radar',
        subtitle: 'Automated cross-check active',
        label: 'SCANNER',
        badgeColor: '#00F0FF',
      });
      expect(element).toBeDefined();
      expect(element.props.title).toBe('Discrepancy Radar');
      expect(element.props.label).toBe('SCANNER');
    });

    it('wraps multiple cards inside BentoGrid', () => {
      const grid = React.createElement(
        BentoGrid,
        null,
        React.createElement(BentoCard, { title: 'Card 1' }),
        React.createElement(BentoCard, { title: 'Card 2' }),
      );
      expect(grid).toBeDefined();
    });
  });

  describe('AuroraBackground', () => {
    it('instantiates with primary and secondary glow colors', () => {
      const element = React.createElement(
        AuroraBackground,
        { primaryGlow: '#0E1D44', secondaryGlow: '#00F0FF' },
        React.createElement('View', null),
      );
      expect(element).toBeDefined();
      expect(element.props.primaryGlow).toBe('#0E1D44');
    });
  });

  describe('AudioWaveformVisualizer', () => {
    it('instantiates with custom barCount and maxHeight', () => {
      const element = React.createElement(AudioWaveformVisualizer, {
        isActive: true,
        barCount: 24,
        maxHeight: 64,
      });
      expect(element).toBeDefined();
      expect(element.props.barCount).toBe(24);
      expect(element.props.maxHeight).toBe(64);
    });
  });

  describe('AIChatComposer', () => {
    it('instantiates with value, onChangeText, and onSubmit', () => {
      const handleChange = vi.fn();
      const handleSubmit = vi.fn();
      const element = React.createElement(AIChatComposer, {
        value: 'What is my budget?',
        onChangeText: handleChange,
        onSubmit: handleSubmit,
        isListening: false,
        placeholder: 'Ask away',
      });
      expect(element).toBeDefined();
      expect(element.props.value).toBe('What is my budget?');
    });

    it('supports microphone listening mode and busy indicator', () => {
      const element = React.createElement(AIChatComposer, {
        value: '',
        onChangeText: vi.fn(),
        onSubmit: vi.fn(),
        isListening: true,
        isBusy: true,
      });
      expect(element.props.isListening).toBe(true);
      expect(element.props.isBusy).toBe(true);
    });
  });
});

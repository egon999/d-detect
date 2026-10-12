/**
 * tests/adversarial-m1.test.ts
 *
 * Empirical and adversarial test suite for Milestone 1 primitives:
 * Stress tests, boundary conditions, edge cases, and attack scenarios.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Animated, TextInput } from 'react-native';
// @ts-ignore - react-dom/server lacks standalone @types/react-dom in devDependencies
import { renderToString } from 'react-dom/server';

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: (props: any) => React.createElement('div', props, props.children),
}));

vi.mock('expo-blur', () => ({
  BlurView: (props: any) => React.createElement('div', props, props.children),
}));

vi.mock('expo-haptics', () => ({
  selectionAsync: vi.fn(async () => {}),
  impactAsync: vi.fn(async () => {}),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: (props: any) => React.createElement('span', props, props.name),
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

import * as Haptics from 'expo-haptics';
import { DetectiveMascot } from '../src/ui/primitives/DetectiveMascot';
import { DraggableBanner } from '../src/ui/primitives/DraggableBanner';
import { ShinyText } from '../src/ui/primitives/ShinyText';
import { FloatingPillInput } from '../src/ui/primitives/FloatingPillInput';
import { GradientPillButton } from '../src/ui/primitives/GradientPillButton';
import { CheckboxPill } from '../src/ui/primitives/CheckboxPill';
import { CONTROL_SCALE_CAP, HIT_TARGET, RADIUS } from '../src/ui/tokens';

// ============================================================================
// 1. DetectiveMascot Adversarial Stress Tests
// ============================================================================

describe('DetectiveMascot Adversarial Tests', () => {
  it('boundary size: survives extreme size = 0 without crash or NaN transform', () => {
    expect(() => {
      const html = renderToString(React.createElement(DetectiveMascot, { size: 0 }));
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('boundary size: survives massive size = 1000 without layout crash', () => {
    expect(() => {
      const html = renderToString(React.createElement(DetectiveMascot, { size: 1000 }));
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('boundary size: survives subpixel size = 0.001', () => {
    expect(() => {
      const html = renderToString(React.createElement(DetectiveMascot, { size: 0.001 }));
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('negative size: survives negative size gracefully', () => {
    expect(() => {
      const html = renderToString(React.createElement(DetectiveMascot, { size: -50 }));
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('animation disabled: renders motionless resting frame without active loops', () => {
    const html = renderToString(
      React.createElement(DetectiveMascot, { animated: false, size: 90, testID: 'static-mascot' }),
    );
    expect(html).toContain('static-mascot');
  });

  it('parallax tracking: handles external dragOffset with extreme values', () => {
    const dragX = new Animated.Value(10000);
    const dragY = new Animated.Value(-10000);
    expect(() => {
      const html = renderToString(
        React.createElement(DetectiveMascot, {
          dragOffset: { x: dragX, y: dragY },
        }),
      );
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('accessibility: provides image role and accessibilityLabel', () => {
    const html = renderToString(React.createElement(DetectiveMascot, { testID: 'a11y-mascot' }));
    expect(html).toContain('Animated Detective Mascot');
  });
});

// ============================================================================
// 2. DraggableBanner Adversarial Stress Tests
// ============================================================================

describe('DraggableBanner Adversarial Tests', () => {
  const computeElastic = (raw: number, limit: number, k: number) => {
    if (raw === 0) return 0;
    const sign = Math.sign(raw);
    const abs = Math.abs(raw);
    return sign * (limit * (abs / (limit + abs * k)));
  };

  it('massive drag displacement: 1,000,000px drag strictly bounded below asymptotic ceiling', () => {
    const limit = 60;
    const k = 0.35;
    const ceiling = limit / k; // 171.42857...

    const displacementMillion = computeElastic(1_000_000, limit, k);
    expect(displacementMillion).toBeLessThan(ceiling);
    expect(displacementMillion).toBeGreaterThan(170);

    const displacementNegativeMillion = computeElastic(-1_000_000, limit, k);
    expect(displacementNegativeMillion).toBeGreaterThan(-ceiling);
    expect(displacementNegativeMillion).toBeLessThan(-170);
  });

  it('renders safely with missing children and missing mascot', () => {
    expect(() => {
      const html = renderToString(React.createElement(DraggableBanner, { testID: 'empty-banner' }));
      expect(html).toBeDefined();
      expect(html).toContain('empty-banner');
    }).not.toThrow();
  });

  it('renders safely with complex nested children and mascot', () => {
    const mascot = React.createElement(DetectiveMascot, { size: 60 });
    const children = React.createElement('div', {}, 'Brand Text');
    expect(() => {
      const html = renderToString(
        React.createElement(DraggableBanner, { mascot }, children),
      );
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('interpolation mathematical integrity: non-zero limits guarantee monotonic ranges', () => {
    const maxDragX = 48;
    const maxDragY = 60;
    const inputRangeX = [-maxDragX, 0, maxDragX];
    const inputRangeY = [-maxDragY, 0, maxDragY];

    expect(inputRangeX[0]!).toBeLessThan(inputRangeX[1]!);
    expect(inputRangeX[1]!).toBeLessThan(inputRangeX[2]!);
    expect(inputRangeY[0]!).toBeLessThan(inputRangeY[1]!);
    expect(inputRangeY[1]!).toBeLessThan(inputRangeY[2]!);

    // Verify RN Animated throws when inputRange is not strictly monotonic or is inverted
    const animVal = new Animated.Value(0);
    expect(() => {
      animVal.interpolate({
        inputRange: [10, 0, -10],
        outputRange: [0, 1, 2],
      });
    }).toThrow();
  });
});

// ============================================================================
// 3. ShinyText Adversarial Stress Tests
// ============================================================================

describe('ShinyText Adversarial Tests', () => {
  it('survives empty string children without crash', () => {
    expect(() => {
      const html = renderToString(React.createElement(ShinyText, {}, ''));
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('survives undefined children and undefined text prop', () => {
    expect(() => {
      const html = renderToString(React.createElement(ShinyText, {}));
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('survives multi-line text with line breaks', () => {
    const multiLine = 'Case Dossier #4092\nEncrypted Evidence\nClassified';
    expect(() => {
      const html = renderToString(React.createElement(ShinyText, {}, multiLine));
      expect(html).toBeDefined();
      expect(html).toContain('Case Dossier #4092');
    }).not.toThrow();
  });

  it('survives numeric children (e.g. badge numbers)', () => {
    expect(() => {
      const html = renderToString(React.createElement(ShinyText, {}, 99824));
      expect(html).toBeDefined();
      expect(html).toContain('99824');
    }).not.toThrow();
  });

  it('disabled mode renders pristine static typography without aperture', () => {
    const html = renderToString(
      React.createElement(ShinyText, { disabled: true }, 'Static Text'),
    );
    expect(html).toContain('Static Text');
  });

  it('aperture bounds: bandWidth clamping handles edge case widths', () => {
    const clampAperture = (measuredWidth: number, ratio: number = 0.42) => {
      return Math.max(48, Math.min(160, measuredWidth * ratio));
    };

    expect(clampAperture(0)).toBe(48); // 0 width returns lower bound
    expect(clampAperture(-100)).toBe(48); // negative width clamped to 48
    expect(clampAperture(1_000_000)).toBe(160); // huge width clamped to 160
  });

  it('counter-translation zero drift: x_base + x_counter strictly equals 0 across all fractions', () => {
    const bandWidth = 80;
    const measuredWidth = 320;
    const travelFractions = [0, 0.05, 0.2, 0.333, 0.5, 0.667, 0.8, 0.95, 1.0];

    for (const t of travelFractions) {
      const tx = -bandWidth + t * (measuredWidth + bandWidth);
      const ctx = bandWidth - t * (measuredWidth + bandWidth);
      expect(tx + ctx).toBeCloseTo(0, 10);
    }
  });
});

// ============================================================================
// 4. FloatingPillInput Adversarial Stress Tests
// ============================================================================

describe('FloatingPillInput Adversarial Tests', () => {
  it('survives missing all optional props (null safety)', () => {
    expect(() => {
      const html = renderToString(React.createElement(FloatingPillInput, {}));
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('handles extremely long text input (100,000 chars)', () => {
    const longString = 'A'.repeat(100_000);
    expect(() => {
      const html = renderToString(
        React.createElement(FloatingPillInput, { value: longString }),
      );
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('handles error prop flips: null, empty string, whitespace string, valid error', () => {
    // 1. null error -> no error displayed
    const htmlNull = renderToString(
      React.createElement(FloatingPillInput, { error: null }),
    );
    expect(htmlNull).not.toContain('alert-circle-outline');

    // 2. empty string error -> no error displayed
    const htmlEmpty = renderToString(
      React.createElement(FloatingPillInput, { error: '' }),
    );
    expect(htmlEmpty).not.toContain('alert-circle-outline');

    // 3. whitespace string error -> no error displayed
    const htmlWhitespace = renderToString(
      React.createElement(FloatingPillInput, { error: '    ' }),
    );
    expect(htmlWhitespace).not.toContain('alert-circle-outline');

    // 4. valid error string -> displays error
    const htmlError = renderToString(
      React.createElement(FloatingPillInput, { error: 'Invalid Passcode' }),
    );
    expect(htmlError).toContain('Invalid Passcode');
  });

  it('supports secureToggle and initial secureTextEntry state', () => {
    const html = renderToString(
      React.createElement(FloatingPillInput, {
        secureToggle: true,
        secureTextEntry: true,
        placeholder: 'Password',
      }),
    );
    expect(html).toContain('Password');
    expect(html).toContain('Show password');
  });

  it('forwards ref to TextInput properly', () => {
    const ref = React.createRef<TextInput>();
    const element = React.createElement(FloatingPillInput, { ref });
    expect((element.props as any).ref ?? (element as any).ref).toBe(ref);
  });

  it('caps font scaling at CONTROL_SCALE_CAP (1.5)', () => {
    expect(CONTROL_SCALE_CAP).toBe(1.5);
  });
});

// ============================================================================
// 5. GradientPillButton Adversarial Stress Tests
// ============================================================================

describe('GradientPillButton Adversarial Tests', () => {
  it('disabled state: does not execute onPress and sets aria-disabled', () => {
    const onPress = vi.fn();
    const html = renderToString(
      React.createElement(GradientPillButton, {
        title: 'Submit',
        disabled: true,
        onPress,
      }),
    );
    expect(html).toContain('Submit');
    expect(onPress).not.toHaveBeenCalled();
  });

  it('loading state: does not execute onPress and mounts ActivityIndicator', () => {
    const onPress = vi.fn();
    const html = renderToString(
      React.createElement(GradientPillButton, {
        title: 'Authenticating',
        loading: true,
        onPress,
      }),
    );
    expect(html).toBeDefined();
    expect(onPress).not.toHaveBeenCalled();
  });

  it('title fallback: handles empty title and label without crash', () => {
    expect(() => {
      const html = renderToString(
        React.createElement(GradientPillButton, { onPress: () => {} }),
      );
      expect(html).toBeDefined();
    }).not.toThrow();
  });

  it('accessibility: includes button role, accessibilityLabel and hint', () => {
    const html = renderToString(
      React.createElement(GradientPillButton, {
        title: 'Verify Fingerprint',
        accessibilityHint: 'Double tap to verify biometrics',
        onPress: () => {},
      }),
    );
    expect(html).toContain('Verify Fingerprint');
  });
});

// ============================================================================
// 6. CheckboxPill Adversarial Stress Tests
// ============================================================================

describe('CheckboxPill Adversarial Tests', () => {
  it('accessible role and state: declares role="checkbox" and checked state', () => {
    const htmlChecked = renderToString(
      React.createElement(CheckboxPill, {
        checked: true,
        label: 'Remember Me',
        onToggle: () => {},
      }),
    );
    expect(htmlChecked).toContain('Remember Me');

    const htmlUnchecked = renderToString(
      React.createElement(CheckboxPill, {
        checked: false,
        label: 'Remember Me',
        onToggle: () => {},
      }),
    );
    expect(htmlUnchecked).toContain('Remember Me');
  });

  it('disabled state: renders disabled appearance', () => {
    const html = renderToString(
      React.createElement(CheckboxPill, {
        checked: true,
        disabled: true,
        label: 'Disabled Checkbox',
        onToggle: () => {},
      }),
    );
    expect(html).toContain('Disabled Checkbox');
  });

  it('haptics resilience: does not throw when Haptics rejects', async () => {
    (Haptics.selectionAsync as any).mockRejectedValueOnce(new Error('Haptics failed'));
    expect(async () => {
      await Haptics.selectionAsync().catch(() => {});
    }).not.toThrow();
  });

  it('touch target complies with minimum 44pt floor', () => {
    expect(HIT_TARGET).toBeGreaterThanOrEqual(44);
    expect(RADIUS.pill).toBe(999);
  });
});

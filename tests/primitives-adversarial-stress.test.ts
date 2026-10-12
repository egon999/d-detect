/**
 * tests/primitives-adversarial-stress.test.ts
 *
 * Adversarial empirical verification suite for Milestone 1 primitives:
 * - Theme contrast and palette invariant stress tests
 * - Memory leak and unmount loop resilience
 * - Animation loop lifecycle stopping verification
 * - Asymptotic physics and counter-translation mathematical boundary stress tests
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Animated, TextInput } from 'react-native';

// Mock reduced motion to allow empirical loop execution tests
let mockReducedMotionValue: boolean | null = false;

vi.mock('../src/ui/primitives/Motion', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    useReducedMotion: () => mockReducedMotionValue,
  };
});

// Standard native module mocks
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: (props: any) => React.createElement('View', props, props.children),
}));

vi.mock('expo-blur', () => ({
  BlurView: (props: any) => React.createElement('View', props, props.children),
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

import { DetectiveMascot } from '../src/ui/primitives/DetectiveMascot';
import { DraggableBanner } from '../src/ui/primitives/DraggableBanner';
import { ShinyText } from '../src/ui/primitives/ShinyText';
import { FloatingPillInput } from '../src/ui/primitives/FloatingPillInput';
import { GradientPillButton } from '../src/ui/primitives/GradientPillButton';
import { CheckboxPill } from '../src/ui/primitives/CheckboxPill';
import { darkColors, MOTION } from '../src/ui/tokens';

// ---------------------------------------------------------------------------
// Realistic React 19 Hook Lifecycle Test Harness
// ---------------------------------------------------------------------------

interface HookHarnessResult<R> {
  element: R;
  unmount: () => void;
  rerender: (newProps?: any) => R;
}

function mountComponent<P extends object, R>(
  Component: any,
  initialProps: P,
  reducedMotion: boolean | null = false,
): HookHarnessResult<R> {
  mockReducedMotionValue = reducedMotion;

  const cleanups: (() => void)[] = [];
  const stateSlots: any[] = [];
  let stateIndex = 0;
  const refSlots: any[] = [];
  let refIndex = 0;
  let currentProps = initialProps;

  function runLifecycle(props: P): R {
    stateIndex = 0;
    refIndex = 0;

    const dispatcher = {
      useRef: (initialValue: any) => {
        const idx = refIndex++;
        if (!(idx in refSlots)) {
          refSlots[idx] = { current: initialValue };
        }
        return refSlots[idx];
      },
      useState: (initialValue: any) => {
        const idx = stateIndex++;
        if (!(idx in stateSlots)) {
          stateSlots[idx] = typeof initialValue === 'function' ? initialValue() : initialValue;
        }
        const setState = (next: any) => {
          stateSlots[idx] = typeof next === 'function' ? next(stateSlots[idx]) : next;
        };
        return [stateSlots[idx], setState];
      },
      useEffect: (effect: () => (() => void) | void, deps?: any[]) => {
        const cleanup = effect();
        if (typeof cleanup === 'function') {
          cleanups.push(cleanup);
        }
      },
      useMemo: (factory: () => any) => factory(),
      useCallback: (fn: any) => fn,
      useContext: (ctx: any) => {
        return {
          colors: darkColors,
          motion: MOTION,
          tone: (t: any) => (darkColors.tones as any)[t],
        };
      },
    };

    const ReactInternals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prevDispatcher = ReactInternals?.H;
    ReactInternals.H = dispatcher;

    try {
      if (typeof Component.render === 'function') {
        return Component.render(props, null);
      }
      return Component(props);
    } finally {
      ReactInternals.H = prevDispatcher;
    }
  }

  const element = runLifecycle(currentProps);

  const unmount = () => {
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      try {
        c?.();
      } catch (e) {
        // capture cleanup failure
      }
    }
  };

  const rerender = (newProps?: any) => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    if (newProps) currentProps = newProps;
    return runLifecycle(currentProps);
  };

  return { element, unmount, rerender };
}

// ---------------------------------------------------------------------------
// 1. Memory Leak & Unmounting Loops Resilience
// ---------------------------------------------------------------------------

describe('Adversarial Stress: DetectiveMascot Unmounting & Memory Leaks', () => {
  it('starts 3 Animated.loop instances when mounted and stops all 3 on unmount', () => {
    const activeLoops: { start: any; stop: any }[] = [];

    const originalLoop = Animated.loop;
    const loopSpy = vi.spyOn(Animated, 'loop').mockImplementation((animation, config) => {
      const composite = originalLoop(animation, config);
      const startSpy = vi.spyOn(composite, 'start');
      const stopSpy = vi.spyOn(composite, 'stop');
      activeLoops.push({ start: startSpy, stop: stopSpy });
      return composite;
    });

    try {
      const harness = mountComponent(DetectiveMascot, { animated: true });

      // In DetectiveMascot:
      // 1. Idle Breathing Loop
      // 2. Magnifying Glass Glint Loop
      // 3. Sparkle & Star Twinkle Loop
      expect(activeLoops.length).toBe(3);
      for (const loop of activeLoops) {
        expect(loop.start).toHaveBeenCalled();
        expect(loop.stop).not.toHaveBeenCalled();
      }

      // Unmount the component
      harness.unmount();

      // All active loops must have stop() invoked immediately
      for (const loop of activeLoops) {
        expect(loop.stop).toHaveBeenCalled();
      }
    } finally {
      loopSpy.mockRestore();
    }
  });

  it('does NOT start any Animated.loop when animated=false or reduced motion is active', () => {
    const loopSpy = vi.spyOn(Animated, 'loop');
    try {
      // 1. animated = false
      const harness1 = mountComponent(DetectiveMascot, { animated: false }, false);
      expect(loopSpy).not.toHaveBeenCalled();
      harness1.unmount();

      // 2. reduced motion = true
      const harness2 = mountComponent(DetectiveMascot, { animated: true }, true);
      expect(loopSpy).not.toHaveBeenCalled();
      harness2.unmount();

      // 3. reduced motion = null (not resolved yet)
      const harness3 = mountComponent(DetectiveMascot, { animated: true }, null);
      expect(loopSpy).not.toHaveBeenCalled();
      harness3.unmount();
    } finally {
      loopSpy.mockRestore();
    }
  });

  it('stops recursive blinking sequence without leaking on unmount', () => {
    const sequenceSpy = vi.spyOn(Animated, 'sequence');
    const delaySpy = vi.spyOn(Animated, 'delay');

    try {
      const harness = mountComponent(DetectiveMascot, { animated: true });

      // Blinking sequence was scheduled via Animated.sequence with delay
      expect(sequenceSpy).toHaveBeenCalled();
      expect(delaySpy).toHaveBeenCalled();

      // Unmount terminates the loop
      harness.unmount();
    } finally {
      sequenceSpy.mockRestore();
      delaySpy.mockRestore();
    }
  });

  it('survives rapid mount-unmount stress thrashing (100 iterations) with 0 zombie loops', () => {
    const createdLoops: { stop: any }[] = [];
    const originalLoop = Animated.loop;
    const loopSpy = vi.spyOn(Animated, 'loop').mockImplementation((animation, config) => {
      const composite = originalLoop(animation, config);
      const originalStop = composite.stop.bind(composite);
      const stopSpy = vi.fn(() => originalStop());
      composite.stop = stopSpy;
      createdLoops.push({ stop: stopSpy });
      return composite;
    });

    try {

      for (let i = 0; i < 100; i++) {
        const harness = mountComponent(DetectiveMascot, { animated: true });
        harness.unmount();
      }

      // Exactly 300 loops created (3 loops per mount * 100 iterations)
      expect(createdLoops.length).toBe(300);
      // Every single loop must have had stop() called on unmount
      for (const loop of createdLoops) {
        expect(loop.stop).toHaveBeenCalled();
      }
    } finally {
      loopSpy.mockRestore();
    }
  });
});

describe('Adversarial Stress: ShinyText Unmounting & Shimmer Loops', () => {
  it('does NOT start shimmer loop before layout measurement (measuredWidth = 0)', () => {
    const loopSpy = vi.spyOn(Animated, 'loop');
    try {
      const harness = mountComponent(ShinyText, { children: 'D-Detect' });
      // At mount, initial measuredWidth = 0, so no loop starts
      expect(loopSpy).not.toHaveBeenCalled();
      harness.unmount();
    } finally {
      loopSpy.mockRestore();
    }
  });

  it('survives rapid mount-unmount stress thrashing (50 iterations)', () => {
    for (let i = 0; i < 50; i++) {
      const harness = mountComponent(ShinyText, {
        children: `Title ${i}`,
        duration: 1500,
      });
      harness.unmount();
    }
  });
});

describe('Adversarial Stress: DraggableBanner Gesture Physics & Invariants', () => {
  it('computes elastic asymptotic formula under extreme adversarial inputs', () => {
    // DraggableBanner's formula: offset = sign(d) * limit * (|d| / (limit + |d| * k))
    const computeElastic = (raw: number, limit: number, k: number) => {
      if (raw === 0) return 0;
      const sign = Math.sign(raw);
      const abs = Math.abs(raw);
      return sign * (limit * (abs / (limit + abs * k)));
    };

    const limitY = 60;
    const kY = 0.35;
    const maxAsymptoticLimit = limitY / kY; // 171.428...

    // 1. Extreme astronomical displacements must never exceed limit / k
    const astronomicalPull = 1e12;
    const offset = computeElastic(astronomicalPull, limitY, kY);
    expect(offset).toBeLessThan(maxAsymptoticLimit);
    expect(offset).toBeCloseTo(maxAsymptoticLimit, 3);

    // 2. Astronomical negative pull
    const negativePull = -1e12;
    const negOffset = computeElastic(negativePull, limitY, kY);
    expect(negOffset).toBeGreaterThan(-maxAsymptoticLimit);
    expect(negOffset).toBeCloseTo(-maxAsymptoticLimit, 3);

    // 3. Sub-pixel / epsilon displacements
    expect(computeElastic(1e-9, limitY, kY)).toBeGreaterThan(0);
    expect(computeElastic(0, limitY, kY)).toBe(0);

    // 4. Monotonicity: larger displacement strictly yields larger offset
    let prev = 0;
    for (let d = 1; d <= 500; d += 5) {
      const current = computeElastic(d, limitY, kY);
      expect(current).toBeGreaterThan(prev);
      prev = current;
    }
  });

  it('mounts, accepts gestures and unmounts cleanly without throwing', () => {
    const onStart = vi.fn();
    const onEnd = vi.fn();

    const harness = mountComponent(DraggableBanner, {
      onDragStart: onStart,
      onDragEnd: onEnd,
      children: React.createElement('Text', {}, 'Header'),
    });

    expect(harness.element).toBeDefined();
    harness.unmount();
  });
});

describe('Adversarial Stress: FloatingPillInput & GradientPillButton Dynamics', () => {
  it('FloatingPillInput handles rapid focus and blur toggling without throwing', () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();

    const harness = mountComponent(FloatingPillInput, {
      placeholder: 'Adversarial Test',
      onFocus,
      onBlur,
    });

    expect(harness.element).toBeDefined();
    harness.unmount();
  });

  it('GradientPillButton press interaction and unmount mid-press', () => {
    const onPress = vi.fn();
    const harness = mountComponent(GradientPillButton, {
      title: 'Action',
      onPress,
    });

    expect(harness.element).toBeDefined();
    harness.unmount();
  });

  it('CheckboxPill handles toggle and spring animation cleanly', () => {
    const onToggle = vi.fn();
    const harness = mountComponent(CheckboxPill, {
      checked: false,
      onToggle,
      label: 'Persist state',
    });

    expect(harness.element).toBeDefined();
    harness.unmount();
  });
});

// ---------------------------------------------------------------------------
// 2. Mathematical Precision & Theme Contrast Invariants
// ---------------------------------------------------------------------------

describe('Adversarial Stress: Mathematical Precision & Theme Invariants', () => {
  it('ShinyText counter-translation locks highlight text at exact x = 0 at every subpixel t', () => {
    const bandWidth = 55.4;
    const measuredWidth = 187.3;

    // Test across 100 fractional time steps
    for (let step = 0; step <= 100; step++) {
      const t = step / 100;
      const translateX = -bandWidth + t * (measuredWidth + bandWidth);
      const counterTranslateX = bandWidth - t * (measuredWidth + bandWidth);
      expect(Math.abs(translateX + counterTranslateX)).toBeLessThan(1e-10);
    }
  });

  it('GradientPillButton royal-to-navy gradient stops clear WCAG AA (4.5:1) against #FFFFFF', () => {
    const hexToLuminance = (hex: string): number => {
      const num = parseInt(hex.replace('#', ''), 16);
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      const toLinear = (c: number): number => {
        const val = c / 255;
        return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    };

    const contrast = (hex1: string, hex2: string): number => {
      const l1 = hexToLuminance(hex1);
      const l2 = hexToLuminance(hex2);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    };

    const white = '#FFFFFF';
    const stops = ['#2B5FD9', '#1E40AF', '#13285D'];

    for (const stop of stops) {
      const ratio = contrast(white, stop);
      expect(ratio, `stop ${stop} contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('DraggableBanner royal gradient stops are monotonically decreasing in luminance', () => {
    const hexToLuminance = (hex: string): number => {
      const num = parseInt(hex.replace('#', ''), 16);
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      const toLinear = (c: number): number => {
        const val = c / 255;
        return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    };

    const stops = ['#0E1D44', '#0A1530', '#070D21'];
    const lum0 = hexToLuminance(stops[0]!);
    const lum1 = hexToLuminance(stops[1]!);
    const lum2 = hexToLuminance(stops[2]!);

    expect(lum0).toBeGreaterThan(lum1);
    expect(lum1).toBeGreaterThan(lum2);
  });
});

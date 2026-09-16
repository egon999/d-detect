/**
 * Colour arithmetic, tested.
 *
 * `withAlpha` is asked to work on design tokens, and the tokens are not written in one
 * format: a tone's `fg` is a hex triple while its `bg` is already an `rgba()` string. A parse
 * that quietly failed on the second kind would paint the highlighter mark at zero opacity —
 * invisible, on the screen where the app makes its central claim — so both formats and the
 * refusals are pinned here.
 */

import { describe, expect, it } from 'vitest';

import { withAlpha } from '../src/ui/color';
import { darkColors, lightColors } from '../src/ui/tokens';

describe('withAlpha', () => {
  it('reads a six-digit hex', () => {
    expect(withAlpha('#A3ADC2', 0.22)).toBe('rgba(163, 173, 194, 0.22)');
  });

  it('reads shorthand hex as doubled pairs', () => {
    expect(withAlpha('#8af', 1)).toBe('rgba(136, 170, 255, 1)');
  });

  it('ignores an alpha the hex already carried', () => {
    expect(withAlpha('#A3ADC280', 0.5)).toBe('rgba(163, 173, 194, 0.5)');
  });

  it('reads an rgb() string', () => {
    expect(withAlpha('rgb(12, 23, 52)', 0.4)).toBe('rgba(12, 23, 52, 0.4)');
  });

  /**
   * The case that matters: a tone's `bg` is already translucent. The requested opacity
   * replaces the existing one rather than compounding with it, so asking for 22% off a 10%
   * token gives 22% and not 2.2%.
   */
  it('replaces an existing alpha rather than multiplying it', () => {
    expect(withAlpha('rgba(163, 173, 194, 0.10)', 0.22)).toBe('rgba(163, 173, 194, 0.22)');
  });

  it('tolerates whitespace and decimal channels', () => {
    expect(withAlpha('rgba( 163 , 173.4 , 194 , 0.1 )', 0.3)).toBe('rgba(163, 173, 194, 0.3)');
  });

  it('clamps opacity to the unit range', () => {
    expect(withAlpha('#000000', -1)).toBe('rgba(0, 0, 0, 0)');
    expect(withAlpha('#000000', 4)).toBe('rgba(0, 0, 0, 1)');
  });

  it('rounds opacity to three places rather than emitting float noise', () => {
    expect(withAlpha('#000000', 1 / 3)).toBe('rgba(0, 0, 0, 0.333)');
  });

  it('throws on a colour it cannot parse', () => {
    expect(() => withAlpha('tomato', 0.5)).toThrow(/not a hex or rgb/);
    expect(() => withAlpha('#12345', 0.5)).toThrow(/not a 3, 4, 6 or 8 digit hex/);
    expect(() => withAlpha('', 0.5)).toThrow();
  });

  /**
   * The real inputs. Every tone channel in both schemes has to survive, because the mark is
   * derived from whichever tone the surrounding finding carries.
   */
  it('parses every tone channel in both schemes', () => {
    for (const scheme of [darkColors, lightColors]) {
      for (const tone of Object.values(scheme.tones)) {
        for (const channel of [tone.fg, tone.bg, tone.border, tone.solid]) {
          expect(withAlpha(channel, 0.2)).toMatch(/^rgba\(\d+, \d+, \d+, 0\.2\)$/);
        }
      }
    }
  });
});

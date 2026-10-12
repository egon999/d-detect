import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text as RNText, type TextStyle } from 'react-native';
import { FONT_FAMILY } from '../tokens';
import { useReducedMotion } from './Motion';

export interface DecryptedTextProps {

  text: string;

  speed?: number;

  maxIterations?: number;

  sequential?: boolean;

  revealDirection?: 'start' | 'end' | 'center';

  characters?: string;

  style?: TextStyle;

  encryptedStyle?: TextStyle;

  onDecrypted?: () => void;

  autoStart?: boolean;
}

const DEFAULT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*<>~?_';

export function DecryptedText({
  text,
  speed = 35,
  maxIterations = 8,
  sequential = true,
  revealDirection = 'start',
  characters = DEFAULT_CHARS,
  style,
  encryptedStyle,
  onDecrypted,
  autoStart = true,
}: DecryptedTextProps) {
  const reducedMotion = useReducedMotion();
  const [displayText, setDisplayText] = useState(text);
  const [revealedIndices, setRevealedIndices] = useState<Set<number>>(() => new Set());
  const [isAnimating, setIsAnimating] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const getRandomChar = useCallback(() => {
    return characters[Math.floor(Math.random() * characters.length)];
  }, [characters]);

  const shuffle = useCallback(
    (original: string, revealed: Set<number>) => {
      return original
        .split('')
        .map((char, i) => {
          if (char === ' ' || char === '\n') return char;
          if (revealed.has(i)) return char;
          return getRandomChar();
        })
        .join('');
    },
    [getRandomChar],
  );

  const startDecryption = useCallback(() => {
    if (reducedMotion) {
      setDisplayText(text);
      setIsAnimating(false);
      onDecrypted?.();
      return;
    }

    if (intervalRef.current) clearInterval(intervalRef.current);
    const initialRevealed = new Set<number>();
    setRevealedIndices(initialRevealed);
    setIsAnimating(true);

    let iteration = 0;
    const len = text.length;

    intervalRef.current = setInterval(() => {
      setRevealedIndices((prev) => {
        const next = new Set(prev);

        if (sequential) {
          if (next.size < len) {
            let nextIdx: number;
            if (revealDirection === 'start') {
              nextIdx = next.size;
            } else if (revealDirection === 'end') {
              nextIdx = len - 1 - next.size;
            } else {
              const mid = Math.floor(len / 2);
              const off = Math.floor(next.size / 2);
              nextIdx = next.size % 2 === 0 ? mid + off : mid - off - 1;
              if (nextIdx < 0 || nextIdx >= len || next.has(nextIdx)) {
                for (let i = 0; i < len; i++) {
                  if (!next.has(i)) {
                    nextIdx = i;
                    break;
                  }
                }
              }
            }
            next.add(nextIdx);
            setDisplayText(shuffle(text, next));
            return next;
          } else {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setIsAnimating(false);
            setDisplayText(text);
            onDecrypted?.();
            return next;
          }
        } else {
          iteration += 1;
          if (iteration >= maxIterations) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setIsAnimating(false);
            setDisplayText(text);
            onDecrypted?.();
            return new Set(Array.from({ length: len }, (_, i) => i));
          }
          setDisplayText(shuffle(text, next));
          return next;
        }
      });
    }, speed);
  }, [reducedMotion, text, sequential, revealDirection, speed, maxIterations, shuffle, onDecrypted]);

  useEffect(() => {
    if (autoStart) {
      startDecryption();
    } else {
      setDisplayText(text);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [text, autoStart, startDecryption]);

  return (
    <RNText
      accessible
      accessibilityRole="text"
      accessibilityLabel={text}
      style={[styles.base, style]}
    >
      {displayText.split('').map((char, index) => {
        const isRevealed = !isAnimating || revealedIndices.has(index);
        return (
          <RNText
            key={`${char}-${index}`}
            style={isRevealed ? null : [styles.scrambled, encryptedStyle]}
          >
            {char}
          </RNText>
        );
      })}
    </RNText>
  );
}

const styles = StyleSheet.create({
  base: {
    fontFamily: FONT_FAMILY.monoRegular,
    color: '#F0F4FF',
  },
  scrambled: {
    color: '#00F0FF',
    fontFamily: FONT_FAMILY.monoMedium,
    opacity: 0.85,
  },
});

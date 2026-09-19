/**
 * Form fields.
 *
 * ## The typographic rule, in an input
 *
 * The sans/mono split (see `tokens.ts`) says: mono means a machine read this, sans means a
 * person wrote it. An input is where a person writes, so inputs are sans — with one
 * exception that proves the rule. When a field is *correcting* a machine-read value, it is
 * set in mono and labelled with what the machine read, because the user is not composing
 * prose there, they are overwriting a specific string that came off a document. The
 * `mono` prop is how a caller says which situation it is in.
 *
 * ## Focus
 *
 * The focus ring is a border colour change plus a background lift, animated over 150ms. No
 * outer glow: on a dark canvas a glow reads as a halo around the field and blurs its edge,
 * and the edge is what tells the user where the tappable area ends.
 *
 * Errors are shown under the field, never as a placeholder replacement and never as an
 * alert. A field that erases what you typed to tell you it was wrong is a field you have to
 * fight.
 */

import React, { forwardRef, useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { Icon, type IconName } from '../icon';
import { useTheme } from '../theme';
import { FONT_FAMILY, SPACING, TYPE_SCALE_CAP } from '../tokens';
import { Row } from './Layout';
import { Text } from './Text';

/**
 * React Native 0.83 types these as its own `FocusEvent` / `BlurEvent` rather than the
 * older `NativeSyntheticEvent<TextInputFocusEventData>`. Deriving the parameter from the
 * prop itself means this keeps compiling when the name changes again.
 */
type FocusHandler = NonNullable<TextInputProps['onFocus']>;
type BlurHandler = NonNullable<TextInputProps['onBlur']>;

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
  label?: string;
  /** Explanatory line under the field. Replaced by `error` when one is present. */
  hint?: string;
  error?: string;
  /** Set the value in the monospace face. For corrections to machine-read values. */
  mono?: boolean;
  /** Leading glyph inside the field. */
  icon?: IconName;
  /** Rendered at the right edge inside the field — a unit, a currency, a clear button. */
  trailing?: React.ReactNode;
  /** Grows with content up to `maxHeight`. For notes and claim statements. */
  multiline?: boolean;
  /**
   * Override the field's resting height. Only meaningful with `multiline`.
   *
   * The default 112 is right for a two-line note at the current body size (15.5/23.5).
   * A box somebody is expected to write a paragraph into needs to *look* like it expects a
   * paragraph, or they write one line.
   */
  minHeight?: number;
  containerStyle?: StyleProp<ViewStyle>;
  /** Shown next to the label. Use for "optional", not for "required". */
  labelHint?: string;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  {
    label,
    hint,
    error,
    mono = false,
    icon,
    trailing,
    multiline = false,
    minHeight,
    containerStyle,
    labelHint,
    onFocus,
    onBlur,
    ...rest
  },
  ref,
) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const focus = useRef(new Animated.Value(0)).current;

  const animate = useCallback(
    (to: number) => {
      Animated.timing(focus, {
        toValue: to,
        duration: theme.motion.duration.fast,
        // Colour cannot be driven natively, so this runs on the JS thread. It is one
        // interpolation on one view for the duration of a tap — not a scroll-linked
        // animation, where the same choice would be wrong.
        useNativeDriver: false,
      }).start();
    },
    [focus, theme.motion.duration.fast],
  );

  const handleFocus = useCallback<FocusHandler>(
    (event) => {
      setFocused(true);
      animate(1);
      onFocus?.(event);
    },
    [animate, onFocus],
  );

  const handleBlur = useCallback<BlurHandler>(
    (event) => {
      setFocused(false);
      animate(0);
      onBlur?.(event);
    },
    [animate, onBlur],
  );

  const borderColor = useMemo(
    () =>
      focus.interpolate({
        inputRange: [0, 1],
        outputRange: [
          error ? theme.colors.tones.danger.border : theme.colors.border,
          error ? theme.colors.tones.danger.fg : theme.colors.accent,
        ],
      }),
    [focus, error, theme.colors],
  );

  const backgroundColor = useMemo(
    () =>
      focus.interpolate({
        inputRange: [0, 1],
        outputRange: [theme.colors.surfaceSunken, theme.colors.surface],
      }),
    [focus, theme.colors],
  );

  const fontFamily = mono ? FONT_FAMILY.monoRegular : FONT_FAMILY.sansRegular;
  const typeToken = mono ? theme.type.mono : theme.type.body;

  return (
    <View style={containerStyle}>
      {label ? (
        <Row between align="center" style={{ marginBottom: theme.spacing.sm }}>
          <Text variant="label" colorToken={focused ? 'textAccent' : 'textSecondary'}>
            {label}
          </Text>
          {labelHint ? (
            <Text variant="caption" colorToken="textTertiary">
              {labelHint}
            </Text>
          ) : null}
        </Row>
      ) : null}

      <Animated.View
        style={[
          styles.field,
          {
            borderColor,
            backgroundColor,
            borderRadius: theme.radius.md,
            paddingHorizontal: theme.spacing.lg,
            minHeight: minHeight ?? (multiline ? 112 : 50),
            alignItems: multiline ? 'flex-start' : 'center',
            paddingVertical: multiline ? theme.spacing.lg : 0,
          },
        ]}
      >
        {icon ? (
          <Icon
            name={icon}
            size={17}
            color={focused ? theme.colors.accent : theme.colors.textTertiary}
          />
        ) : null}

        <TextInput
          ref={ref}
          style={[
            styles.input,
            typeToken,
            {
              fontFamily,
              color: theme.colors.text,
              // Android adds its own vertical padding that misaligns the text against a
              // leading icon; zeroing it and relying on the container's minHeight keeps
              // both platforms identical.
              paddingVertical: 0,
              textAlignVertical: multiline ? 'top' : 'center',
            },
          ]}
          placeholderTextColor={theme.colors.textTertiary}
          onFocus={handleFocus}
          onBlur={handleBlur}
          multiline={multiline}
          selectionColor={theme.colors.accent}
          // The cursor is hard to see against a dark field at the default Android colour.
          cursorColor={theme.colors.accent}
          // `TextInput` is the one text path in the app that does not go through
          // `primitives/Text`, so the scaling policy has to be restated here or a raised font
          // scale would grow every label on the screen and leave what the user is *typing* at
          // its nominal size. Matched to the rank the input is set in, so the field and the
          // prose around it move together. The box already grows: `minHeight`, not `height`.
          maxFontSizeMultiplier={mono ? TYPE_SCALE_CAP.mono : TYPE_SCALE_CAP.body}
          {...rest}
          accessibilityLabel={rest.accessibilityLabel ?? label}
          accessibilityHint={rest.accessibilityHint ?? error ?? hint}
        />

        {trailing}
      </Animated.View>

      {error ? (
        <Row gap="xs" align="center" style={{ marginTop: theme.spacing.sm }}>
          <Icon name="alert-circle-outline" size={13} color={theme.colors.tones.danger.fg} />
          <Text variant="caption" tone="danger" style={styles.flex}>
            {error}
          </Text>
        </Row>
      ) : hint ? (
        <Text variant="caption" colorToken="textTertiary" style={{ marginTop: theme.spacing.sm }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** One line under the label. For options whose meaning is not obvious from the name. */
  description?: string;
}

export interface SelectFieldProps<T extends string> {
  label?: string;
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (next: T) => void;
  hint?: string;
}

/**
 * A vertical list of choices, shown in full rather than behind a dropdown.
 *
 * Every use of this in the app has four options or fewer — case status, date precision,
 * relationship type. At that size a dropdown costs a tap and hides the alternatives, and
 * the alternatives are exactly what the user is deciding between.
 */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: SelectFieldProps<T>) {
  const theme = useTheme();

  return (
    <View>
      {label ? (
        <Text variant="label" colorToken="textSecondary" style={{ marginBottom: theme.spacing.sm }}>
          {label}
        </Text>
      ) : null}

      <View style={{ gap: theme.spacing.sm }}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <SelectRow
              key={option.value}
              option={option}
              selected={selected}
              onPress={() => onChange(option.value)}
            />
          );
        })}
      </View>

      {hint ? (
        <Text variant="caption" colorToken="textTertiary" style={{ marginTop: theme.spacing.sm }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

function SelectRow<T extends string>({
  option,
  selected,
  onPress,
}: {
  option: SelectOption<T>;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <View
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={option.label}
      style={[
        styles.selectRow,
        {
          borderColor: selected ? theme.colors.accent : theme.colors.border,
          backgroundColor: selected ? theme.colors.accentSurface : theme.colors.surface,
          borderRadius: theme.radius.md,
          padding: theme.spacing.lg,
        },
      ]}
      onStartShouldSetResponder={() => true}
      onResponderRelease={onPress}
    >
      {option.icon ? (
        <Icon
          name={option.icon}
          size={18}
          color={selected ? theme.colors.accent : theme.colors.textSecondary}
        />
      ) : null}

      <View style={styles.flex}>
        {/*
          Two lines. The one caller of this field offers a case's claims as the options, and a
          claim is allowed two thousand characters — so an unclamped label set a radio row as a
          page of prose with a radio button somewhere off the bottom of it. The full string stays
          on `accessibilityLabel` above, so clamping costs a screen reader nothing.
        */}
        <Text variant="bodySmall" colorToken={selected ? 'textAccent' : 'text'} numberOfLines={2}>
          {option.label}
        </Text>
        {option.description ? (
          <Text variant="caption" colorToken="textTertiary" style={{ marginTop: 2 }}>
            {option.description}
          </Text>
        ) : null}
      </View>

      <Icon
        name={selected ? 'radiobox-marked' : 'radiobox-blank'}
        size={18}
        color={selected ? theme.colors.accent : theme.colors.textTertiary}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
  },
  selectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});

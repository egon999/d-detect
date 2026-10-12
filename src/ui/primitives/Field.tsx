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

type FocusHandler = NonNullable<TextInputProps['onFocus']>;
type BlurHandler = NonNullable<TextInputProps['onBlur']>;

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'placeholderTextColor'> {
  label?: string;

  hint?: string;
  error?: string;

  mono?: boolean;

  icon?: IconName;

  trailing?: React.ReactNode;

  multiline?: boolean;

  minHeight?: number;
  containerStyle?: StyleProp<ViewStyle>;

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

              paddingVertical: 0,
              textAlignVertical: multiline ? 'top' : 'center',
            },
          ]}
          placeholderTextColor={theme.colors.textTertiary}
          onFocus={handleFocus}
          onBlur={handleBlur}
          multiline={multiline}
          selectionColor={theme.colors.accent}

          cursorColor={theme.colors.accent}

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

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;

  description?: string;
}

export interface SelectFieldProps<T extends string> {
  label?: string;
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (next: T) => void;
  hint?: string;
}

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
        {}
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

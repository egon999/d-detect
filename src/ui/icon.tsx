import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import React from 'react';
import type { ComponentProps } from 'react';

type GlyphProps = ComponentProps<typeof MaterialCommunityIcons>;

export type IconName = GlyphProps['name'];

export interface IconProps {
  name: IconName;
  size?: number;
  color: string;

  disabled?: boolean;
}

export function Icon({ name, size = 18, color, disabled = false }: IconProps) {
  return (
    <MaterialCommunityIcons
      name={name}
      size={size}
      color={color}
      style={disabled ? { opacity: 0.4 } : undefined}

      accessible={false}
      importantForAccessibility="no"
    />
  );
}

export { MaterialCommunityIcons };

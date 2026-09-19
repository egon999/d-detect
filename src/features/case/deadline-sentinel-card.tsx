import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { deriveDeadlineSentinel, type StatutoryClock } from '@domain/analysis/deadline-sentinel';
import type { Workspace } from '@domain/models';
import { Chip, Divider, IconTile, Row, Surface, Text, useTheme } from '@ui';

export interface DeadlineSentinelCardProps {
  workspace: Workspace;
  caseId: string;
}

export function DeadlineSentinelCard({ workspace, caseId }: DeadlineSentinelCardProps) {
  const theme = useTheme();
  const sentinel = useMemo(() => deriveDeadlineSentinel(workspace, caseId), [workspace, caseId]);

  const getUrgencyTone = (urgency: StatutoryClock['urgency']): 'danger' | 'warn' | 'accent' | 'neutral' => {
    switch (urgency) {
      case 'EXPIRED':
      case 'CRITICAL':
        return 'danger';
      case 'URGENT':
        return 'warn';
      case 'UPCOMING':
        return 'accent';
      default:
        return 'neutral';
    }
  };

  return (
    <Surface elevation="low" radius="md" padding="lg" glass>
      <Row between align="center" gap="md">
        <Row align="center" gap="sm">
          <IconTile
            icon="clock-alert-outline"
            tone={sentinel.criticalClocksCount > 0 ? 'danger' : 'accent'}
            size="sm"
          />
          <View>
            <Text variant="subheading">Regulatory & Deadline Sentinel</Text>
            <Text variant="caption" colorToken="textTertiary">
              Statutory clocks, cure windows & filing deadlines
            </Text>
          </View>
        </Row>
        <Chip
          label={`${sentinel.activeClocks.length} Clocks Active`}
          tone={sentinel.criticalClocksCount > 0 ? 'warn' : 'accent'}
          size="sm"
        />
      </Row>

      <View style={{ marginTop: theme.spacing.lg }}>
        {sentinel.activeClocks.map((clock, index) => {
          const tone = getUrgencyTone(clock.urgency);
          const daysText =
            clock.daysRemaining < 0
              ? `${Math.abs(clock.daysRemaining)}d Overdue`
              : clock.daysRemaining === 0
                ? 'Expires Today'
                : `${clock.daysRemaining} days left`;

          return (
            <View key={clock.id}>
              {index > 0 ? <Divider spacing="md" /> : null}
              <Row between align="flex-start" gap="sm">
                <View style={styles.flex}>
                  <Text variant="bodyMedium">{clock.title}</Text>
                  <Text variant="caption" colorToken="textTertiary" style={{ marginTop: 2 }}>
                    Trigger: {clock.triggerEvent} ({clock.triggerDateIso})
                  </Text>
                </View>
                <Chip label={daysText} tone={tone} size="sm" />
              </Row>

              <View style={[styles.remedyBox, { backgroundColor: theme.colors.surfaceSunken }]}>
                <Text variant="caption" tone={tone === 'danger' ? 'danger' : 'accent'}>
                  Next Action: {clock.remedyAction}
                </Text>
                <Text variant="caption" colorToken="textTertiary" style={{ marginTop: 2 }}>
                  {clock.statutoryReference}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  remedyBox: {
    padding: 8,
    borderRadius: 6,
    marginTop: 8,
  },
});

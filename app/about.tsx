import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Chip,
  FadeIn,
  IconTile,
  Row,
  ScreenHeaderBar,
  SlideUpIn,
  Surface,
  Text,
  useTheme,
} from '@ui';

const WORKFLOW_PILLARS = [
  {
    icon: 'shield-check-outline',
    title: '1. Ingest & Cryptographic Integrity',
    description:
      'Upload receipts, chat logs, agreements, and audio notes. Every file is immediately hashed with SHA-256 to establish an unalterable chain of custody.',
  },
  {
    icon: 'scale-balance',
    title: '2. Cross-Evidence Contradiction Engine',
    description:
      'Our deterministic rule engine compares extracted dates, monetary amounts, and transaction IDs across sources to detect discrepancies and uncredited claims.',
  },
  {
    icon: 'file-document-outline',
    title: '3. Certified Dispute Notices & Dossiers',
    description:
      'Compile findings, citations, and statutory limitation deadlines into executive PDF dossiers and formal dispute notices ready for ombudsman or legal escalation.',
  },
] as const;

const VERDICT_CLASSES = [
  {
    label: 'Supported',
    tone: 'ok' as const,
    description: 'Evidence directly validates the statement with matching documentary citations.',
  },
  {
    label: 'Contradicted',
    tone: 'danger' as const,
    description: 'Direct discrepancy found (e.g. invoice date/amount conflicts with bank debit).',
  },
  {
    label: 'Disputed',
    tone: 'warn' as const,
    description: 'Opposing sources present conflicting narratives that require resolution.',
  },
  {
    label: 'Insufficient',
    tone: 'neutral' as const,
    description: 'Available documents lack necessary reference fields to reach a conclusion.',
  },
] as const;

export default function AboutScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas }]}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.layout.screenPadding,
          paddingTop: insets.top + theme.layout.headerHeight + theme.spacing.lg,
          paddingBottom: insets.bottom + theme.spacing.xl,
        }}
      >
        <View style={styles.content}>
          <SlideUpIn>
            <Row align="center" gap="md" style={{ marginBottom: theme.spacing.md }}>
              <IconTile icon="shield-check" tone="accent" size="md" />
              <View style={styles.flex}>
                <Text variant="display">Evidence Intelligence</Text>
                <Text variant="subheading" colorToken="textSecondary">
                  Local-first verification & proof generation
                </Text>
              </View>
            </Row>
          </SlideUpIn>

          <SlideUpIn delay={theme.motion.stagger}>
            <Text colorToken="textSecondary" style={{ lineHeight: 22 }}>
              Ddetect provides verifiable dispute resolution tools. By cross-examining
              documents, detecting contradictions, and tracking statutory deadlines, it transforms
              raw files into certified proof dossiers.
            </Text>
          </SlideUpIn>

          <SlideUpIn delay={theme.motion.stagger * 2}>
            <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.md }}>
              <Text variant="heading">Core Framework</Text>
              {WORKFLOW_PILLARS.map((pillar) => (
                <Surface key={pillar.title} padding="lg" radius="lg" style={{ gap: theme.spacing.sm }}>
                  <Row align="center" gap="sm">
                    <IconTile icon={pillar.icon} tone="accent" size="sm" />
                    <Text variant="subheading" style={styles.flex}>
                      {pillar.title}
                    </Text>
                  </Row>
                  <Text colorToken="textSecondary" style={{ lineHeight: 20 }}>
                    {pillar.description}
                  </Text>
                </Surface>
              ))}
            </View>
          </SlideUpIn>

          <FadeIn delay={theme.motion.stagger * 3}>
            <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.md }}>
              <Text variant="heading">Evidence Verdicts</Text>
              <Text variant="bodySmall" colorToken="textSecondary">
                How our consistency engine classifies examined claims:
              </Text>
              <View style={{ gap: theme.spacing.sm }}>
                {VERDICT_CLASSES.map((verdict) => (
                  <Surface
                    key={verdict.label}
                    padding="md"
                    radius="md"
                    style={{ gap: theme.spacing.xs }}
                  >
                    <Row between align="center">
                      <Chip label={verdict.label} tone={verdict.tone} size="sm" />
                    </Row>
                    <Text variant="bodySmall" colorToken="textSecondary">
                      {verdict.description}
                    </Text>
                  </Surface>
                ))}
              </View>
            </View>

            <Surface padding="lg" radius="lg" style={{ marginTop: theme.spacing.xl, gap: theme.spacing.sm }}>
              <Row align="center" gap="sm">
                <IconTile icon="lock-outline" tone="neutral" size="sm" />
                <Text variant="subheading">Privacy & Sovereign Storage</Text>
              </Row>
              <Text colorToken="textSecondary" style={{ lineHeight: 20 }}>
                All document parsing, optical character recognition (OCR), and consistency
                verifications execute entirely on your device. Original files and generated proof
                dossiers remain private to your local environment unless synchronized with your
                authenticated account.
              </Text>
            </Surface>
          </FadeIn>
        </View>
      </ScrollView>
      <ScreenHeaderBar title="About Ddetect" back />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { width: '100%', maxWidth: 820, alignSelf: 'center' },
  flex: { flex: 1 },
});

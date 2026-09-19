/**
 * Cryptographic Proof Capsule Manifest & Action Card.
 *
 * Assembles and verifies the tamper-evident cryptographic manifest (SHA-256 root hash,
 * verified items count, unconfirmed reads, and one-tap export actions).
 */

import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import {
  generateProofCapsule,
  type ProofCapsulePackage,
} from '@domain/analysis/proof-capsule';
import type { Workspace } from '@domain/models';
import {
  Button,
  Chip,
  Divider,
  Icon,
  Notice,
  Row,
  Surface,
  Text,
  useTheme,
} from '@ui';

interface ProofCapsuleCardProps {
  workspace: Workspace;
  caseId: string;
}

export function ProofCapsuleCard({ workspace, caseId }: ProofCapsuleCardProps) {
  const theme = useTheme();
  const router = useRouter();
  const [showManifest, setShowManifest] = useState(false);

  const capsule: ProofCapsulePackage = useMemo(() => {
    return generateProofCapsule(workspace, caseId);
  }, [workspace, caseId]);

  return (
    <Surface elevation="low" style={styles.container}>
      <Row align="center" justify="space-between" style={{ marginBottom: theme.spacing.sm }}>
        <Row align="center" gap="sm">
          <Icon name="certificate-outline" size={20} color={theme.colors.accent} />
          <Text variant="heading">Cryptographic Proof Capsule</Text>
        </Row>
        <Chip
          label="Tamper-Evident SHA-256"
          emphasis="solid"
          tone="ok"
          icon="shield-check"
        />
      </Row>

      <Text variant="bodySmall" colorToken="textSecondary" style={{ marginBottom: theme.spacing.sm }}>
        Portable, self-contained verification package for courts, arbitrators, and counterparties.
      </Text>

      {/* Root Hash & Seal Stats */}
      <View
        style={[
          styles.hashPlate,
          {
            backgroundColor: theme.colors.surfaceSunken,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Row align="center" justify="space-between" style={{ marginBottom: 4 }}>
          <Text variant="caption" colorToken="textSecondary">Capsule Audit Head:</Text>
          <Chip label={`${capsule.evidenceManifest.length} Evidence Records`} emphasis="soft" tone="neutral" />
        </Row>
        <Text variant="monoSmall" style={styles.hashText} numberOfLines={1}>
          {capsule.cryptographicIntegrity.auditChainHead ?? 'GENESIS_UNSEALED_HASH'}
        </Text>
        <Row align="center" justify="space-between" style={{ marginTop: 6 }}>
          <Text variant="caption" colorToken="textTertiary">
            Generated: {new Date(capsule.generatedAt).toISOString().slice(0, 10)}
          </Text>
          <Text variant="caption" colorToken="textTertiary">
            Format: v{capsule.version}
          </Text>
        </Row>
      </View>

      {/* Primary Action Buttons */}
      <Row gap="sm" style={{ marginTop: theme.spacing.md }}>
        <View style={styles.actionFlex}>
          <Button
            label="Export Formal Dossier"
            icon="tray-arrow-down"
            variant="primary"
            onPress={() => router.push({ pathname: '/case/[caseId]/export', params: { caseId } })}
          />
        </View>
        <View style={styles.actionFlex}>
          <Button
            label="Draft Legal Notice"
            icon="file-sign"
            variant="secondary"
            onPress={() => router.push({ pathname: '/case/[caseId]/letter', params: { caseId } })}
          />
        </View>
      </Row>

      {/* Secondary Forensic Inspection Actions */}
      <Row gap="sm" style={{ marginTop: theme.spacing.sm }}>
        <View style={styles.actionFlex}>
          <Button
            label="View Connection Graph"
            icon="vector-polyline"
            variant="ghost"
            onPress={() => router.push({ pathname: '/case/[caseId]/graph', params: { caseId } })}
          />
        </View>
        <View style={styles.actionFlex}>
          <Button
            label="Inspect Audit Chain"
            icon="history"
            variant="ghost"
            onPress={() => router.push({ pathname: '/case/[caseId]/audit', params: { caseId } })}
          />
        </View>
      </Row>

      {/* Toggle raw manifest preview */}
      <Button
        label={showManifest ? 'Hide Manifest Structure' : 'View Manifest Details'}
        icon={showManifest ? 'chevron-up' : 'code-json'}
        variant="ghost"
        onPress={() => setShowManifest((prev) => !prev)}
        style={{ marginTop: theme.spacing.xs }}
      />

      {showManifest ? (
        <View
          style={[
            styles.manifestBox,
            {
              backgroundColor: theme.colors.surfaceRaised,
              borderColor: theme.colors.borderStrong,
            },
          ]}
        >
          <Text variant="label" style={{ marginBottom: 4 }}>Manifest Summary:</Text>
          <Text variant="caption" colorToken="textSecondary">
            • Claims recorded: {capsule.claimsMatrix.length}{'\n'}
            • Evidence files sealed: {capsule.evidenceManifest.length}{'\n'}
            • Audit chain length: {capsule.cryptographicIntegrity.chainLength}{'\n'}
            • Cryptographic seal: {capsule.cryptographicIntegrity.isSealed ? 'SEALED' : 'UNSEALED'}
          </Text>
        </View>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    borderRadius: 16,
  },
  hashPlate: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginVertical: 4,
  },
  hashText: {
    fontSize: 12,
    marginTop: 2,
  },
  actionFlex: {
    flex: 1,
  },
  manifestBox: {
    marginTop: 8,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
});

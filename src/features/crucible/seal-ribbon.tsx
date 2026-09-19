/**
 * The seal ribbon.
 *
 * Sits under the integrity panel on the audit trail and answers one question: **has anything
 * outside this device vouched for this history, and does it still match?**
 *
 * ## Why this is a separate surface from the integrity panel
 *
 * The panel above it reports a hash chain computed on this device from these records. That
 * proves internal consistency and nothing more — its own copy says so, at length, because
 * "anyone who could rewrite the records could also recompute a matching chain" is the honest
 * limitation of a self-derived digest. The seal is the answer to exactly that sentence, and
 * merging the two would blur which fact came from where. So: two surfaces, two sources, each
 * labelled.
 *
 * ## Where the words are
 *
 * Every sentence this renders comes from `seal-copy.ts`, which has no React in it and is
 * covered by `tests/crucible-seal-copy.test.ts` — including a sweep that fails the build if
 * "tamper-proof", "immutable", "blockchain" or an unqualified "verified" ever appears in any
 * state's copy. This file is layout; that file is what the product claims.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { shortDigest } from '@domain/analysis/audit-chain';
import type { CaseSealState } from '@domain/crucible/case-seal-state';
import { requestSeal, type RepositoryKind } from '@services';
// Imported from the module rather than the `@services` barrel, which does not re-export it.
import { sealAvailability } from '@services/crucible/request-seal';
import {
  Button,
  Chip,
  Divider,
  Notice,
  Row,
  SPACING,
  Surface,
  Text,
  formatRelativeTime,
  useTheme,
  useToast,
} from '@ui';

import {
  SEAL_UNCHANGED_MESSAGE,
  sealActionLabel,
  sealHeadline,
  sealNotice,
  sealOutcomeMessage,
} from './seal-copy';

export interface SealRibbonProps {
  caseId: string;
  state: CaseSealState;
  /**
   * Which adapter is serving this session. The ribbon turns it into a sealing answer itself
   * via `sealAvailability`, because the two are not the same question and the screen above
   * has no reason to know the difference.
   */
  repositoryKind: RepositoryKind;
  /** Called after the server writes a seal, so the screen can pick up the new records. */
  onSealed: () => void;
}

export function SealRibbon({ caseId, state, repositoryKind, onSealed }: SealRibbonProps) {
  const theme = useTheme();
  const toast = useToast();
  const [sealing, setSealing] = useState(false);

  const { latest } = state;
  // Derived here from the kind the screen already passes, so no call site has to learn about
  // sealing. What this needs is not where the case is stored but whether a signer can be
  // reached, and `sealAvailability` is the only place that difference is worked out —
  // `requestSeal` reads the same function, so the button and the request cannot disagree.
  //
  // This was `repositoryKind !== 'local'`, which answered the storage question. It was right
  // to stop testing for `=== 'firebase'` — the platform API holds the key and runs the same
  // `sealCase` the callable does — but the replacement swung the other way and told every
  // Firebase session it could seal, on a project where no callable is deployed.
  const availability = sealAvailability(repositoryKind);
  const copy = { state, availability };
  const headline = sealHeadline(copy);
  const notice = sealNotice(copy);
  const action = sealActionLabel(copy);

  async function seal() {
    setSealing(true);
    try {
      const outcome = await requestSeal(caseId, { repositoryKind });
      if (outcome.kind === 'sealed') {
        toast.show({ tone: 'ok', message: sealOutcomeMessage(outcome.receipt.entryCount) });
        onSealed();
      } else if (outcome.kind === 'unchanged') {
        // The default toast tone, not `ok`: nothing was signed, so nothing succeeded. Still
        // reloaded, because "unchanged" means the server saw a seal this screen may not have.
        toast.show({ message: SEAL_UNCHANGED_MESSAGE });
        onSealed();
      } else {
        toast.show({ tone: 'warn', message: outcome.reason });
      }
    } finally {
      setSealing(false);
    }
  }

  return (
    <Surface glass glassVariant="hero" radius="lg" style={styles.panel}>
      <Row justify="space-between" align="center" gap="md">
        <View style={styles.flex}>
          <Text variant="overline" colorToken="textSecondary">
            Server seal
          </Text>
          <Text variant="body">{headline.sentence}</Text>
        </View>
        <Chip
          tone={headline.tone}
          emphasis={headline.tone === 'ok' ? 'filled' : 'soft'}
          label={headline.chip}
        />
      </Row>

      {latest ? (
        <>
          <Divider />
          <View style={{ gap: theme.spacing.xs }}>
            <Detail label="Signed" value={formatRelativeTime(latest.sealedAt, Date.now())} />
            <Detail
              label="Covers"
              value={`${latest.entryCount} ${latest.entryCount === 1 ? 'entry' : 'entries'}`}
            />
            {/* Both shortened the way the chain head is, and for the same reason: a
                128-character hex string wraps to four lines and tells a reader nothing more
                than its ends do. The full values travel in the export. */}
            <Detail label="Signature" value={shortDigest(latest.signature)} mono />
            <Detail label="Key" value={`${latest.keyId} · ${latest.algorithm}`} mono />
          </View>
        </>
      ) : null}

      {notice ? (
        <Notice tone={notice.tone} icon={notice.icon} title={notice.title} message={notice.message} />
      ) : null}

      {action ? (
        <Button
          label={action}
          icon="seal-variant"
          variant={latest ? 'secondary' : 'primary'}
          loading={sealing}
          fullWidth
          onPress={() => void seal()}
          accessibilityHint="Asks the server to read this case's history, compute its chain and sign it."
        />
      ) : null}
    </Surface>
  );
}

/** One label/value line. Monospace only for the digests, where a wrong glyph matters. */
function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <Row justify="space-between" gap="md">
      <Text variant="caption" colorToken="textSecondary">
        {label}
      </Text>
      <Text variant={mono ? 'mono' : 'caption'}>{value}</Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  panel: { padding: SPACING.lg, gap: SPACING.md },
  flex: { flex: 1 },
});

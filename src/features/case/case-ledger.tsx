/**
 * The case totals, set as a statement of account.
 *
 * Left column: what is being counted, in sans, because those words are the app's own.
 * Right column: the figure, in mono, right-aligned so the digits of every row stack in the
 * same place. Hairline rules between. No fill, no border, no icons, no radius.
 *
 * ## Why not stat tiles
 *
 * Three or four bordered tiles with a big number and a small caption is the default shape for
 * this content and it was rejected on two grounds. It costs about 200 points of vertical space
 * to say four numbers, which on a 360pt phone pushes the actual answer — the assessment
 * plates — below the fold; and a grid of tiles is the visual signature of a dashboard, which
 * is a genre about *monitoring* rather than about reading a case. A ruled ledger says the same
 * four numbers in roughly a quarter of the height, and it says them in the register of a
 * financial statement, which is the register this product is actually in.
 *
 * ## Why no figure is ever coloured
 *
 * An amber "2" against "Open findings" was the first version. A count is not a state: two open
 * findings on a case with forty documents is unremarkable and two on a case with three is the
 * whole story, and the number alone cannot tell those apart. Where a line needs attention the
 * `note` under it says so in words, which can be qualified. Colour on this screen belongs to
 * the assessment plates and to nothing else.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AnimatedCounter,
  Divider,
  Row,
  Text,
  type TypeToken,
} from '@ui';

export interface LedgerLine {
  /** The thing being counted, in the app's own words. */
  label: string;
  value: number;
  /**
   * One clause under the label, qualifying the figure.
   *
   * This is where a count earns its meaning: "5 read, 2 still processing" under a source
   * count, or "none since the last assessment" under a findings count of zero.
   */
  note?: string;
}

export interface CaseLedgerProps {
  lines: readonly LedgerLine[];
  /**
   * Type token for the figures. Defaults to `monoValue`.
   *
   * `statValue` is available for a screen that wants the totals to lead, but the case screen
   * deliberately does not: the plates lead, and a 25pt extra-bold figure beside them would
   * compete with the one element that is supposed to win.
   */
  figureVariant?: TypeToken;
}

export function CaseLedger({ lines, figureVariant = 'monoValue' }: CaseLedgerProps) {
  return (
    <View>
      {lines.map((line, index) => (
        <View key={line.label}>
          {index > 0 ? <Divider spacing="lg" /> : null}
          <Row gap="lg" align="center" justify="space-between">
            <View style={styles.flex}>
              <Text variant="bodyMedium">{line.label}</Text>
              {line.note ? (
                <Text variant="caption" colorToken="textTertiary">
                  {line.note}
                </Text>
              ) : null}
            </View>

            {/*
              `AnimatedCounter` only animates when the figure actually changes — it holds the
              value it last settled on, so a ledger does not count itself up every time the
              screen mounts. That is the difference between a figure reacting to a new
              analysis and a splash animation.
            */}
            <AnimatedCounter
              value={line.value}
              variant={figureVariant}
              colorToken="text"
              style={styles.figure}
            />
          </Row>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // `textAlign` rather than a fixed column width: at 200% font scale a hardcoded column
  // clips, and right-aligned text in an auto-width box stays flush to the same edge anyway.
  figure: { textAlign: 'right' },
});

/**
 * Excerpt — the document's own words, quoted.
 *
 * ## What this fixes
 *
 * Every extracted value in this app already carries a `sourceQuote`: roughly sixty characters
 * of the document either side of the match. It is the most valuable string the app holds. It
 * is the difference between the software asserting that two documents disagree and a reader
 * *seeing* them disagree — and it was computed on every field, threaded through
 * `ComparisonCell`, and then never rendered anywhere. `compare.tsx` read `cell.sourceQuote`
 * into a variable and dropped it.
 *
 * What the reader got instead was the app's paraphrase, in the app's own panel, in the app's
 * own voice:
 *
 *     Amount                              [Differs]
 *     1   ₹1,80,000                  [Read by rule]
 *     2   ₹1,20,000                    [Read by AI]
 *
 * Two numbers, a legend to hold in your head, and the app's word for it. Nothing a person
 * could take to the other side and point at. This component is the other half of that screen:
 *
 *     ₹1,80,000
 *     ┌────────────────────────────────────────────┐
 *     │ …total payable is ▓Rs. 1,80,000.00▓ within  │
 *     │ fourteen d…                                 │
 *     │                     ⌕ Read from the document │
 *     └────────────────────────────────────────────┘
 *
 * ## The material
 *
 * A sheet of paper — see `PaperTokens`. The app has exactly two materials and they mean
 * different things: **glass is the app speaking, paper is the document speaking.** A reader
 * can tell at a glance which words came off their evidence, which is the distinction the whole
 * product rests on and the one thing every screen used to blur.
 *
 * Three details carry it, and each is doing a job rather than decorating:
 *
 *   - **The warm ground and the warmer ink.** Manila at 45° against a canvas at 223°. Almost
 *     all of the effect is in the ink colour, which is nearly free.
 *   - **The ellipses are set in `paper.meta`, not in `paper.text`.** They are the app's mark
 *     for where it cut, not characters the document contains, and colouring them as the
 *     document's ink would be a small lie about the evidence. This is also what stops
 *     `…nd the total payable` from reading as a typo.
 *   - **The highlighter mark.** The tone's colour laid *under* the value at `MARK_OPACITY`,
 *     with the ink left alone — a marker pen on a photocopy, which is literally what a person
 *     does to a document when they are building a case. `theme-contrast.test.ts` holds the
 *     pair above AA for every tone on every surface in both schemes.
 *
 * ## The radius is deliberately not the card radius
 *
 * `RADIUS.xs` against the `lg` every card in the app carries. A sheet of paper is not a card,
 * and one border-radius on everything regardless of hierarchy is the single most recognisable
 * mark of a template. The radius is small enough to read as a cut edge rather than a pill.
 *
 * ## When the value cannot be found in the quote
 *
 * The quote renders unmarked. `markQuote` refuses any match it is not certain of, because a
 * mark on the wrong characters would point a reader at a figure their document does not
 * contain — see `markInQuote`. An unmarked excerpt is still the document's own words and still
 * worth more than a paraphrase, so nothing is hidden and nothing is faked.
 */

import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { markQuote, quoteEdges } from '@domain/analysis/excerpt';
import type { ExtractionMethod } from '@domain/enums';

import { MARK_OPACITY, withAlpha } from '../color';
import { Icon } from '../icon';
import { EXTRACTION_METHOD_ICON, EXTRACTION_METHOD_LABELS, EXTRACTION_METHOD_TONE } from '../semantics';
import { useTheme } from '../theme';
import { BORDER_WIDTH, RADIUS, type Tone } from '../tokens';
import { Row } from './Layout';
import { Text } from './Text';

export interface PaperSheetProps {
  children: React.ReactNode;
  /**
   * An accent edge, for the one sheet a caller has been asked to draw attention to — a
   * deep link landing on a specific passage, say. Left off, the sheet's own hairline is the
   * only edge it has, which is what keeps a column of them reading as pages rather than cards.
   */
  emphasis?: Tone | null;
  style?: StyleProp<ViewStyle>;
}

/**
 * A sheet of paper: the app's second material, empty.
 *
 * Callers put the document's own words inside it and colour them with `usePaper()`. `Excerpt`
 * is the common case — one quoted line with a value marked — and this is what it is built on,
 * exported for the cases that are not one line: a page of extracted text, a transcript
 * passage, a statement someone typed.
 *
 * Nothing the *app* wrote belongs in here. That is the whole distinction the material carries,
 * and it is worth more than any single layout it enables.
 */
export function PaperSheet({ children, emphasis, style }: PaperSheetProps) {
  const theme = useTheme();
  const paper = theme.colors.paper;

  return (
    <View
      style={[
        styles.sheet,
        {
          backgroundColor: paper.fill,
          borderColor: emphasis ? theme.tone(emphasis).fg : paper.border,
          borderWidth: emphasis ? BORDER_WIDTH.hairline : StyleSheet.hairlineWidth,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.md,
          gap: theme.spacing.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/**
 * The paper material's ink.
 *
 * `text` for the document's characters, `meta` for the app's own marks on the page — an
 * ellipsis where a quote was cut, a folio, a passage number. Keeping those two apart is what
 * stops `…nd the total payable` from reading as a typo in the reader's evidence.
 */
export function usePaper() {
  return useTheme().colors.paper;
}

export interface ExcerptProps {
  /**
   * The line from the document. Rendered verbatim, ellipses aside — this is evidence, and
   * nothing here paraphrases, re-cases or re-punctuates it.
   */
  quote: string;
  /**
   * The value to mark inside the quote.
   *
   * Pass the document's own wording where you have it (`ComparisonCell.sourceValue`, a
   * field's `original`) rather than the formatted display string: `₹1,80,000` does not occur
   * in a document that wrote `Rs. 1,80,000.00`, and while `markInQuote` will fall back to
   * matching the figure numerically, an exact match is one that cannot be wrong.
   */
  value?: string | null;
  /** Which tone the highlighter is. Defaults to `accent`. */
  tone?: Tone;
  /**
   * How these characters were obtained, stamped at the foot of the sheet.
   *
   * A fact about the *reading*, not about the document, which is why it sits inside the paper
   * rather than in the caller's own heading beside the document's name — and why a value read
   * off a photograph never looks like one lifted out of a PDF.
   */
  method?: ExtractionMethod | null;
  /** Replaces the method stamp for a caller that has no `ExtractionMethod` to hand. */
  reading?: string;
  /** Clamp the quote. Omit to show all of it. */
  numberOfLines?: number;
  style?: StyleProp<ViewStyle>;
}

export function Excerpt({
  quote,
  value,
  tone = 'accent',
  method,
  reading,
  numberOfLines,
  style,
}: ExcerptProps) {
  const theme = useTheme();
  const paper = theme.colors.paper;

  const text = quote.trim();
  if (text.length === 0) return null;

  const parts = markQuote(text, value);
  const edges = quoteEdges(text);
  const stamp = reading ?? (method ? EXTRACTION_METHOD_LABELS[method] : null);
  /*
    The stamp carries the *method's* tone, not the paper's meta grey, and it does so here
    rather than at the call site so the distinction cannot be forgotten by one.

    A figure a person typed, a figure a rule read off a PDF, a figure recovered from a
    photograph and a figure a model proposed are four different qualities of evidence, and on
    the screens where they sit one under another the reader has to be able to rank them
    without reading four captions. That ranking is the product; it is not styling. So it is a
    property of the component, in the same way the sans/mono split is a property of `Text`.
  */
  const stampColor = method ? theme.tone(EXTRACTION_METHOD_TONE[method]).fg : paper.meta;

  return (
    <PaperSheet style={style}>
      {/*
        One `Text` with nested runs rather than a `Row` of three. The quote has to reflow and
        wrap as a single paragraph — a row of segments would break at each mark and leave the
        marked value stranded on its own line, which is the one word that must not be
        orphaned. Nesting also keeps the whole quote a single selection target, so copying it
        yields the document's line and not three fragments.
      */}
      <Text variant="mono" selectable numberOfLines={numberOfLines} style={{ color: paper.text }}>
        {edges.leading ? <Text variant="mono" style={{ color: paper.meta }}>…</Text> : null}
        {parts.before}
        {parts.marked ? (
          <Text
            variant="mono"
            style={{
              color: paper.text,
              backgroundColor: withAlpha(theme.tone(tone).fg, MARK_OPACITY),
            }}
          >
            {parts.match}
          </Text>
        ) : null}
        {parts.after}
        {edges.trailing ? <Text variant="mono" style={{ color: paper.meta }}>…</Text> : null}
      </Text>

      {stamp ? (
        <Row gap="xs" align="center" justify="flex-end">
          {method ? (
            <Icon name={EXTRACTION_METHOD_ICON[method]} size={12} color={stampColor} />
          ) : null}
          <Text variant="monoSmall" numberOfLines={1} style={{ color: stampColor }}>
            {stamp}
          </Text>
        </Row>
      ) : null}
    </PaperSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    // Not the card radius. See the docblock: a sheet is not a card, and one radius family on
    // everything regardless of what it is holding is what makes an app look templated.
    borderRadius: RADIUS.xs,
    // Overflow is clipped so a mark's ground cannot bleed past the sheet's own edge on the
    // last line of a wrapped quote.
    overflow: 'hidden',
  },
});

/**
 * How much of a quote survives before it stops being a quote.
 *
 * `sourceQuote` is capped at 400 characters by the schema and is usually nearer 120, so this
 * bites rarely — but an AI-supplied quote can run long, and a paragraph rendered as an
 * excerpt reads as the document dumped on screen rather than a line lifted out of it.
 * Exported so callers that build their own excerpt text clamp to the same figure.
 */
export const EXCERPT_MAX_CHARS = 240;

/**
 * Shortens a quote to `EXCERPT_MAX_CHARS` around the value, keeping the value inside it.
 *
 * Cuts from the ends, not from the middle: a quote with its centre removed is a sentence the
 * document never wrote, and the point of the surrounding words is to show the value in the
 * context it appeared in. Where the value cannot be located the head is kept, which is where
 * `quoteAround` put the match anyway.
 */
export function clampQuote(quote: string, value?: string | null): string {
  const text = quote.trim();
  if (text.length <= EXCERPT_MAX_CHARS) return text;

  const parts = markQuote(text, value);
  if (!parts.marked) return text.slice(0, EXCERPT_MAX_CHARS);

  // Centre the window on the mark, then slide it back inside the string's bounds so a value
  // near either end keeps its full share of context instead of a truncated one.
  const centre = parts.before.length + parts.match.length / 2;
  const half = EXCERPT_MAX_CHARS / 2;
  const start = Math.max(0, Math.min(Math.round(centre - half), text.length - EXCERPT_MAX_CHARS));
  return text.slice(start, start + EXCERPT_MAX_CHARS);
}

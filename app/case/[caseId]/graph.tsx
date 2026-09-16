/**
 * The case's connections.
 *
 * The same records the rest of the case shows, plus the links between them: claims,
 * documents, events, people and conflicts, and the recorded connections between them
 * (asserted by the user, derived by a check, or read out of a document by AI with
 * citations).
 *
 * ## Why this screen now draws something
 *
 * It did not. It was named for a graph, described itself as one, and rendered a wrapped
 * grid of cards followed by a list of "A → relates to → B" sentences. Everything true about
 * the case was on the screen and none of the *structure* was: you could not see that six
 * documents all pointed at one claim, or that a conflict sat between two documents that
 * otherwise never met. Structure is the only thing a list cannot show and the only reason
 * to have this screen at all.
 *
 * ## Where the geometry comes from
 *
 * Not from a physics simulation, and not from a layout written here. `buildGraph` already
 * runs a layered layout: it puts each kind of record in its own band, then makes three
 * barycentre passes to order the nodes *within* each band so that lines between bands cross
 * as little as possible. That work was being thrown away — every node arrived carrying an
 * `x` and a `y` that nothing read.
 *
 * So this screen reads them, and uses them only as an *ordering*: bands are the distinct `y`
 * values in ascending order, and position within a band is `x` ascending. The pixels are
 * then re-flowed to the width the phone actually has, which is the one thing the domain
 * cannot know. That split matters — the expensive, crossing-minimising part is deterministic
 * and memoised in the domain, and the cheap part here is arithmetic over a measured width.
 * The same case draws identically on every re-render.
 *
 * Edges are plain `View`s: a 2pt rectangle as long as the distance between two nodes,
 * translated to the midpoint and rotated to the angle. `react-native-svg` is *not* a
 * dependency of this project (nor is Reanimated or Skia — see `Motion.tsx`), and a rotated
 * view per edge needs no native module, no canvas and no layout pass of its own.
 *
 * ## Why it gives up, and says so
 *
 * Past a couple of dozen nodes a band-and-line drawing on a 360pt screen stops being
 * legible and starts being a hairball, and the honest thing is to say that rather than draw
 * it anyway. Over the cap the map is replaced by a notice that names the counts and points
 * at the filters, and the lists below — which are complete either way — carry the case.
 *
 * ## Nothing internal reaches the reader
 *
 * Every endpoint name and every relationship name on this screen goes through
 * `readableToken`, and the fallbacks are phrases rather than ids. Nine sites here used to
 * print `node.id` or a raw `RelationshipType` when a lookup missed — which happens in normal
 * use, because an edge can outlive the record at its other end. A UUID in place of a
 * document's name does not read as missing data; it reads as a broken app.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildGraph, type GraphEdge, type GraphNode } from '@domain/analysis/graph';
import { EVIDENCE_KIND_LABELS, RELATIONSHIP_LABELS } from '@domain/enums';
import type { CaseAnalysis } from '@domain/models';
import { useRepository, useSession, runDirectCaseAnalysis } from '@services';
import { useCaseRecord, useWorkspace } from '@services/use-case-store';
import { CitationList } from '@features/analysis/case-analysis-panel';
import {
  BORDER_WIDTH,
  Button,
  Chip,
  Disclosure,
  Divider,
  EmptyState,
  ErrorState,
  errorDetail,
  HIT_TARGET,
  IconTile,
  LAYOUT,
  Notice,
  Pressable,
  readableError,
  readableToken,
  RELATIONSHIP_TONE,
  Row,
  ScreenScroll,
  SkeletonList,
  SPACING,
  Stack,
  Surface,
  Text,
  useTheme,
  type IconName,
  type Tone,
} from '@ui';

type FilterTab = 'ALL' | 'CLAIMS' | 'EVIDENCE' | 'CONFLICTS' | 'CONNECTIONS';

/**
 * What an empty tab says.
 *
 * One entry per tab rather than a single screen-wide message, because "nothing here" has a
 * different cause and a different remedy on each of them: the Links tab is empty when no
 * two records have been connected yet, while the Conflicts tab is empty on a case whose
 * documents simply agree — which is an answer, not a blank. Keyed on the tab's own filtered
 * results, so a case with records but no links still says something.
 *
 * Each message names what the tab would hold and what produces it. Both remedies offered
 * here exist: an assessment is the button at the top of this screen, and a link can be
 * recorded by hand from a claim's or a document's own screen.
 */
const EMPTY_STATE: Record<FilterTab, { icon: IconName; title: string; message: string }> = {
  ALL: {
    icon: 'vector-polyline',
    title: 'No records to connect yet',
    message:
      'Add a claim or upload documents to this case. The records, and the links between them, appear here as the case develops.',
  },
  CLAIMS: {
    icon: 'scale-balance',
    title: 'No claims recorded yet',
    message:
      'A claim is a statement this case has to establish. Add one from the case screen, then link the documents that bear on it.',
  },
  EVIDENCE: {
    icon: 'file-document-outline',
    title: 'No documents uploaded yet',
    message:
      'Upload the documents, messages or statements this case rests on. Each one appears here with the records it connects to.',
  },
  CONFLICTS: {
    icon: 'alert-decagram-outline',
    title: 'No conflicts found between these records',
    message:
      'A conflict is recorded when two documents disagree on an amount, a date or a position. Run an assessment to compare them.',
  },
  CONNECTIONS: {
    icon: 'vector-link',
    title: 'No links found between these records yet',
    message:
      'Links appear when two documents name the same person, amount, reference or date. Run an assessment to look for them, or record a link by hand from a claim or a document.',
  },
};

/**
 * How a connection's origin reads. Plain words; the citations carry the substance.
 *
 * "Automatic check" rather than "rule engine": the reader is being told who asserted the
 * link, and naming an internal component answers a question nobody asked. `USER` reads as
 * "Recorded by you" for the same reason — "User assertion" is the data model's word for it,
 * shown to the one person on earth who does not need to be told they are the user.
 */
const ORIGIN_LABEL: Record<GraphEdge['origin'], string> = {
  USER: 'Recorded by you',
  RULE: 'Automatic check',
  AI: 'AI reading',
};

/**
 * What each card is, in the reader's words.
 *
 * Two maps rather than one, because `entity` means different things in the two unions it
 * appears in: a bare `entity` node is a person recorded on the case, while a `reportKind`
 * of `entity` is a name an assessment found in the sources. Merging them would force one
 * label onto both.
 */
const NODE_KIND_LABEL: Record<GraphNode['kind'], string> = {
  claim: 'Claim',
  event: 'Event',
  evidence: 'Document',
  entity: 'Person',
  conflict: 'Conflict',
};

/**
 * The colour a kind of record is drawn in, on the map and in the list.
 *
 * `claim` is `accent` — the blue chip tone — and deliberately not `colors.accent`, which is
 * the gold that paints structure and selection. Gold sits 2.6° from `warn` on the hue wheel,
 * so a gold claim among a danger conflict and an info source reads as a fourth severity
 * rather than as a fourth category.
 *
 * `event` and `entity` share `neutral`, which looks like a shortcut and is not. `ok` is the
 * only tone in this system that reads as *settled*, and neither a date in the story nor a
 * name found in a document is a settled anything — spending `ok` on them would tell the
 * reader something the app has not established. The icon and the kind label do the work of
 * telling the two apart.
 */
const NODE_TONE: Record<GraphNode['kind'], Tone> = {
  claim: 'accent',
  event: 'neutral',
  evidence: 'info',
  entity: 'neutral',
  conflict: 'danger',
};

const NODE_ICON: Record<GraphNode['kind'], IconName> = {
  claim: 'scale-balance',
  event: 'calendar-clock',
  evidence: 'file-document-outline',
  entity: 'account-outline',
  conflict: 'alert-decagram-outline',
};

const REPORT_KIND_LABEL: Record<NonNullable<GraphNode['reportKind']>, string> = {
  agreement: 'Agreement',
  contradiction: 'Contradiction',
  timeline: 'Timeline entry',
  entity: 'Mentioned name',
};

/** The entity types an assessment reports, as `graph.ts` lower-cases them onto the sublabel. */
const REPORT_ENTITY_LABEL: Record<Lowercase<CaseAnalysis['entities'][number]['type']>, string> = {
  person: 'Person',
  org: 'Organisation',
  transaction: 'Transaction',
  document: 'Document',
  location: 'Location',
};

// Widened views of the two maps above, for looking up a value that is only a `string` at the
// call site. The maps stay exhaustive over their unions; only the lookup is loosened.
const REPORT_ENTITY_LOOKUP: Record<string, string | undefined> = REPORT_ENTITY_LABEL;
const EVIDENCE_KIND_LOOKUP: Record<string, string | undefined> = EVIDENCE_KIND_LABELS;

const nodeKindLabel = (node: GraphNode) =>
  node.reportKind ? REPORT_KIND_LABEL[node.reportKind] : NODE_KIND_LABEL[node.kind];

/**
 * What to call a record whose node is not in the graph.
 *
 * An edge can outlive the record at its other end — a source is deleted, or a link was
 * recorded against a record that has since moved out of the case — and this screen resolved
 * that by printing the raw id. A UUID where a document's name belongs does not read as
 * "this is gone", it reads as a fault in the app. The phrase says which of the two it is.
 */
const MISSING_RECORD = 'A record no longer in this case';

/** A record's name, guaranteed to be words. Never an id, never an enum member. */
const nodeName = (node: GraphNode | undefined): string =>
  (node ? readableToken(node.label) : '') || MISSING_RECORD;

/**
 * A relationship's name, guaranteed to be words.
 *
 * `RELATIONSHIP_LABELS` is exhaustive over the union, so the fallback only fires on a stored
 * type this build does not know about — a link written by a newer version of the app, or by a
 * detector added after this screen shipped. `readableToken` turns `ATTACHED_TO_EVENT` into
 * "Attached to event" rather than showing the reader a constant.
 */
const linkLabel = (type: GraphEdge['type']): string =>
  readableToken(RELATIONSHIP_LABELS[type] ?? type) || 'Link';

/**
 * The node's supporting line, guaranteed to be prose.
 *
 * `graph.ts` builds `sublabel` from whatever it has, and two of its paths leave a raw enum
 * there: a report entity carries its lower-cased type, and a source with no extraction falls
 * back to its `EvidenceKind`. Both are translated here rather than in the builder, which other
 * screens read too. Every other path already writes a sentence, a role or a date, and passes
 * through untouched — including a document type, which is free text and must not be run
 * through the source-kind map in case it happens to read like one.
 */
function nodeDetail(node: GraphNode): string {
  if (node.reportKind === 'entity') return REPORT_ENTITY_LOOKUP[node.sublabel] ?? node.sublabel;
  if (!node.reportKind && node.kind === 'evidence') {
    return EVIDENCE_KIND_LOOKUP[node.sublabel] ?? node.sublabel;
  }
  return node.sublabel;
}

// ---------------------------------------------------------------------------
// Map geometry
// ---------------------------------------------------------------------------

/**
 * The drawn map's dimensions, all derived from the scale.
 *
 * `NODE_SLOT` is the narrowest column a node may occupy: its 48pt marker plus enough width
 * for a two-word caption underneath. It is what decides how many nodes fit on a row, so it
 * is also what stops captions colliding — a caption is exactly one slot wide, and slots do
 * not overlap.
 *
 * `ROW_PITCH` is marker, caption and the clear air below it. Rows are pitched rather than
 * measured because the edges have to be positioned in the same coordinate space as the
 * nodes, and a measured row height is not known until after the frame the edges are drawn
 * in.
 */
/**
 * The marker is an `IconTile` inside a selection ring, and `MARKER` is derived from both
 * rather than set to the 48pt token that happens to equal them today. The edges are
 * positioned from `MARKER`, so if the ring's rule or padding changed and this did not, every
 * line in the drawing would attach a couple of points off centre — a silent, permanent
 * misalignment that nobody would trace back to a spacing token.
 */
const MARKER_BORDER = BORDER_WIDTH.thick;
const MARKER_PADDING = SPACING.xxs;
const MARKER = LAYOUT.tileSize + (MARKER_BORDER + MARKER_PADDING) * 2;
const NODE_SLOT = HIT_TARGET + SPACING.xxxl;
const ROW_PITCH = MARKER + SPACING.giant;
const CANVAS_PAD = SPACING.lg;
/** Drawn line thickness. Below 2pt a tinted line on a sunken surface is not reliably visible. */
const EDGE_WIDTH = SPACING.xxs;

/**
 * Where the map stops being a map.
 *
 * Both caps are about legibility on a phone, not about performance — a hundred rotated views
 * costs nothing. At around two dozen nodes the bands are four deep and the captions are
 * truncated to a couple of words each; past roughly fifty lines the crossings dominate and
 * no individual link can be followed. Either way the drawing has stopped answering the
 * question it was added to answer, and the screen says so instead of drawing it.
 */
const MAX_MAP_NODES = 24;
const MAX_MAP_EDGES = 48;

interface PlacedNode {
  node: GraphNode;
  /** Centre of the marker, in canvas coordinates. */
  x: number;
  y: number;
  /** Width of this node's column, which is also its caption's width. */
  slot: number;
}

interface MapLayout {
  placed: PlacedNode[];
  byId: Map<string, PlacedNode>;
  height: number;
}

/**
 * Lays the nodes out into bands at a given width.
 *
 * Bands, and the order within them, come entirely from the `x`/`y` that `buildGraph`
 * computed: distinct `y` ascending is the band order (each kind of record gets one), and `x`
 * ascending is the crossing-minimised order inside it. Nothing here re-derives either, so
 * the drawing and the domain's layout cannot disagree.
 *
 * A band wider than the screen wraps onto further rows of its own, which keeps a band's
 * nodes adjacent rather than squeezing twelve of them into a 360pt line.
 */
function layoutMap(nodes: readonly GraphNode[], width: number): MapLayout {
  const perRow = Math.max(1, Math.floor(width / NODE_SLOT));

  const bands = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const band = bands.get(node.y);
    if (band) band.push(node);
    else bands.set(node.y, [node]);
  }

  const rows: GraphNode[][] = [];
  for (const [, band] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
    const ordered = [...band].sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
    for (let index = 0; index < ordered.length; index += perRow) {
      rows.push(ordered.slice(index, index + perRow));
    }
  }

  const placed: PlacedNode[] = [];
  rows.forEach((row, rowIndex) => {
    const slot = width / row.length;
    row.forEach((node, index) => {
      placed.push({
        node,
        x: slot * (index + 0.5),
        y: CANVAS_PAD + rowIndex * ROW_PITCH + MARKER / 2,
        slot,
      });
    });
  });

  return {
    placed,
    byId: new Map(placed.map((item) => [item.node.id, item])),
    height: CANVAS_PAD * 2 + rows.length * ROW_PITCH,
  };
}

export default function EvidenceGraphScreen() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const router = useRouter();
  const theme = useTheme();
  const { user } = useSession();
  const { repository } = useRepository();
  const { workspace, loading, refreshing, error, reload } = useWorkspace(user?.id ?? null, caseId);
  const record = useCaseRecord(workspace, caseId);

  const [activeTab, setActiveTab] = useState<FilterTab>('ALL');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  /**
   * A sentence for the reader, and the provider's own words behind a disclosure.
   *
   * Both, because they are for different people: the first is what a person disputing a charge
   * needs to know, and the second is what they read out to whoever is helping them when it
   * keeps failing. Keeping only the readable sentence throws away the one string that
   * identifies the fault.
   */
  const [analysisError, setAnalysisError] = useState<{
    message: string;
    detail: string | null;
  } | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);

  const graph = useMemo(
    () =>
      buildGraph(workspace, caseId, {
        kinds: ['claim', 'event', 'evidence', 'entity', 'conflict'],
      }),
    [workspace, caseId],
  );

  const nodesMap = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

  const claimsCount = graph.nodes.filter((n) => n.kind === 'claim').length;
  const evidenceCount = graph.nodes.filter((n) => n.kind === 'evidence').length;
  const conflictCount =
    graph.nodes.filter((n) => n.kind === 'conflict').length +
    graph.edges.filter((e) => e.type === 'CONTRADICTS').length;
  const entityCount = graph.nodes.filter((n) => n.kind === 'entity').length;

  const filteredNodes = useMemo(() => {
    switch (activeTab) {
      case 'CLAIMS':
        return graph.nodes.filter((n) => n.kind === 'claim');
      case 'EVIDENCE':
        return graph.nodes.filter((n) => n.kind === 'evidence');
      case 'CONFLICTS':
        return graph.nodes.filter((n) => n.kind === 'conflict');
      case 'CONNECTIONS':
        return [];
      default:
        return graph.nodes;
    }
  }, [graph.nodes, activeTab]);

  /**
   * The links this tab is allowed to list.
   *
   * On the record tabs an edge survives if *either* endpoint is one of this tab's records.
   * Requiring both looks stricter and is wrong here: almost every real edge runs from a
   * source to a claim, an entity or a conflict, so demanding both ends be claims emptied
   * the Claims tab of the very links that are about claims. Either-end is also what the
   * heading claims — "Links (4)" under Claims means the four links that touch a claim — and
   * the list names both of its endpoints as text, so an edge reaching a record outside the
   * current filter still reads correctly rather than pointing at nothing.
   *
   * `CONFLICTS` narrows by type instead: a contradiction runs between the records that
   * disagree, not to the conflict node standing for the finding, so testing its endpoints
   * against the conflict-only node filter would hide every one of them. `ALL` and
   * `CONNECTIONS` list the case's links in full — the latter is the links view, and its
   * record list is empty by design.
   */
  const filteredEdges = useMemo(() => {
    if (activeTab === 'CONFLICTS') {
      return graph.edges.filter((e) => e.type === 'CONTRADICTS');
    }
    if (activeTab === 'CLAIMS' || activeTab === 'EVIDENCE') {
      const visible = new Set(filteredNodes.map((node) => node.id));
      return graph.edges.filter((e) => visible.has(e.from) || visible.has(e.to));
    }
    return graph.edges;
  }, [graph.edges, activeTab, filteredNodes]);

  /**
   * Which nodes the map draws.
   *
   * This tab's records, plus both endpoints of every link this tab lists. The addition is
   * what stops a drawn line pointing at nothing, and it is the only reason the Links tab —
   * which has no record list at all — has anything to draw.
   */
  const mapNodes = useMemo(() => {
    const chosen = new Map<string, GraphNode>();
    for (const node of filteredNodes) chosen.set(node.id, node);
    for (const edge of filteredEdges) {
      const from = nodesMap.get(edge.from);
      if (from) chosen.set(from.id, from);
      const to = nodesMap.get(edge.to);
      if (to) chosen.set(to.id, to);
    }
    return [...chosen.values()];
  }, [filteredNodes, filteredEdges, nodesMap]);

  const overCap = mapNodes.length > MAX_MAP_NODES || filteredEdges.length > MAX_MAP_EDGES;
  const drawMap = mapNodes.length > 0 && !overCap;

  const map = useMemo(
    () =>
      drawMap && canvasWidth > 0
        ? layoutMap(mapNodes, canvasWidth)
        : { placed: [], byId: new Map<string, PlacedNode>(), height: 0 },
    [drawMap, canvasWidth, mapNodes],
  );

  const drawnEdges = useMemo(
    () => filteredEdges.filter((edge) => map.byId.has(edge.from) && map.byId.has(edge.to)),
    [filteredEdges, map],
  );

  /** The kinds and link types actually on the canvas, so the legend names only what is drawn. */
  const legendKinds = useMemo(
    () =>
      (['claim', 'event', 'evidence', 'entity', 'conflict'] as const).filter((kind) =>
        mapNodes.some((node) => node.kind === kind),
      ),
    [mapNodes],
  );
  const legendTypes = useMemo(
    () => [...new Set(drawnEdges.map((edge) => edge.type))].sort(),
    [drawnEdges],
  );

  const selectedNode = selectedNodeId ? nodesMap.get(selectedNodeId) : null;
  const selectedEdge = selectedEdgeId ? graph.edges.find((e) => e.id === selectedEdgeId) : null;

  const connectedEdges = useMemo(() => {
    if (!selectedNodeId) return [];
    return graph.edges.filter((e) => e.from === selectedNodeId || e.to === selectedNodeId);
  }, [graph.edges, selectedNodeId]);

  /**
   * A link's colour, from the shared relationship map rather than from a local guess.
   *
   * This used to be three hand-written branches ending in `theme.colors.accent`, which put
   * the gold structural accent on every link that was neither support nor contradiction —
   * spending a colour that means "this is a control" on a meaning. `RELATIONSHIP_TONE` in
   * `semantics.ts` already assigns all ten types, and is what the rest of the app draws
   * relationships with.
   */
  const edgeTone = (edge: GraphEdge): Tone => RELATIONSHIP_TONE[edge.type];
  const edgeColor = (edge: GraphEdge) => theme.tone(edgeTone(edge)).fg;
  const nodeColor = (node: GraphNode) => theme.tone(NODE_TONE[node.kind]).fg;

  const selectNode = useCallback((nodeId: string) => {
    setSelectedNodeId((current) => (current === nodeId ? null : nodeId));
    setSelectedEdgeId(null);
  }, []);

  const onCanvasLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    // Guarded: `onLayout` fires on every re-layout, and setting an unchanged width would
    // re-run the layout memo for nothing.
    setCanvasWidth((current) => (current === next ? current : next));
  }, []);

  const openRecord = (node: GraphNode) => {
    if (node.reportKind || node.kind === 'entity' || node.kind === 'conflict') return;
    if (node.kind === 'evidence') {
      router.push({
        pathname: '/case/[caseId]/evidence/[evidenceId]',
        params: { caseId, evidenceId: node.id },
      });
    } else if (node.kind === 'claim') {
      router.push({ pathname: '/case/[caseId]/claim/[claimId]', params: { caseId, claimId: node.id } });
    } else {
      router.push({ pathname: '/case/[caseId]/event/[eventId]', params: { caseId, eventId: node.id } });
    }
  };

  async function triggerAnalysis() {
    if (!user || analyzing) return;
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      await runDirectCaseAnalysis(repository, user.id, caseId);
      reload();
    } catch (caught) {
      setAnalysisError({
        message: readableError(
          caught,
          'The assessment could not be completed. Please try it again.',
        ),
        detail: errorDetail(caught) ?? null,
      });
    } finally {
      setAnalyzing(false);
    }
  }

  return (
    <ScreenScroll
      title="Connections"
      back
      subtitle={record?.title ?? 'How the records connect'}
      onRefresh={reload}
      refreshing={refreshing}
    >
      <Stack gap="xxl" style={styles.content}>
        {error && !record ? (
          <ErrorState
            title="This case could not be opened"
            message="The links are worked out from the case itself, so there is nothing to show until it loads."
            onRetry={reload}
            detail={errorDetail(error) ?? null}
          />
        ) : !record ? (
          loading ? (
            // No counts and no cards while the case is still opening. This screen used to
            // render "0 records · 0 links" against a case it had not read yet, which is a
            // statement about the case rather than about the load.
            <SkeletonList count={4} />
          ) : (
            <EmptyState
              icon="folder-alert-outline"
              title="This case is not available"
              message="It may have been deleted, or it may belong to another account. Nothing can be shown here until it opens."
            />
          )
        ) : (
          <>
            {error ? (
              <Notice
                tone="danger"
                title="Part of this case could not be loaded"
                message={readableError(
                  error,
                  'What is shown below may be incomplete. Pull down to try again.',
                )}
                detail={errorDetail(error) ?? null}
              />
            ) : null}

            {analysisError ? (
              <Notice
                tone="danger"
                title="The assessment did not finish"
                message={analysisError.message}
                detail={analysisError.detail}
                onDismiss={() => setAnalysisError(null)}
              />
            ) : null}

            {/* Counts and the action that produces new links. */}
            <Surface padding="lg" radius="lg" style={styles.panel}>
              <Text variant="bodySmall" colorToken="textSecondary">
                Claims, documents, people and conflicts in this case, and the recorded links
                between them.
              </Text>

              {/*
                Every count is neutral. A head-count is not a finding, and painting one in
                `danger` or `ok` tells the reader the app has concluded something about the
                case from how many rows it has.
              */}
              <Row gap="sm" wrap>
                <Chip label={`${graph.nodes.length} records`} tone="neutral" />
                <Chip label={`${claimsCount} claims`} tone="neutral" />
                <Chip label={`${evidenceCount} documents`} tone="neutral" />
                <Chip label={`${graph.edges.length} links`} tone="neutral" />
                {conflictCount > 0 ? (
                  <Chip label={`${conflictCount} conflicts`} tone="neutral" />
                ) : null}
                {entityCount > 0 ? <Chip label={`${entityCount} people`} tone="neutral" /> : null}
              </Row>

              {/*
                Disabled while signed out, because `triggerAnalysis` returns early without a
                user: an enabled button that swallows the tap is worse than one that is plainly
                unavailable and says why.
              */}
              <View style={styles.assessAction}>
                <Button
                  label="Run an assessment"
                  icon="scale-balance"
                  size="sm"
                  variant="secondary"
                  loading={analyzing}
                  disabled={!user || analyzing}
                  onPress={() => void triggerAnalysis()}
                />
                {!user ? (
                  <Text variant="caption" colorToken="textSecondary">
                    Sign in to run an assessment.
                  </Text>
                ) : null}
              </View>
            </Surface>

            {/*
              Five exclusive views. Selection is the gold accent surface, not the blue CTA:
              five CTA-coloured pills wrapping onto three rows put five primary-looking
              actions on a screen that has one.
            */}
            <Row gap="sm" wrap>
              {(
                [
                  { id: 'ALL', label: `All (${graph.nodes.length})` },
                  { id: 'CLAIMS', label: `Claims (${claimsCount})` },
                  { id: 'EVIDENCE', label: `Evidence (${evidenceCount})` },
                  { id: 'CONFLICTS', label: `Conflicts (${conflictCount})` },
                  { id: 'CONNECTIONS', label: `Links (${graph.edges.length})` },
                ] as const
              ).map((tab) => {
                const selected = activeTab === tab.id;
                return (
                  <Pressable
                    key={tab.id}
                    haptic
                    pressScale={0.97}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Show ${tab.label}`}
                    onPress={() => {
                      setActiveTab(tab.id);
                      setSelectedNodeId(null);
                      setSelectedEdgeId(null);
                    }}
                    style={[
                      styles.tab,
                      {
                        paddingHorizontal: theme.spacing.lg,
                        borderRadius: theme.radius.pill,
                        borderColor: selected ? theme.colors.accent : theme.colors.border,
                        backgroundColor: selected
                          ? theme.colors.accentSurface
                          : theme.colors.surface,
                      },
                    ]}
                  >
                    <Text
                      variant="label"
                      colorToken={selected ? 'text' : 'textSecondary'}
                      numberOfLines={1}
                    >
                      {tab.label}
                    </Text>
                  </Pressable>
                );
              })}
            </Row>

            {/*
              Empty state for a tab with nothing to show. Keyed on this tab's own filtered
              results, not on the case's total record count: the Links tab has no cards by
              design, and Conflicts can be empty on a case that is full of records, so a global
              check on `graph.nodes` left both of them rendering nothing at all.
            */}
            {filteredNodes.length === 0 && filteredEdges.length === 0 ? (
              <EmptyState
                icon={EMPTY_STATE[activeTab].icon}
                title={EMPTY_STATE[activeTab].title}
                message={EMPTY_STATE[activeTab].message}
                {...(graph.nodes.length === 0
                  ? {
                      // `back`, not a push: pushing `/case/[caseId]` stacks a second copy of
                      // the case the reader arrived from, and the back button then walks them
                      // through their own history twice.
                      action: {
                        label: 'Back to the case',
                        icon: 'arrow-left' as IconName,
                        onPress: () => router.back(),
                      },
                    }
                  : {})}
              />
            ) : null}

            {overCap ? (
              <Notice
                tone="info"
                icon="vector-polyline"
                title="Too much to draw legibly"
                message={`This view holds ${mapNodes.length} records and ${filteredEdges.length} links — more than can be drawn as a map that is readable on a phone. Everything is listed in full below, and narrowing the view with the filters above will draw the part you pick.`}
              />
            ) : null}

            {drawMap ? (
              <View style={styles.section}>
                <Text variant="heading">Map of this view</Text>
                <Text variant="bodySmall" colorToken="textSecondary">
                  Each record in this view is placed in a band with others of its kind, and
                  every recorded link between them is drawn. Tap a record to read what it
                  connects to.
                </Text>

                <Surface variant="sunken" padding="none" radius="lg" style={styles.clip}>
                  <View
                    onLayout={onCanvasLayout}
                    style={map.height > 0 ? { height: map.height } : { minHeight: ROW_PITCH }}
                  >
                    {/*
                      Edges first, so a node is never covered by a line running under it. Each
                      one is a rectangle as long as the gap between two nodes, placed at the
                      midpoint and rotated — rotation is about a view's centre by default,
                      which is exactly what makes the midpoint the right anchor.
                    */}
                    {drawnEdges.map((edge) => {
                      const from = map.byId.get(edge.from);
                      const to = map.byId.get(edge.to);
                      if (!from || !to) return null;
                      const dx = to.x - from.x;
                      const dy = to.y - from.y;
                      const length = Math.hypot(dx, dy);
                      if (length === 0) return null;
                      return (
                        <View
                          key={edge.id}
                          style={[
                            styles.edgeLine,
                            {
                              left: (from.x + to.x) / 2 - length / 2,
                              top: (from.y + to.y) / 2 - EDGE_WIDTH / 2,
                              width: length,
                              backgroundColor: edgeColor(edge),
                              transform: [{ rotate: `${(Math.atan2(dy, dx) * 180) / Math.PI}deg` }],
                            },
                          ]}
                        />
                      );
                    })}

                    {map.placed.map(({ node, x, y, slot }) => {
                      const selected = selectedNodeId === node.id;
                      return (
                        <Pressable
                          key={node.id}
                          haptic
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`${nodeKindLabel(node)}: ${nodeName(node)}`}
                          onPress={() => selectNode(node.id)}
                          style={[
                            styles.mapNode,
                            { left: x - slot / 2, top: y - MARKER / 2, width: slot },
                          ]}
                        >
                          {/*
                            An inner column, because the app's `Pressable` wraps its children
                            in a transparent animated view that carries the press transform —
                            so a `gap` or an `alignItems` on the pressable itself lands on that
                            wrapper rather than on the marker and its caption.
                          */}
                          <View style={styles.mapNodeInner}>
                            {/*
                              The ring is always drawn, in the canvas's own colour when the node
                              is not selected. A ring that appears on selection would move every
                              caption by 4pt the moment a reader tapped anything.
                            */}
                            <View
                              style={[
                                styles.mapRing,
                                {
                                  borderRadius: theme.radius.lg,
                                  borderColor: selected
                                    ? theme.colors.accent
                                    : theme.colors.surfaceSunken,
                                },
                              ]}
                            >
                              <IconTile
                                icon={NODE_ICON[node.kind]}
                                tone={NODE_TONE[node.kind]}
                                size="md"
                              />
                            </View>
                            <Text
                              variant="caption"
                              center
                              numberOfLines={2}
                              colorToken={selected ? 'text' : 'textSecondary'}
                            >
                              {nodeName(node)}
                            </Text>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </Surface>

                <Row gap="sm" wrap>
                  <Text variant="caption" colorToken="textTertiary">
                    Records
                  </Text>
                  {legendKinds.map((kind) => (
                    <Chip
                      key={kind}
                      dot
                      size="sm"
                      tone={NODE_TONE[kind]}
                      label={NODE_KIND_LABEL[kind]}
                    />
                  ))}
                </Row>

                {legendTypes.length > 0 ? (
                  <Row gap="sm" wrap>
                    <Text variant="caption" colorToken="textTertiary">
                      Links
                    </Text>
                    {legendTypes.map((type) => (
                      <Chip
                        key={type}
                        dot
                        size="sm"
                        tone={RELATIONSHIP_TONE[type]}
                        label={linkLabel(type)}
                      />
                    ))}
                  </Row>
                ) : null}
              </View>
            ) : null}

            {/* Selected record inspector */}
            {selectedNode ? (
              <Surface
                padding="lg"
                radius="lg"
                style={[
                  styles.panel,
                  { borderColor: nodeColor(selectedNode), borderWidth: BORDER_WIDTH.thick },
                ]}
              >
                <Row between align="flex-start" gap="md">
                  <Row gap="sm" align="center" style={styles.flex}>
                    <IconTile
                      icon={NODE_ICON[selectedNode.kind]}
                      tone={NODE_TONE[selectedNode.kind]}
                      size="md"
                    />
                    <Stack gap="xxs" style={styles.flex}>
                      <Text variant="caption" colorToken="textTertiary">
                        {nodeKindLabel(selectedNode)}
                      </Text>
                      <Text variant="heading">{nodeName(selectedNode)}</Text>
                    </Stack>
                  </Row>
                  <Button
                    label="Close"
                    variant="ghost"
                    size="sm"
                    onPress={() => setSelectedNodeId(null)}
                  />
                </Row>

                {/*
                  No prefix on this line. What it holds depends on the record — an assessment for a
                  claim, a date for an event, a document type for a source, a role for a person —
                  so any single word in front of it ("Status:") is wrong for most of them. The
                  caption above already says what kind of record this is.
                */}
                {selectedNode.sublabel ? (
                  <Text variant="bodySmall" colorToken="textSecondary">
                    {nodeDetail(selectedNode)}
                  </Text>
                ) : null}

                {selectedNode.reason ? <Text variant="body">{selectedNode.reason}</Text> : null}

                {connectedEdges.length > 0 ? (
                  <Stack gap="sm">
                    <Text variant="label">Connected records ({connectedEdges.length})</Text>
                    {connectedEdges.map((edge, index) => {
                      const otherNode = nodesMap.get(
                        edge.from === selectedNode.id ? edge.to : edge.from,
                      );
                      return (
                        <React.Fragment key={edge.id}>
                          {index > 0 ? <Divider /> : null}
                          <Pressable
                            dimOnPress
                            pressScale={0}
                            accessibilityRole="button"
                            accessibilityLabel={`Read the ${linkLabel(edge.type)} link to ${nodeName(otherNode)}`}
                            onPress={() => setSelectedEdgeId(edge.id)}
                            style={styles.listRow}
                          >
                            <View style={[styles.listRowInner, { gap: theme.spacing.md }]}>
                              <Stack gap="xxs" style={styles.flex}>
                                <Row gap="sm" wrap>
                                  <Chip
                                    dot
                                    size="sm"
                                    tone={edgeTone(edge)}
                                    label={linkLabel(edge.type)}
                                  />
                                  <Chip
                                    size="sm"
                                    tone="neutral"
                                    label={ORIGIN_LABEL[edge.origin]}
                                  />
                                </Row>
                                <Text variant="bodySmall">{nodeName(otherNode)}</Text>
                              </Stack>
                              <Disclosure />
                            </View>
                          </Pressable>
                        </React.Fragment>
                      );
                    })}
                  </Stack>
                ) : (
                  <Text variant="caption" colorToken="textSecondary">
                    Nothing is connected to this record yet. An assessment can identify links
                    between the documents.
                  </Text>
                )}

                {selectedNode.citations && selectedNode.citations.length > 0 ? (
                  <Stack gap="md">
                    <Text variant="label">Cited passages</Text>
                    <CitationList
                      citations={selectedNode.citations}
                      workspace={workspace}
                      caseId={caseId}
                    />
                  </Stack>
                ) : null}

                {!selectedNode.reportKind &&
                ['evidence', 'claim', 'event'].includes(selectedNode.kind) ? (
                  <Button
                    label="Open full record"
                    variant="secondary"
                    iconTrailing
                    icon="arrow-right"
                    onPress={() => openRecord(selectedNode)}
                  />
                ) : null}
              </Surface>
            ) : null}

            {/* Selected link inspector */}
            {selectedEdge ? (
              <Surface
                padding="lg"
                radius="lg"
                style={[
                  styles.panel,
                  { borderColor: edgeColor(selectedEdge), borderWidth: BORDER_WIDTH.thick },
                ]}
              >
                <Row between align="center" gap="md">
                  <Text variant="heading" style={styles.flex}>
                    About this link
                  </Text>
                  <Button
                    label="Close"
                    variant="ghost"
                    size="sm"
                    onPress={() => setSelectedEdgeId(null)}
                  />
                </Row>

                <Row gap="sm" align="center" wrap>
                  <Chip label={nodeName(nodesMap.get(selectedEdge.from))} tone="neutral" />
                  {/* One arrow, between the two records, pointing the way the link runs. Two
                      arrows either side of the relationship's name read as a formula. */}
                  <Text variant="label" colorToken="textTertiary">
                    →
                  </Text>
                  <Chip label={nodeName(nodesMap.get(selectedEdge.to))} tone="neutral" />
                </Row>

                <Row gap="sm" wrap>
                  <Chip dot tone={edgeTone(selectedEdge)} label={linkLabel(selectedEdge.type)} />
                  {/* The origin as a chip, not as "Origin: …". A field name in front of a value
                      is the data model addressing the reader. */}
                  <Chip tone="neutral" label={ORIGIN_LABEL[selectedEdge.origin]} />
                </Row>

                <Text>{selectedEdge.reason}</Text>

                {selectedEdge.citations && selectedEdge.citations.length > 0 ? (
                  <CitationList
                    citations={selectedEdge.citations}
                    workspace={workspace}
                    caseId={caseId}
                  />
                ) : null}
              </Surface>
            ) : null}

            {/*
              One card holding rows, not one card per record. The old grid asked for a
              260pt minimum in two columns, which is a single column on every phone this
              ships to — so it was a column of separately-bordered cards pretending to be a
              grid.
            */}
            {filteredNodes.length > 0 ? (
              <View style={styles.section}>
                <Text variant="heading">Records in this case</Text>
                <Surface padding="none" radius="lg" style={styles.clip}>
                  {filteredNodes.map((node, index) => {
                    const selected = selectedNodeId === node.id;
                    const nodeEdges = graph.edges.filter(
                      (e) => e.from === node.id || e.to === node.id,
                    );
                    const hasConflicts = nodeEdges.some((e) => e.type === 'CONTRADICTS');
                    const hasSupport = nodeEdges.some((e) => e.type === 'SUPPORTS');

                    return (
                      <React.Fragment key={node.id}>
                        {index > 0 ? <Divider /> : null}
                        <Pressable
                          dimOnPress
                          pressScale={0}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`${nodeKindLabel(node)}: ${nodeName(node)}`}
                          onPress={() => selectNode(node.id)}
                          style={[
                            styles.listRow,
                            {
                              backgroundColor: selected
                                ? theme.colors.accentSurface
                                : theme.colors.surface,
                            },
                          ]}
                        >
                          <View style={[styles.listRowInner, { gap: theme.spacing.md }]}>
                            <IconTile
                              icon={NODE_ICON[node.kind]}
                              tone={NODE_TONE[node.kind]}
                              size="sm"
                            />
                            <Stack gap="xxs" style={styles.flex}>
                              <Text variant="caption" colorToken="textTertiary">
                                {nodeKindLabel(node)}
                              </Text>
                              <Text variant="subheading" numberOfLines={2}>
                                {nodeName(node)}
                              </Text>
                              {node.sublabel ? (
                                <Text
                                  variant="caption"
                                  colorToken="textSecondary"
                                  numberOfLines={1}
                                >
                                  {nodeDetail(node)}
                                </Text>
                              ) : null}
                            </Stack>
                            {hasConflicts ? (
                              <Chip label="Conflict" tone="danger" size="sm" />
                            ) : hasSupport ? (
                              <Chip label="Supported" tone="ok" size="sm" />
                            ) : (
                              <Chip label={`${nodeEdges.length} links`} tone="neutral" size="sm" />
                            )}
                          </View>
                        </Pressable>
                      </React.Fragment>
                    );
                  })}
                </Surface>
              </View>
            ) : null}

            {/*
              The whole row opens the link, rather than carrying three controls of its own.
              "Inspect details", "Focus source" and "Focus target" were a control each for
              what a tap on the row already means, and two of them spoke in graph vocabulary
              about records the reader knows as documents.
            */}
            {filteredEdges.length > 0 ? (
              <View style={styles.section}>
                <Text variant="heading">Links ({filteredEdges.length})</Text>
                <Surface padding="none" radius="lg" style={styles.clip}>
                  {filteredEdges.map((edge, index) => {
                    const selected = selectedEdgeId === edge.id;
                    return (
                      <React.Fragment key={edge.id}>
                        {index > 0 ? <Divider /> : null}
                        <Pressable
                          dimOnPress
                          pressScale={0}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          accessibilityLabel={`${nodeName(nodesMap.get(edge.from))} ${linkLabel(
                            edge.type,
                          )} ${nodeName(nodesMap.get(edge.to))}`}
                          onPress={() => setSelectedEdgeId(selected ? null : edge.id)}
                          style={[
                            styles.listRow,
                            {
                              backgroundColor: selected
                                ? theme.colors.accentSurface
                                : theme.colors.surface,
                            },
                          ]}
                        >
                          <View style={[styles.listRowInner, { gap: theme.spacing.md }]}>
                            <Stack gap="xs" style={styles.flex}>
                              <Row gap="xs" wrap>
                                <Text variant="label">{nodeName(nodesMap.get(edge.from))}</Text>
                                <Text variant="label" colorToken="textTertiary">
                                  →
                                </Text>
                                <Text variant="label">{nodeName(nodesMap.get(edge.to))}</Text>
                              </Row>
                              <Row gap="sm" wrap>
                                <Chip
                                  dot
                                  size="sm"
                                  tone={edgeTone(edge)}
                                  label={linkLabel(edge.type)}
                                />
                                <Chip
                                  size="sm"
                                  tone="neutral"
                                  label={ORIGIN_LABEL[edge.origin]}
                                />
                              </Row>
                              <Text variant="bodySmall" colorToken="textSecondary">
                                {edge.reason}
                              </Text>
                            </Stack>
                            <Disclosure />
                          </View>
                        </Pressable>
                      </React.Fragment>
                    );
                  })}
                </Surface>
              </View>
            ) : null}
          </>
        )}
      </Stack>
    </ScreenScroll>
  );
}

/**
 * Module-scope styles hold the layout; theme colours stay inline at the call site because
 * `useTheme()` is only callable inside a component. Same pattern as the other case screens.
 *
 * Nothing here is a bare number any more. The values that used to be (14, 10, 8, 4, 12, 40,
 * 60, 260, 440) are gone with the grid and the hand-rolled empty state that carried them;
 * what remains is either a scale token or arithmetic over one, so the map's geometry moves
 * with the spacing scale instead of drifting off it.
 */
const styles = StyleSheet.create({
  content: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  flex: { flex: 1 },
  clip: { overflow: 'hidden' },
  panel: { gap: SPACING.lg },
  // The button and the line explaining why it is unavailable travel together.
  assessAction: { gap: SPACING.xs, alignItems: 'flex-start' },
  section: { gap: SPACING.lg },
  listRow: { minHeight: HIT_TARGET, padding: SPACING.lg },
  /**
   * The row layout itself, one level in.
   *
   * `Pressable` wraps its children in the transparent view that carries the press animation,
   * so a `flexDirection` on the pressable lays *that* out rather than the row's contents —
   * the tile, the text and the chip would stack vertically. Every row on this screen is
   * therefore a pressable holding one of these. Same shape as `rowInner` on the case screen.
   */
  listRowInner: { flexDirection: 'row', alignItems: 'center' },
  tab: {
    borderWidth: BORDER_WIDTH.hairline,
    minHeight: HIT_TARGET,
    justifyContent: 'center',
  },

  // The drawn map.
  edgeLine: { position: 'absolute', height: EDGE_WIDTH },
  mapNode: { position: 'absolute' },
  mapNodeInner: { alignItems: 'center', gap: SPACING.xxs },
  // Sized and centred explicitly rather than left to the padding: the edges are positioned
  // from `MARKER`, so the ring has to *be* `MARKER`, whatever the tile inside it does.
  mapRing: {
    width: MARKER,
    height: MARKER,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: MARKER_BORDER,
    padding: MARKER_PADDING,
  },
});

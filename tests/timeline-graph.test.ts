import { beforeEach, describe, expect, it } from 'vitest';
import { buildTimeline, findTimelineGaps, outlierEvidence } from '@domain/analysis/timeline';
import { buildGraph, neighbourhood, orphanNodes } from '@domain/analysis/graph';
import { runAnalysis } from '@domain/rules/engine';
import { CASE_ID, claim, evidence, event, link, ref, resetIds, workspace } from './helpers';

const DOC = 'Invoice No: INV-2024-018\nTotal: INR 85,000.00';

beforeEach(resetIds);

describe('buildTimeline', () => {
  it('orders events chronologically', () => {
    const timeline = buildTimeline(
      workspace({
        events: [
          event('Third', '2024-03-28', { id: 'evt_third' }),
          event('First', '2024-01-20', { id: 'evt_first' }),
          event('Second', '2024-03-12', { id: 'evt_second' }),
        ],
      }),
      CASE_ID,
    );
    expect(timeline.entries.map((entry) => entry.id)).toEqual(['evt_first', 'evt_second', 'evt_third']);
    // The range is display text, since its only consumer is the case header.
    expect(timeline.range).toEqual({ from: '20 January 2024', to: '28 March 2024' });
  });

  it('places a month-precision event in its month without promoting it to the 1st', () => {
    const timeline = buildTimeline(
      workspace({ events: [event('Sometime in March', '2024-03')] }),
      CASE_ID,
    );
    const entry = timeline.entries[0]!;
    expect(entry.precision).toBe('MONTH');
    expect(entry.date?.iso).toBe('2024-03');
    expect(entry.displayDate).toBe('March 2024');
  });

  it('surfaces undated entries separately instead of dropping them', () => {
    const timeline = buildTimeline(
      workspace({ events: [event('Dated', '2024-03-12'), event('Undated', null)] }),
      CASE_ID,
    );
    expect(timeline.undatedCount).toBe(1);
    expect(timeline.groups.at(-1)?.key).toBe('undated');
    expect(timeline.groups.at(-1)?.label).toBe('No date recorded');
  });

  it('groups entries by month with a readable label', () => {
    const timeline = buildTimeline(
      workspace({ events: [event('A', '2024-03-12'), event('B', '2024-03-28'), event('C', '2024-01-20')] }),
      CASE_ID,
    );
    expect(timeline.groups.map((group) => group.label)).toEqual(['January 2024', 'March 2024']);
    expect(timeline.groups[1]?.entries).toHaveLength(2);
  });

  it('does not repeat evidence that its attached event already represents', () => {
    const occurred = event('Payment received', '2024-03-28', { id: 'evt_payment' });
    const receipt = evidence(DOC, { id: 'evd_receipt' });
    const loose = evidence('Unattached note dated 02/04/2024', { id: 'evd_loose' });
    const timeline = buildTimeline(
      workspace({
        events: [occurred],
        evidence: [receipt, loose],
        relationships: [link(ref.evidence(receipt.id), ref.event(occurred.id), 'ATTACHED_TO_EVENT')],
      }),
      CASE_ID,
      { includeEvidence: true },
    );
    const ids = timeline.entries.map((entry) => entry.id);
    expect(ids).toContain('evt_payment');
    expect(ids).toContain('evd_loose');
    expect(ids).not.toContain('evd_receipt');
  });

  it('omits evidence entirely when asked for events only', () => {
    const timeline = buildTimeline(
      workspace({ events: [event('An event', '2024-03-12')], evidence: [evidence(DOC)] }),
      CASE_ID,
      { includeEvidence: false },
    );
    expect(timeline.entries.every((entry) => entry.kind === 'event')).toBe(true);
  });

  it('marks an entry the analysis flagged as conflicted', () => {
    const handover = event('Handover', '2024-03-12', { id: 'evt_handover' });
    const mine = evidence('Delivered on 12 March 2024.');
    const theirs = evidence('Delivered on 15 March 2024 in our records.');
    const base = workspace({
      events: [handover],
      evidence: [mine, theirs],
      relationships: [
        link(ref.evidence(mine.id), ref.event(handover.id), 'SUPPORTS'),
        link(ref.evidence(theirs.id), ref.event(handover.id), 'SUPPORTS'),
      ],
    });
    const analysed = { ...base, analysisResults: runAnalysis(base, CASE_ID, 1_000).results };

    const timeline = buildTimeline(analysed, CASE_ID, { includeEvidence: false });
    expect(timeline.entries.find((entry) => entry.id === 'evt_handover')?.hasConflict).toBe(true);
  });
});

describe('timeline gaps and outliers', () => {
  it('reports long silences between dated entries', () => {
    const timeline = buildTimeline(
      workspace({ events: [event('Start', '2024-01-01'), event('End', '2024-06-01')] }),
      CASE_ID,
    );
    const gaps = findTimelineGaps(timeline);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.days).toBeGreaterThan(45);
  });

  it('reports nothing for a densely documented period', () => {
    const timeline = buildTimeline(
      workspace({ events: [event('A', '2024-03-01'), event('B', '2024-03-10'), event('C', '2024-03-20')] }),
      CASE_ID,
    );
    expect(findTimelineGaps(timeline)).toEqual([]);
  });

  it('lists evidence dated outside the span of the case events', () => {
    const inRange = evidence('Invoice Date: 12/03/2024\nTotal: INR 100.00', { id: 'evd_in_range' });
    const wayOff = evidence('Invoice Date: 12/03/2021\nTotal: INR 100.00', { id: 'evd_way_off' });
    const outliers = outlierEvidence(
      workspace({
        events: [event('Start', '2024-01-01'), event('End', '2024-06-01')],
        evidence: [inRange, wayOff],
      }),
      CASE_ID,
    );
    expect(outliers.map((item) => item.id)).toEqual(['evd_way_off']);
  });

  it('reports no outliers when the case has too few dated events to define a span', () => {
    const single = evidence('Invoice Date: 12/03/2021\nTotal: INR 100.00');
    const outliers = outlierEvidence(
      workspace({ events: [event('Only event', '2024-01-01')], evidence: [single] }),
      CASE_ID,
    );
    expect(outliers).toEqual([]);
  });

  it('gracefully returns an empty timeline when the case is not in the workspace', () => {
    const timeline = buildTimeline(workspace(), 'case_nonexistent');
    expect(timeline).toEqual({ entries: [], groups: [], undatedCount: 0, range: null });
  });

  it('gracefully returns an empty list for outlierEvidence when the case is not in the workspace', () => {
    const outliers = outlierEvidence(workspace(), 'case_nonexistent');
    expect(outliers).toEqual([]);
  });
});

describe('buildGraph', () => {
  const scenario = () => {
    const assertion = claim('The balance is outstanding', { id: 'clm_balance' });
    const occurred = event('Payment received', '2024-03-28', { id: 'evt_payment' });
    const receipt = evidence(DOC, { id: 'evd_receipt' });
    const loose = evidence('Unconnected document', { id: 'evd_loose' });
    return workspace({
      claims: [assertion],
      events: [occurred],
      evidence: [receipt, loose],
      relationships: [
        link(ref.evidence(receipt.id), ref.event(occurred.id), 'ATTACHED_TO_EVENT', { id: 'rel_attach' }),
        link(ref.evidence(receipt.id), ref.claim(assertion.id), 'SUPPORTS', { id: 'rel_support' }),
      ],
    });
  };

  it('draws edges only for stored relationships, inferring nothing', () => {
    const graph = buildGraph(scenario(), CASE_ID);
    expect(graph.edges.map((edge) => edge.id).sort()).toEqual(['rel_attach', 'rel_support']);
  });

  it('is deterministic: the same case always lays out identically', () => {
    const base = scenario();
    const first = buildGraph(base, CASE_ID);
    const second = buildGraph(base, CASE_ID);
    expect(second.nodes).toEqual(first.nodes);
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);
  });

  it('separates entity kinds into bands, claims above events above evidence', () => {
    const graph = buildGraph(scenario(), CASE_ID);
    const y = (id: string) => graph.nodes.find((node) => node.id === id)!.y;
    expect(y('clm_balance')).toBeLessThan(y('evt_payment'));
    expect(y('evt_payment')).toBeLessThan(y('evd_receipt'));
  });

  it('keeps every node inside the reported canvas', () => {
    const graph = buildGraph(scenario(), CASE_ID);
    for (const node of graph.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(graph.width);
      expect(node.y).toBeLessThanOrEqual(graph.height);
    }
  });

  it('counts edges per node so the view can size them', () => {
    const graph = buildGraph(scenario(), CASE_ID);
    expect(graph.nodes.find((node) => node.id === 'evd_receipt')?.degree).toBe(2);
    expect(graph.nodes.find((node) => node.id === 'evd_loose')?.degree).toBe(0);
  });

  it('identifies evidence nobody has connected to the case story', () => {
    const graph = buildGraph(scenario(), CASE_ID);
    expect(orphanNodes(graph).map((node) => node.id)).toEqual(['evd_loose']);
  });

  it('filters by entity kind, dropping edges that lose an endpoint', () => {
    const graph = buildGraph(scenario(), CASE_ID, { kinds: ['evidence', 'event'] });
    expect(graph.nodes.some((node) => node.kind === 'claim')).toBe(false);
    expect(graph.edges.map((edge) => edge.id)).toEqual(['rel_attach']);
  });

  it('can hide everything a person did not assert themselves', () => {
    const base = scenario();
    base.relationships.push(
      link(ref.evidence('evd_loose'), ref.claim('clm_balance'), 'SUPPORTS', {
        id: 'rel_ai',
        origin: 'AI',
      }),
    );
    // Legacy uncited AI links are excluded from both views.
    expect(buildGraph(base, CASE_ID).edges).toHaveLength(2);
    expect(buildGraph(base, CASE_ID, { userLinksOnly: true }).edges).toHaveLength(2);
  });

  it('carries the worst open finding severity onto the nodes it touches', () => {
    const base = scenario();
    const analysed = { ...base, analysisResults: runAnalysis(base, CASE_ID, 1_000).results };
    const graph = buildGraph(analysed, CASE_ID);
    // No finding in this scenario references the claim: it has a SUPPORTS link, so
    // `unsupported-claim` does not fire and nothing else reaches it.
    expect(graph.nodes.find((node) => node.id === 'clm_balance')?.severity).toBeNull();
    // `evd_loose` is connected to nothing, so `orphaned-evidence` flags it. It carries no
    // extracted dates or amounts, which downgrades the finding to LOW.
    expect(graph.nodes.find((node) => node.id === 'evd_loose')?.severity).toBe('LOW');
  });

  it('ignores findings a person has dismissed', () => {
    const base = scenario();
    const results = runAnalysis(base, CASE_ID, 1_000).results.map((result) => ({
      ...result,
      status: 'DISMISSED' as const,
    }));
    const graph = buildGraph({ ...base, analysisResults: results }, CASE_ID);
    expect(graph.nodes.every((node) => node.severity === null)).toBe(true);
  });

  it('gracefully returns an empty graph when the case is not in the workspace', () => {
    const graph = buildGraph(workspace(), 'case_nonexistent');
    expect(graph).toEqual({ nodes: [], edges: [], width: 600, height: 600 });
  });
});

describe('neighbourhood', () => {
  it('walks outward the requested number of hops', () => {
    const graph = buildGraph(
      workspace({
        claims: [claim('A claim', { id: 'clm_a' })],
        events: [event('An event', '2024-03-12', { id: 'evt_a' })],
        evidence: [evidence(DOC, { id: 'evd_a' })],
        relationships: [
          link(ref.evidence('evd_a'), ref.event('evt_a'), 'ATTACHED_TO_EVENT'),
          link(ref.event('evt_a'), ref.claim('clm_a'), 'RELEVANT_TO_CLAIM'),
        ],
      }),
      CASE_ID,
    );
    expect([...neighbourhood(graph, 'evd_a', 1)].sort()).toEqual(['evd_a', 'evt_a']);
    expect([...neighbourhood(graph, 'evd_a', 2)].sort()).toEqual(['clm_a', 'evd_a', 'evt_a']);
  });
});

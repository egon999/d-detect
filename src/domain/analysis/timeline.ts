import type { DatePrecision } from '../enums';
import type { CaseEvent, Evidence, Workspace } from '../models';
import { dateSortKey, formatDate, type NormalizedDate } from '../normalize/dates';
import { buildRuleContext } from '../rules/engine';
import { SUPPORTING_TYPES } from '../rules/support';

/**
 * Timeline derivation.
 *
 * The timeline is a *read model*: it is computed from stored events and evidence every
 * time it is shown, and nothing about it is persisted. There is therefore no second
 * source of truth that can drift out of sync with the case.
 *
 * Its defining behaviour is honesty about uncertainty. An event known only to "March
 * 2024" is placed in March, rendered as "March 2024", and never silently promoted to
 * the 1st of the month — which is what a naive `new Date(...)` would do.
 */

export interface TimelineEntry {
  id: string;
  kind: 'event' | 'evidence';
  title: string;
  description: string;
  date: NormalizedDate | null;
  precision: DatePrecision;
  /** True when the source date could be read as either day-first or month-first. */
  ambiguous: boolean;
  /** Evidence attached to this event, or the event this evidence is attached to. */
  linkedEvidenceIds: string[];
  linkedClaimIds: string[];
  /** Set when a finding references this entry, so the timeline can flag it inline. */
  hasConflict: boolean;
  /** Sort key; undated entries sort last. */
  sortKey: string;
  displayDate: string;
}

export interface TimelineGroup {
  /** `YYYY-MM` for dated groups, or `undated`. */
  key: string;
  label: string;
  entries: TimelineEntry[];
}

export interface Timeline {
  entries: TimelineEntry[];
  groups: TimelineGroup[];
  /** Entries with no usable date, surfaced separately rather than dropped. */
  undatedCount: number;
  /** Span of the dated portion, for the case header. */
  range: { from: string; to: string } | null;
}

function toNormalizedDate(field: {
  original: string;
  iso: string | null;
  precision: DatePrecision;
  ambiguous: boolean;
}): NormalizedDate {
  return {
    original: field.original,
    iso: field.iso,
    precision: field.precision,
    ambiguous: field.ambiguous,
  };
}

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function groupKeyFor(entry: TimelineEntry): string {
  if (!entry.date?.iso) return 'undated';
  return entry.date.iso.slice(0, 7);
}

function groupLabelFor(key: string): string {
  if (key === 'undated') return 'No date recorded';
  const [year, month] = key.split('-');
  const index = Number(month) - 1;
  // A year-precision entry has no month component to label.
  if (!month || Number.isNaN(index) || index < 0 || index > 11) return year ?? key;
  return `${MONTH_LABELS[index]} ${year}`;
}

/**
 * Builds the timeline for a case.
 *
 * Events always appear. Evidence appears only when `includeEvidence` is set and the
 * item is not already represented by an event it is attached to — otherwise a receipt
 * and the payment event it proves would occupy two adjacent rows saying the same thing.
 */
export function buildTimeline(
  workspace: Readonly<Workspace>,
  caseId: string,
  options: { includeEvidence?: boolean } = {},
): Timeline {
  if (!workspace.cases.some((item) => item.id === caseId)) {
    return { entries: [], groups: [], undatedCount: 0, range: null };
  }
  const context = buildRuleContext(workspace, caseId);
  const includeEvidence = options.includeEvidence ?? true;

  // Evidence ids that are already attached to an event, so they are not repeated.
  const representedEvidence = new Set<string>();
  for (const event of context.events) {
    for (const link of context.linksTo('event', event.id)) {
      if (link.from.kind === 'evidence' && SUPPORTING_TYPES.includes(link.type)) {
        representedEvidence.add(link.from.id);
      }
    }
  }

  const conflictedEventIds = new Set(
    workspace.analysisResults
      .filter(
        (result) =>
          result.caseId === caseId &&
          result.resultType === 'POSSIBLE_CONFLICT' &&
          (result.status === 'OPEN' || result.status === 'REVIEWED'),
      )
      .flatMap((result) => result.relatedEventIds),
  );

  const entries: TimelineEntry[] = [];

  for (const event of context.events) {
    const date = event.occurredAt ? toNormalizedDate(event.occurredAt) : null;
    const linkedEvidenceIds = context
      .linksTo('event', event.id)
      .filter((link) => link.from.kind === 'evidence')
      .map((link) => link.from.id);

    entries.push({
      id: event.id,
      kind: 'event',
      title: event.title,
      description: event.description,
      date,
      precision: date?.precision ?? 'UNKNOWN',
      ambiguous: date?.ambiguous ?? false,
      linkedEvidenceIds,
      linkedClaimIds: event.claimIds,
      hasConflict: conflictedEventIds.has(event.id),
      sortKey: date ? dateSortKey(date) : '9999-99-99',
      displayDate: date ? formatDate(date) : 'No date recorded',
    });
  }

  if (includeEvidence) {
    for (const item of context.evidence) {
      if (representedEvidence.has(item.id)) continue;
      const extraction = context.extractionOf(item.id);
      const anchor = extraction?.dates.find((d) => d.role === 'issued') ?? extraction?.dates[0];
      const date = anchor ? toNormalizedDate(anchor) : null;

      entries.push({
        id: item.id,
        kind: 'evidence',
        title: item.title,
        description: extraction?.summary ?? item.note,
        date,
        precision: date?.precision ?? 'UNKNOWN',
        ambiguous: date?.ambiguous ?? false,
        linkedEvidenceIds: [item.id],
        linkedClaimIds: context
          .linksFrom('evidence', item.id)
          .filter((link) => link.to.kind === 'claim')
          .map((link) => link.to.id),
        hasConflict: false,
        sortKey: date ? dateSortKey(date) : '9999-99-99',
        displayDate: date ? formatDate(date) : 'No date recorded',
      });
    }
  }

  // Stable ordering: chronological, then events before evidence on the same date, then by id.
  entries.sort(
    (a, b) =>
      a.sortKey.localeCompare(b.sortKey) ||
      (a.kind === b.kind ? 0 : a.kind === 'event' ? -1 : 1) ||
      a.id.localeCompare(b.id),
  );

  const groups: TimelineGroup[] = [];
  for (const entry of entries) {
    const key = groupKeyFor(entry);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.entries.push(entry);
    else groups.push({ key, label: groupLabelFor(key), entries: [entry] });
  }

  const dated = entries.filter((entry) => entry.date?.iso);
  const range =
    dated.length > 0
      ? { from: dated[0]!.displayDate, to: dated[dated.length - 1]!.displayDate }
      : null;

  return {
    entries,
    groups,
    undatedCount: entries.length - dated.length,
    range,
  };
}

/** Gaps longer than this hint that something in the story may be undocumented. */
const GAP_THRESHOLD_DAYS = 45;

/**
 * Finds long unexplained stretches between consecutive dated entries.
 * Presentational only — this informs the timeline UI and does not create findings,
 * because a quiet month is not itself evidence of anything.
 */
export function findTimelineGaps(timeline: Timeline): Array<{ from: string; to: string; days: number }> {
  const dated = timeline.entries.filter((entry) => entry.date?.precision === 'DAY' && entry.date.iso);
  const gaps: Array<{ from: string; to: string; days: number }> = [];

  for (let i = 1; i < dated.length; i += 1) {
    const previous = dated[i - 1]!;
    const current = dated[i]!;
    const days = Math.round(
      (Date.parse(`${current.date!.iso}T00:00:00Z`) - Date.parse(`${previous.date!.iso}T00:00:00Z`)) / 86_400_000,
    );
    if (days >= GAP_THRESHOLD_DAYS) {
      gaps.push({ from: previous.displayDate, to: current.displayDate, days });
    }
  }

  return gaps;
}

/** Evidence whose extracted dates fall outside the case's event range, worth a second look. */
export function outlierEvidence(workspace: Readonly<Workspace>, caseId: string): Evidence[] {
  if (!workspace.cases.some((item) => item.id === caseId)) return [];
  const context = buildRuleContext(workspace, caseId);
  const eventDates = context.events
    .map((event: CaseEvent) => event.occurredAt?.iso)
    .filter((iso): iso is string => Boolean(iso))
    .sort();
  if (eventDates.length < 2) return [];

  const first = eventDates[0]!;
  const last = eventDates[eventDates.length - 1]!;

  return context.evidence.filter((item) => {
    const extraction = context.extractionOf(item.id);
    const anchor = extraction?.dates.find((d) => d.precision === 'DAY' && d.iso);
    if (!anchor?.iso) return false;
    return anchor.iso < first || anchor.iso > last;
  });
}

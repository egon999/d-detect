import { formatAbsoluteDate, formatTimestamp } from '@ui/format';

import type {
  CaseAnalysis,
  CaseDetail,
  CaseItem,
  CaseReport,
  CaseSide,
  CaseStanding,
  CaseSummary,
  Coverage,
  Signal,
  Verdict,
} from '@api';

export const WIDE_LAYOUT = 1050;

export type StateTone = 'neutral' | 'accent' | 'warn' | 'ok' | 'info';

export type CaseProgressState =
  | 'reading'
  | 'nothing_added'
  | 'nothing_of_yours'
  | 'ready_to_compare'
  | 'out_of_date'
  | 'compared';

export type CaseProgress = {
  state: CaseProgressState;

  label: string;
  tone: StateTone;

  busy: boolean;
};

export function isComparisonOutOfDate(
  summary: Partial<Pick<CaseSummary, 'hasAnalysis' | 'analysisStale'>> | null | undefined,
): boolean {
  return Boolean(summary?.hasAnalysis && summary?.analysisStale);
}

export function caseProgress(
  summary: Partial<Pick<CaseSummary, 'counts' | 'hasAnalysis' | 'analysisStale' | 'myClaim'>> | null | undefined,
): CaseProgress {
  const pending = summary?.counts?.pending ?? 0;
  if (pending > 0) {
    return {
      state: 'reading',
      label: pending === 1 ? 'Still reading a file' : 'Still reading your files',
      tone: 'info',
      busy: true,
    };
  }
  if (isComparisonOutOfDate(summary ?? null)) {
    return { state: 'out_of_date', label: 'Needs comparing again', tone: 'warn', busy: false };
  }
  if (summary?.hasAnalysis) {
    return { state: 'compared', label: 'Both sides compared', tone: 'ok', busy: false };
  }
  const mine = summary?.counts?.mine ?? 0;
  const theirs = summary?.counts?.theirs ?? 0;
  if (mine + theirs === 0) {
    return { state: 'nothing_added', label: 'Nothing added yet', tone: 'neutral', busy: false };
  }
  const claimText = typeof summary?.myClaim === 'string' ? summary.myClaim.trim() : '';
  if (mine === 0 && !claimText) {
    return { state: 'nothing_of_yours', label: 'Nothing of yours yet', tone: 'warn', busy: false };
  }
  return { state: 'ready_to_compare', label: 'Ready to compare', tone: 'accent', busy: false };
}

export type SidedItems<T> = { mine: T[]; theirs: T[] };

export function groupItemsBySide<T extends { side: CaseSide }>(items: readonly T[]): SidedItems<T> {
  const mine: T[] = [];
  const theirs: T[] = [];
  for (const item of items) {
    if (item.side === 'theirs') theirs.push(item);
    else mine.push(item);
  }
  return { mine, theirs };
}

export function hasOtherSide(record: Pick<ComparableCase, 'items' | 'theirClaim'>): boolean {
  return record.theirClaim.trim().length > 0 || record.items.some((item) => item.side === 'theirs');
}

export type ComparableCase = {
  items: ReadonlyArray<Pick<CaseItem, 'side' | 'status'>>;
  myClaim: string;
  theirClaim: string;
};

export type CompareBlocker =
  | { kind: 'reading'; count: number }
  | { kind: 'nothing_added' }
  | { kind: 'nothing_readable' }
  | { kind: 'nothing_of_yours' };

export type CompareReadiness = {
  ready: boolean;

  blocker: CompareBlocker | null;

  oneSided: boolean;
};

export function compareReadiness(record: ComparableCase): CompareReadiness {
  const oneSided = !hasOtherSide(record);
  const reading = record.items.filter((item) => item.status === 'pending' || item.status === 'reading').length;
  if (reading > 0) return { ready: false, blocker: { kind: 'reading', count: reading }, oneSided };

  if (record.items.length === 0) return { ready: false, blocker: { kind: 'nothing_added' }, oneSided };

  const readable = record.items.filter((item) => item.status === 'ready');
  if (readable.length === 0) return { ready: false, blocker: { kind: 'nothing_readable' }, oneSided };

  const mineCounts = readable.some((item) => item.side === 'mine') || record.myClaim.trim().length > 0;
  if (!mineCounts) return { ready: false, blocker: { kind: 'nothing_of_yours' }, oneSided };

  return { ready: true, blocker: null, oneSided };
}

export type BlockerCopy = {
  title: string;
  message: string;

  action: string | null;
  tone: StateTone;
};

export function compareBlockerCopy(blocker: CompareBlocker): BlockerCopy {
  switch (blocker.kind) {
    case 'reading':
      return {
        title: blocker.count === 1 ? 'Still reading your file' : 'Still reading your files',
        message:
          blocker.count === 1
            ? 'One file is still being read. This usually takes a few seconds — the screen updates on its own.'
            : `${blocker.count} files are still being read. This usually takes a few seconds — the screen updates on its own.`,
        action: null,
        tone: 'info',
      };
    case 'nothing_added':
      return {
        title: 'Add something first',
        message:
          'There is nothing here to compare yet. Add a photo, a screenshot or a document — or write down what was said, which counts just the same.',
        action: 'Add what you have',
        tone: 'neutral',
      };
    case 'nothing_readable':
      return {
        title: 'Nothing could be read yet',
        message:
          'Nothing was readable in the files you added. Open each one and say what it shows, or add a clearer copy — then the two sides can be compared.',
        action: 'Open what you added',
        tone: 'warn',
      };
    case 'nothing_of_yours':
      return {
        title: 'Add something of your own first',
        message:
          'This case only holds their side so far. Add one thing of your own — a receipt, a message, or your account of what happened — so there are two sides to compare.',
        action: 'Add something of yours',
        tone: 'warn',
      };
  }
}

export function compareActionLabel(options: {
  running: boolean;
  hasComparison: boolean;
  outOfDate: boolean;
}): string {
  if (options.running) return 'Comparing both sides…';
  if (options.outOfDate) return 'Compare again';
  if (options.hasComparison) return 'Compare again';
  return 'Compare the two sides';
}

export type FailureCopy = { title: string; message: string; retryLabel: string | null };

export type CompareFailureContext = { stillReading?: number };

export function compareFailureCopy(status: number | null, context: CompareFailureContext = {}): FailureCopy {
  if (status === null || status === 0) {
    return {
      title: 'Could not reach the server',
      message: 'Nothing was lost. Check your connection and try again.',
      retryLabel: 'Try again',
    };
  }
  if (status === 400) {
    return {
      title: 'Nothing readable to compare yet',
      message: 'Add a photo, a screenshot or a document — or write down what was said — and try again.',
      retryLabel: null,
    };
  }
  if (status === 404) {
    return { title: 'This case is no longer here', message: 'It may have been deleted.', retryLabel: null };
  }
  if (status === 409) {
    const reading = context.stillReading ?? 0;
    if (reading > 0) {
      return {
        title: reading === 1 ? 'A file was still being read' : 'Some files were still being read',
        message:
          reading === 1
            ? 'One file had not finished being read, so the comparison waited rather than leaving it out. Give it a few seconds and it will start on its own.'
            : `${reading} files had not finished being read, so the comparison waited rather than leaving them out. Give it a few seconds and it will start on its own.`,
        retryLabel: null,
      };
    }
    return {
      title: 'Something changed part-way through',
      message:
        'The material moved while the two sides were being read, so nothing was saved. Running it again picks up everything.',
      retryLabel: 'Try again',
    };
  }
  if (status === 429) {
    return {
      title: 'Too many requests just now',
      message: 'Wait a minute and try again. Nothing was lost.',
      retryLabel: 'Try again',
    };
  }
  if (status === 503) {
    return {
      title: 'The two sides cannot be compared right now',
      message:
        'Comparing is switched off on this server for the moment. Everything you have added is saved and nothing is lost — the comparison will run once it is back.',
      retryLabel: null,
    };
  }
  return {
    title: 'The comparison did not finish',
    message:
      'Nothing was saved, because what came back did not hold to the material in this case — and a reading that goes beyond what you added is not worth showing you. This usually works on a second attempt.',
    retryLabel: 'Try again',
  };
}

export const STORED_COMPARISON_UNREADABLE: FailureCopy = {
  title: 'The saved comparison cannot be opened',
  message:
    'This case was compared before, and that reading can no longer be shown — it was saved by an older version of the app. Everything you added is exactly where it was. Comparing the two sides again replaces it.',
  retryLabel: 'Compare again',
};

export function storedComparisonProblem(
  record: Pick<CaseDetail, 'hasAnalysis' | 'analysis'>,
): FailureCopy | null {
  return record.hasAnalysis && record.analysis === null ? STORED_COMPARISON_UNREADABLE : null;
}

export const REPORT_OUT_OF_DATE: FailureCopy = {
  title: 'This case has changed since it was compared',
  message:
    'A report would show a reading of material you have since added to or changed. Compare the two sides again, and the report will match what is in the case.',
  retryLabel: null,
};

export type MaterialGaps = {

  reading: CaseItem[];

  needsWords: CaseItem[];

  unread: CaseItem[];

  partlySaved: CaseItem[];
};

export function materialGaps(items: readonly CaseItem[]): MaterialGaps {
  return {
    reading: items.filter((item) => item.status === 'pending' || item.status === 'reading'),
    needsWords: items.filter((item) => item.status === 'needs_context'),
    unread: items.filter((item) => item.status === 'failed' || item.status === 'unreadable'),
    partlySaved: items.filter((item) => item.fileHadMoreText),
  };
}

export function factSampleNote(facts: Pick<CaseItem['facts'], 'partial'>): string | null {
  const kinds = facts.partial ?? [];
  if (kinds.length === 0) return null;
  const named = kinds.map((kind) => FACT_KIND_LABEL[kind]);
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  return `This piece holds more ${list} than are listed here. Open the full text to see the rest.`;
}

const FACT_KIND_LABEL: Record<'amounts' | 'dates' | 'references' | 'statuses', string> = {
  amounts: 'amounts',
  dates: 'dates',
  references: 'reference numbers',
  statuses: 'words about whether it went through',
};

export function itemStateLabel(item: Pick<CaseItem, 'status' | 'kind' | 'readBy'>): {
  label: string;
  tone: StateTone;
  busy: boolean;
} {
  if (item.status === 'pending' || item.status === 'reading') {
    return { label: 'Being read', tone: 'info', busy: true };
  }
  if (item.status === 'needs_context') return { label: 'Needs your words', tone: 'accent', busy: false };
  if (item.status === 'failed' || item.status === 'unreadable') {
    return { label: 'Could not be read', tone: 'warn', busy: false };
  }
  if (item.readBy === 'described') return { label: 'Your description', tone: 'neutral', busy: false };
  if (item.kind === 'statement') return { label: 'Written down', tone: 'neutral', busy: false };
  return { label: 'Read from the file', tone: 'neutral', busy: false };
}

export function itemStateNote(item: Pick<CaseItem, 'status' | 'kind' | 'readBy' | 'fileHadMoreText'>): string {
  if (item.status === 'pending' || item.status === 'reading') {
    return 'This is being read now. It takes a few seconds, and the screen updates on its own.';
  }
  if (item.status === 'needs_context') {
    return 'Nothing could be read out of this file, so it is not in the comparison yet. Say what it shows and it counts exactly as if it had been read.';
  }
  if (item.status === 'failed' || item.status === 'unreadable') {
    return 'This could not be read, so it takes no part in the comparison. It is still here — try reading it again, add a clearer copy, or write down what it says.';
  }
  const cut = item.fileHadMoreText
    ? ' The file held more text than could be saved, so this is not all of it.'
    : '';
  if (item.readBy === 'described') {
    return `Nothing could be read from the file, so this is your own description of it — recorded as that, and counted in the comparison.${cut}`;
  }
  if (item.kind === 'statement') {
    return `You wrote this down yourself, and it is weighed the same way a document is.${cut}`;
  }
  return `This was read from the file and is counted in the comparison.${cut}`;
}

export type ReadingProgress = {

  reading: number;

  done: number;
  total: number;

  fraction: number;

  label: string;

  sentence: string;
};

export function readingProgress(
  items: ReadonlyArray<Pick<CaseItem, 'label' | 'status'>>,
): ReadingProgress | null {
  const waiting = items.filter((item) => item.status === 'pending' || item.status === 'reading');
  if (waiting.length === 0) return null;

  const total = items.length;
  const done = total - waiting.length;
  const named = waiting.slice(0, 2).map((item) => item.label);
  const head =
    waiting.length === 1
      ? `Reading ${named[0]} now.`
      : waiting.length === 2
        ? `Reading ${named[0]} and ${named[1]} now.`
        : `Reading ${waiting.length} files now.`;
  const already =
    done === 0 ? '' : done === 1 ? ' One other piece is already read.' : ` ${done} others are already read.`;

  return {
    reading: waiting.length,
    done,
    total,
    fraction: total === 0 ? 0 : done / total,
    label: waiting.length === 1 ? 'Reading one file' : `Reading ${waiting.length} files`,
    sentence: `${head}${already} Nothing is needed from you — the screen updates on its own, and the comparison starts once everything here has been read.`,
  };
}

export type CoverageDisclosure = {

  complete: boolean;
  title: string | null;
  message: string;
  tone: StateTone;

  unrecoverable: readonly string[];
};

export function coverageDisclosure(coverage: Coverage | null | undefined): CoverageDisclosure | null {
  if (!coverage) return null;
  if (coverage.note) {
    return {
      complete: false,
      title: 'What this comparison could not take in',
      message: coverage.note,
      tone: 'warn',
      unrecoverable: coverage.partlySaved,
    };
  }
  return {
    complete: true,
    title: null,
    message:
      coverage.itemsInCase === 1
        ? 'The one thing in this case was read in full and weighed.'
        : `All ${coverage.itemsInCase} things in this case were read in full and weighed.`,
    tone: 'neutral',
    unrecoverable: [],
  };
}

export type SignalGroup = 'agreed' | 'contradicted' | 'gap' | 'other';

const SIGNAL_GROUPS: Record<string, SignalGroup> = {
  shared_reference: 'agreed',
  amount_agreement: 'agreed',
  date_agreement: 'agreed',
  amount_mismatch: 'contradicted',
  date_conflict: 'contradicted',
  status_conflict: 'contradicted',
  undocumented_claim: 'gap',
  your_side_unproven: 'gap',
  no_opposing_material: 'gap',
};

export const SIGNAL_GROUP_TITLE: Record<SignalGroup, string> = {
  agreed: 'What both accounts agree on',
  contradicted: 'Where the accounts contradict each other',

  gap: 'What your material does not yet show',
  other: 'Also worth knowing',
};

export const SIGNAL_GROUP_TONE: Record<SignalGroup, StateTone> = {
  agreed: 'ok',
  contradicted: 'warn',
  gap: 'accent',
  other: 'neutral',
};

export const SIGNAL_GROUP_ORDER: SignalGroup[] = ['agreed', 'contradicted', 'gap', 'other'];

const STRENGTH_ORDER: Record<Signal['strength'], number> = { strong: 0, moderate: 1, weak: 2 };

export function groupSignals(signals: readonly Signal[]): Record<SignalGroup, Signal[]> {
  const grouped: Record<SignalGroup, Signal[]> = { agreed: [], contradicted: [], gap: [], other: [] };
  for (const signal of signals) {
    grouped[SIGNAL_GROUPS[signal.kind] ?? 'other'].push(signal);
  }
  for (const group of SIGNAL_GROUP_ORDER) {
    grouped[group].sort((left, right) => STRENGTH_ORDER[left.strength] - STRENGTH_ORDER[right.strength]);
  }
  return grouped;
}

export const STANDING_LABEL: Record<CaseStanding, string> = {
  your_account_is_better_supported: 'Your account holds up better',
  their_account_is_better_supported: 'Their account holds up better',
  evenly_matched: 'Both accounts hold up about equally',
  not_enough_evidence: 'Not enough here to tell',
};

export const CONFIDENCE_NOTE: Record<Verdict['confidence'], { label: string; detail: string; tone: StateTone }> = {
  high: {
    label: 'Enough to show someone',
    detail: 'What you have added backs this up well enough to put in front of the other side.',
    tone: 'ok',
  },
  medium: {
    label: 'Worth adding more first',
    detail: 'This holds together, but something is still open. What is missing is listed below.',
    tone: 'accent',
  },
  low: {
    label: 'Too thin to rely on',
    detail: 'There is not enough in the material to lean on this yet. Adding what is missing would change it.',
    tone: 'warn',
  },
};

export const STRENGTH_NOTE: Record<Verdict['evidence'][number]['strength'], { label: string; tone: StateTone }> = {
  strong: { label: 'Stands on its own', tone: 'ok' },
  moderate: { label: 'Needs another piece beside it', tone: 'accent' },
  weak: { label: 'Adds little on its own', tone: 'warn' },
};

export const CONFLICT_ABOUT_LABEL: Record<Verdict['conflicts'][number]['about'], string> = {
  amount: 'The amount',
  date: 'The date',
  reference: 'The reference number',
  status: 'Whether it was settled',
  what_happened: 'What happened',
};

export type StrengthenSection = {

  title: string;

  reportTitle: string;

  intro: string;
  points: ReadonlyArray<{ point: string; wouldShow: string }>;
};

export const THIN_MATERIAL_WARNING =
  'Nothing here settles the question either way. Anyone handed this should be told that first: it sets out what the material contains, not what it proves.';

export function strengthenSection(
  verdict: Pick<Verdict, 'missing' | 'standing'>,
): StrengthenSection | null {
  if (verdict.missing.length === 0) return null;

  const intro =
    verdict.standing === 'their_account_is_better_supported'
      ? 'Their account holds up better on what is here. Each of these would go directly against that.'
      : verdict.standing === 'not_enough_evidence'
        ? 'There is not enough in the case to settle it either way yet. Any one of these would change that.'
        : verdict.standing === 'evenly_matched'
          ? 'The two accounts are evenly matched on what is here, so one more thing could decide it. Any of these would.'
          : 'Your account already holds up better on what is here. Each of these would make it harder to argue with.';

  return {
    title: 'What would make your side stronger',
    reportTitle: 'What is missing that would settle it',
    intro,
    points: verdict.missing,
  };
}

export type Citation = {
  id: string;

  label: string;
  side: CaseSide;

  item: CaseItem | null;

  account: boolean;

  removed: boolean;
};

export function resolveCitations(
  ids: readonly string[],
  record: Pick<CaseDetail, 'items' | 'sources'>,
  analysis?: Pick<CaseAnalysis, 'sources'> | null,
): Citation[] {
  const items = new Map(record.items.map((item) => [item.id, item]));
  const named = new Map([...(analysis?.sources ?? []), ...record.sources].map((ref) => [ref.id, ref]));
  const seen = new Set<string>();
  const resolved: Citation[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);

    const item = items.get(id);
    if (item) {
      resolved.push({ id, label: item.label, side: item.side, item, account: false, removed: false });
      continue;
    }

    const ref = named.get(id);
    if (!ref) continue;
    resolved.push({
      id,
      label: ref.label,
      side: ref.side,
      item: null,
      account: ref.kind === 'account',
      removed: ref.kind !== 'account',
    });
  }

  return resolved;
}

export function quoteLineFor(text: string, value: string): string | null {
  const needle = value.trim();
  if (!needle || !text) return null;

  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const at = haystack.indexOf(target);
  if (at < 0) return null;

  let start = text.lastIndexOf('\n', at) + 1;
  let end = text.indexOf('\n', at);
  if (end < 0) end = text.length;

  const WINDOW = 160;
  let prefix = '';
  let suffix = '';
  if (at - start > WINDOW) {
    start = at - WINDOW;
    prefix = '…';
  }
  if (end - (at + needle.length) > WINDOW) {
    end = at + needle.length + WINDOW;
    suffix = '…';
  }

  const line = text.slice(start, end).trim();
  return line ? `${prefix}${line}${suffix}` : null;
}

function reportSection(lines: string[], heading: string, body: string[]): void {
  if (body.length === 0) return;
  lines.push(heading.toUpperCase(), '');
  lines.push(...body);
  lines.push('');
}

export function buildReportText(report: CaseReport): string {
  const lines: string[] = [report.title, '', `Prepared ${formatTimestamp(report.preparedAt)}`];
  if (report.question.trim()) lines.push(`What needs settling: ${report.question.trim()}`);
  lines.push('');

  reportSection(lines, 'The two accounts', [
    ...(report.myClaim.trim() ? [`Mine: ${report.myClaim.trim()}`] : []),
    ...(report.theirClaim.trim() ? [`Theirs: ${report.theirClaim.trim()}`] : []),
  ]);

  const sided = groupItemsBySide(report.items);
  for (const [heading, items] of [
    ['What I have', sided.mine],
    ['What they are saying', sided.theirs],
  ] as const) {
    reportSection(
      lines,
      heading,
      items.flatMap((item) => {
        const state = itemStateLabel(item);
        const head = `- ${item.label} (${state.label.toLowerCase()})`;
        const text = item.text.trim();
        const body = text ? [`  ${text.replace(/\n+/g, '\n  ')}`] : [];
        const cut = item.fileHadMoreText
          ? ['  (The file held more text than could be saved, so this is not all of it.)']
          : [];
        return [head, ...body, ...cut, ''];
      }),
    );
  }

  const grouped = groupSignals(report.signals);
  for (const group of SIGNAL_GROUP_ORDER) {
    reportSection(
      lines,
      SIGNAL_GROUP_TITLE[group],
      grouped[group].flatMap((signal) => [`- ${signal.headline}`, `  ${signal.detail}`]),
    );
  }

  const verdict = report.analysis;
  if (verdict) {
    reportSection(lines, 'What the material as a whole supports', [
      report.standingText ?? STANDING_LABEL[verdict.standing],
      '',
      verdict.headline,
      '',
      verdict.summary,
      '',

      report.confidenceText ?? CONFIDENCE_NOTE[verdict.confidence].detail,
      ...(verdict.standing === 'not_enough_evidence' ? ['', THIN_MATERIAL_WARNING] : []),
    ]);
    reportSection(
      lines,
      'Where the accounts disagree',
      verdict.conflicts.flatMap((conflict) => [
        `- ${conflict.point}`,
        ...(conflict.yourSide ? [`  Mine: ${conflict.yourSide}`] : []),
        ...(conflict.theirSide ? [`  Theirs: ${conflict.theirSide}`] : []),
        ...(conflict.reading ? [`  ${conflict.reading}`] : []),
      ]),
    );
    reportSection(lines, 'What the material backs up', verdict.supported.map((point) => `- ${point.point}`));
    reportSection(
      lines,
      'What the material does not back up',
      verdict.notSupported.map((point) => `- ${point.point}`),
    );
    const strengthen = strengthenSection(verdict);
    if (strengthen) {
      reportSection(lines, strengthen.reportTitle, [
        strengthen.intro,
        '',
        ...strengthen.points.flatMap((gap) => [`- ${gap.point}`, ...(gap.wouldShow ? [`  ${gap.wouldShow}`] : [])]),
      ]);
    }
    reportSection(lines, 'What to do next', [verdict.nextStep]);
  }

  if (report.coverage?.note) reportSection(lines, 'What this comparison did not cover', [report.coverage.note]);

  lines.push(
    'This sets out what the attached material contains and what follows from it. It is not legal advice and not a decision by any authority.',
  );

  return lines.join('\n');
}

export function reportFileName(title: string, preparedAt: number): string {
  const safe = title.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60);
  return `${safe || 'Case'} — ${formatAbsoluteDate(preparedAt)}.txt`;
}

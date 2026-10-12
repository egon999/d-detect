import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

import { accountOf } from '../auth.ts';
import { db } from '../db.ts';
import { readableSourceText } from '../extract.ts';
import { collectOrphanFiles, isAudio, isImage } from '../files.ts';
import { formatMinorUnits, normalizeCurrency } from '../money.ts';
import type { Account } from '../auth.ts';
import type { Context } from 'hono';

type Variables = { account: Account };

const account = new Hono<{ Variables: Variables }>();

type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  display_name: string | null;
  currency: string | null;
  locale: string | null;
  created_at: number;
};

function userRow(owner: string): UserRow {
  const row = db
    .prepare('SELECT id, email, name, display_name, currency, locale, created_at FROM users WHERE id = ?')
    .get(owner) as UserRow | undefined;
  if (!row) throw new HTTPException(401, { message: 'Sign in to continue.' });
  return row;
}

type StoredSummary = {
  entries: number;
  meetings: number;
  tasks: number;
  cases: number;
  files: number;
  bytes: number;
  sizeLabel: string;
};

function storedSummary(owner: string): StoredSummary {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM records  WHERE user_id = ?) AS entries,
         (SELECT COUNT(*) FROM meetings WHERE user_id = ?) AS meetings,
         (SELECT COUNT(*) FROM tasks    WHERE user_id = ?) AS tasks,
         (SELECT COUNT(*) FROM cases    WHERE user_id = ?) AS cases,
         (SELECT COUNT(*) FROM files    WHERE user_id = ?) AS files,
         (SELECT COALESCE(SUM(bytes), 0) FROM files WHERE user_id = ?) AS bytes`,
    )
    .get(owner, owner, owner, owner, owner, owner) as Omit<StoredSummary, 'sizeLabel'>;

  return {
    ...row,
    sizeLabel: sizeLabel(row.bytes),
  };
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

type Profile = {
  id: string;
  email: string | null;
  name: string | null;
  displayName: string | null;
  currency: string | null;
  locale: string | null;
  createdAt: number;
  stored: StoredSummary;
};

function profile(row: UserRow): Profile {
  return {
    id: row.id,
    email: row.email,
    name: row.display_name ?? row.name,
    displayName: row.display_name,
    currency: row.currency,
    locale: row.locale,
    createdAt: row.created_at,
    stored: storedSummary(row.id),
  };
}

account.get('/', (context) => context.json(profile(userRow(accountOf(context).id))));

const MAX_NAME = 80;
const MAX_LOCALE = 35;

const CURRENCY_NOTE =
  'Saved as your preferred currency. Anything you have already saved keeps the currency ' +
  'it was recorded in, and nothing is converted.';

const Patch = z.object({
  displayName: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  locale: z.string().nullable().optional(),
});

function canonicalLocale(raw: string): string | null {
  if (raw.length > MAX_LOCALE) return null;
  try {
    return Intl.getCanonicalLocales(raw)[0] ?? null;
  } catch {
    return null;
  }
}

account.patch('/', async (context) => {
  const owner = accountOf(context).id;
  const before = userRow(owner);

  const parsed = Patch.safeParse(await context.req.json().catch(() => ({})));

  if (!parsed.success) {
    throw new HTTPException(400, { message: 'That change could not be saved. Check what you typed and try again.' });
  }
  const patch = parsed.data;

  const columns: string[] = [];
  const values: Array<string | null> = [];

  if (patch.displayName !== undefined) {

    const name = (patch.displayName ?? '').replace(/\s+/g, ' ').trim();
    if (name.length > MAX_NAME) {
      throw new HTTPException(400, { message: `That name is too long. Use ${MAX_NAME} characters or fewer.` });
    }
    columns.push('display_name = ?');
    values.push(name || null);
  }

  if (patch.currency !== undefined) {
    const typed = (patch.currency ?? '').trim();

    const code = typed ? normalizeCurrency(typed) : null;
    if (typed && !code) {
      throw new HTTPException(400, {
        message: 'That is not a currency we recognise. Enter a three-letter currency code, like INR for rupees.',
      });
    }
    columns.push('currency = ?');
    values.push(code);
  }

  if (patch.locale !== undefined) {
    const typed = (patch.locale ?? '').trim();
    const tag = typed ? canonicalLocale(typed) : null;
    if (typed && !tag) {
      throw new HTTPException(400, {
        message: 'That is not a language setting we recognise. Pick your language and region from the list.',
      });
    }
    columns.push('locale = ?');
    values.push(tag);
  }

  if (columns.length === 0) throw new HTTPException(400, { message: 'There was nothing to change.' });

  db.prepare(`UPDATE users SET ${columns.join(', ')} WHERE id = ?`).run(...values, owner);

  const after = userRow(owner);
  return context.json({
    ...profile(after),
    note: after.currency !== before.currency ? CURRENCY_NOTE : null,
  });
});

function plainly(token: string | null | undefined): string | null {
  if (!token) return null;
  const words = token.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : null;
}

function labelled(map: Record<string, string>, token: string | null | undefined): string | null {
  if (!token) return null;
  return map[token] ?? plainly(token);
}

const ENTRY_STATUS: Record<string, string> = {
  complete: 'Complete',
  needs_context: 'Waiting on one question',
  processing: 'Still being read',
  unreadable: 'Nothing could be read from it',
  failed: 'Could not be read',
};

const MEETING_STATUS: Record<string, string> = {
  transcribing: 'Being written out',
  transcribed: 'Written out',
  complete: 'Complete',
  failed: 'Could not be written out',
};

const EVIDENCE_STATUS: Record<string, string> = {
  pending: 'Still being read',
  reading: 'Still being read',
  ready: 'Read',
  needs_context: 'Waiting on your description',
  unreadable: 'Nothing could be read from it',
  failed: 'Could not be read',
};

const CASE_STATUS: Record<string, string> = { open: 'Open', resolved: 'Settled' };

const DIRECTION: Record<string, string> = { out: 'Money out', in: 'Money in' };

const SIDE: Record<string, string> = { mine: 'Your side', theirs: 'Their side' };

const PRECISION: Record<string, string> = {
  minute: 'To the minute',
  day: 'To the day',
  month: 'To the month',
  year: 'To the year',
};

const NOTICED_KIND: Record<string, string> = {
  commitment: 'A promise someone made',
  renewal: 'Something coming up for renewal',
  anomaly: 'Something that looks wrong',
};

const NOTICED_STATUS: Record<string, string> = {
  open: 'Not dealt with yet',
  done: 'Dealt with',
  dismissed: 'Set aside',
};

const BUDGET_PERIOD: Record<string, string> = { monthly: 'Every month' };

function fileKind(mime: string): string {
  if (isImage(mime)) return 'Picture';
  if (isAudio(mime)) return 'Audio recording';
  if (mime === 'application/pdf') return 'PDF document';
  if (mime.includes('wordprocessingml')) return 'Word document';
  if (mime.startsWith('text/')) return 'Text file';
  return 'File';
}

type Amount = { minorUnits: number; currency: string | null; label: string | null } | null;

function amount(minor: number | null, currency: string | null): Amount {
  if (minor === null) return null;
  const code = currency ?? null;
  return { minorUnits: minor, currency: code, label: code ? formatMinorUnits(minor, code) : null };
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const chosen: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) chosen[key] = source[key];
  return chosen;
}

function dateStamp(at: number): string {
  const when = new Date(at);
  const month = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return `${when.getFullYear()}-${month}-${day}`;
}

type Rows = Record<string, unknown>;

function exportDocument(user: UserRow): Rows {
  const owner = user.id;
  const exportedAt = Date.now();
  const all = <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[];

  type FileRow = { id: string; mime: string; bytes: number; original_name: string; created_at: number };
  const files = all<FileRow>(
    'SELECT id, mime, bytes, original_name, created_at FROM files WHERE user_id = ? ORDER BY created_at',
    owner,
  );

  type RecordRow = {
    id: string;
    kind: string;
    title: string;
    occurred_at: number | null;
    occurred_precision: string | null;
    amount_minor: number | null;
    currency: string | null;
    direction: string | null;
    counterparty: string | null;
    category: string | null;
    note: string | null;
    file_id: string | null;
    extraction: string;
    status: string;
    created_at: number;
    updated_at: number;
  };
  const records = all<RecordRow>('SELECT * FROM records WHERE user_id = ? ORDER BY created_at', owner);

  type QuestionRow = {
    record_id: string;
    field: string;
    prompt: string;
    answer: string | null;
    answered_at: number | null;
    created_at: number;
  };
  const questions = all<QuestionRow>(
    `SELECT record_id, field, prompt, answer, answered_at, created_at FROM questions
      WHERE record_id IN (SELECT id FROM records WHERE user_id = ?) ORDER BY created_at`,
    owner,
  );
  const askedAbout = new Map<string, QuestionRow[]>();
  for (const row of questions) {
    const list = askedAbout.get(row.record_id) ?? [];
    list.push(row);
    askedAbout.set(row.record_id, list);
  }

  const entries = records.map((row) => {

    const read = parseObject(row.extraction);
    return {
      id: row.id,
      what: row.title,
      kind: plainly(row.kind),
      happenedAt: row.occurred_at,
      happenedAtKnown: labelled(PRECISION, row.occurred_precision),
      amount: amount(row.amount_minor, row.currency),
      direction: labelled(DIRECTION, row.direction),
      otherParty: row.counterparty,
      category: row.category,
      yourNote: row.note,
      state: labelled(ENTRY_STATUS, row.status),
      summary: text(read.summary),
      reference: text(read.reference),

      whatTheDocumentSaid: text(readableSourceText(text(read.sourceText))),
      file: row.file_id,
      questionsAsked: (askedAbout.get(row.id) ?? []).map((question) => ({
        about: plainly(question.field),
        asked: question.prompt,
        yourAnswer: question.answer,
        answeredAt: question.answered_at,
        askedAt: question.created_at,
      })),
      savedAt: row.created_at,
      lastChangedAt: row.updated_at,
    };
  });

  type MeetingRow = {
    id: string;
    title: string;
    note: string;
    file_id: string | null;
    language: string | null;
    duration_ms: number | null;
    transcript: string | null;
    summary: string | null;
    status: string;
    started_at: number;
    started_at_estimated: number;
    ended_at: number | null;
    intelligence: string;
    created_at: number;
    updated_at: number;
  };
  const meetings = all<MeetingRow>('SELECT * FROM meetings WHERE user_id = ? ORDER BY started_at', owner).map(
    (row) => {
      const read = parseObject(row.intelligence);
      return {
        id: row.id,
        title: row.title,
        yourNote: row.note || null,
        language: row.language,
        startedAt: row.started_at,

        startedAtWasEstimated: row.started_at_estimated === 1,
        endedAt: row.ended_at,
        lengthMs: row.duration_ms,
        state: labelled(MEETING_STATUS, row.status),
        summary: row.summary,
        transcript: row.transcript,
        highlights: pick(read, ['topics', 'keyPoints', 'decisions', 'attention']),
        file: row.file_id,
        savedAt: row.created_at,
        lastChangedAt: row.updated_at,
      };
    },
  );

  type TaskRow = {
    id: string;
    text: string;
    owner_name: string | null;
    due_at: number | null;
    done_at: number | null;
    meeting_id: string | null;
    record_id: string | null;
    priority: string;
    created_at: number;
  };
  const tasks = all<TaskRow>('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at', owner).map((row) => ({
    id: row.id,
    toDo: row.text,
    whoseJob: row.owner_name,
    importance: plainly(row.priority),
    dueAt: row.due_at,
    doneAt: row.done_at,
    fromMeeting: row.meeting_id,
    fromEntry: row.record_id,
    savedAt: row.created_at,
  }));

  type CaseRow = {
    id: string;
    title: string;
    question: string;
    my_claim: string;
    their_claim: string;
    status: string;
    source_record_id: string | null;
    created_at: number;
    updated_at: number;
  };
  type ItemRow = {
    id: string;
    case_id: string;
    side: string;
    label: string;
    text: string;
    kind: string;
    status: string;
    file_id: string | null;
    extraction: string;
    created_at: number;
  };
  type AnalysisRow = { id: string; case_id: string; result: string; created_at: number };

  const items = all<ItemRow>(
    'SELECT * FROM case_items WHERE user_id = ? ORDER BY created_at',
    owner,
  );

  const analyses = all<AnalysisRow>(
    'SELECT id, case_id, result, created_at FROM analyses WHERE user_id = ? ORDER BY created_at',
    owner,
  );

  const cases = all<CaseRow>('SELECT * FROM cases WHERE user_id = ? ORDER BY created_at', owner).map((row) => ({
    id: row.id,
    title: row.title,
    question: row.question,
    yourAccount: row.my_claim || null,
    theirAccount: row.their_claim || null,
    state: labelled(CASE_STATUS, row.status),
    fromEntry: row.source_record_id,
    evidence: items
      .filter((item) => item.case_id === row.id)
      .map((item) => {
        const read = parseObject(item.extraction);
        return {
          id: item.id,
          whose: labelled(SIDE, item.side),
          label: item.label,
          kind: plainly(item.kind),
          state: labelled(EVIDENCE_STATUS, item.status),

          words: text(readableSourceText(text(read.sourceText))) ?? (item.text || null),
          file: item.file_id,
          savedAt: item.created_at,
        };
      }),
    readings: analyses
      .filter((analysis) => analysis.case_id === row.id)
      .map((analysis) => ({ id: analysis.id, at: analysis.created_at, ...parseObject(analysis.result) })),
    startedAt: row.created_at,
    lastChangedAt: row.updated_at,
  }));

  type BudgetRow = {
    id: string;
    period: string;
    amount_minor: number;
    currency: string;
    created_at: number;
    updated_at: number;
  };
  const budgets = all<BudgetRow>('SELECT * FROM budgets WHERE user_id = ? ORDER BY created_at', owner).map((row) => ({
    id: row.id,
    covers: labelled(BUDGET_PERIOD, row.period),
    amount: amount(row.amount_minor, row.currency),
    setAt: row.created_at,
    lastChangedAt: row.updated_at,
  }));

  type SignalRow = {
    id: string;
    kind: string;
    title: string;
    detail: string;
    quote: string | null;
    due_at: number | null;
    amount_minor: number | null;
    currency: string | null;
    sources: string;
    status: string;
    created_at: number;
    updated_at: number;
    resolved_at: number | null;
  };
  const noticed = all<SignalRow>('SELECT * FROM signals WHERE user_id = ? ORDER BY created_at', owner).map((row) => {
    let sources: Array<{ kind: string; id: string }> = [];
    try {
      const parsed: unknown = JSON.parse(row.sources);
      if (Array.isArray(parsed)) {
        sources = parsed.filter(
          (entry): entry is { kind: string; id: string } =>
            !!entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string',
        );
      }
    } catch {
      sources = [];
    }
    return {
      id: row.id,

      kind: labelled(NOTICED_KIND, row.kind),
      title: row.title,
      detail: row.detail || null,
      fromYourWords: row.quote,
      dueAt: row.due_at,
      amount: amount(row.amount_minor, row.currency),

      basedOn: sources.map((source) => ({ kind: source.kind === 'meeting' ? 'meeting' : 'entry', id: source.id })),
      state: labelled(NOTICED_STATUS, row.status),
      noticedAt: row.created_at,
      dealtWithAt: row.resolved_at,
    };
  });

  const storedFiles = files.map((row) => ({
    id: row.id,
    name: row.original_name,
    kind: fileKind(row.mime),
    bytes: row.bytes,
    sizeLabel: sizeLabel(row.bytes),
    addedAt: row.created_at,
  }));

  const bytes = files.reduce((total, row) => total + row.bytes, 0);

  return {
    product: 'D-Detect',
    downloadName: `d-detect-${dateStamp(exportedAt)}.json`,
    exportedAt,
    howToReadThis: [
      'This is everything saved in your D-Detect account on the day it was exported.',
      'Every amount is a whole number in the smallest unit of its own currency — 249900 with INR beside it means two thousand four hundred and ninety-nine rupees — and the printed form is next to it.',
      'Every time is counted in milliseconds since 1 January 1970. Where only a month or a year was known, it says so instead of pretending to a day and an hour.',
      'Nothing here was converted between currencies and nothing was rounded.',
    ],
    whatIsNotHere: [
      'Your original pictures, documents and recordings are not inside this file. Only their names, what they are, how large they are and when they arrived.',
      'This download is a single data file, so it cannot carry the pictures and documents themselves. Open the entry in the app to see or save an original.',
    ],
    you: {
      name: user.display_name ?? user.name,
      email: user.email,
      currency: user.currency,
      locale: user.locale,
      accountOpenedAt: user.created_at,
    },
    entries,
    meetings,
    tasks,
    cases,
    budgets,
    noticed,
    storedFiles,
    totals: {
      entries: entries.length,
      meetings: meetings.length,
      tasks: tasks.length,
      cases: cases.length,
      evidencePieces: items.length,
      budgets: budgets.length,
      noticed: noticed.length,
      storedFiles: storedFiles.length,
      storedBytes: bytes,
      storedSizeLabel: sizeLabel(bytes),
    },
  };
}

account.get('/export', (context) => {
  const document = exportDocument(userRow(accountOf(context).id));

  const body = JSON.stringify(document, null, 2);
  return context.newResponse(body, 200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': `attachment; filename="${String(document.downloadName)}"`,
    'cache-control': 'private, no-store',
  });
});

export const DELETE_CONFIRMATION = 'delete my account';

const Confirmation = z.object({ confirm: z.string() });

function confirmed(typed: string): boolean {
  return typed.trim().replace(/\s+/g, ' ').toLowerCase() === DELETE_CONFIRMATION;
}

async function typedConfirmation(context: Context<{ Variables: Variables }>): Promise<string> {
  const parsed = Confirmation.safeParse(await context.req.json().catch(() => ({})));
  return parsed.success ? parsed.data.confirm : '';
}

type Removed = {
  entries: number;
  meetings: number;
  tasks: number;
  cases: number;
  evidencePieces: number;
  budgets: number;
  noticed: number;
  files: number;
};

function countPhrase(count: number, one: string, many: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? one : many}`;
}

function listed(parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => part !== null);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  return `${kept.slice(0, -1).join(', ')} and ${kept.at(-1)}`;
}

account.delete('/', async (context) => {
  const owner = accountOf(context).id;
  const typed = await typedConfirmation(context);
  if (!confirmed(typed)) {
    throw new HTTPException(400, {
      message:
        `Deleting your account removes everything you have stored, and it cannot be undone. ` +
        `To go ahead, type "${DELETE_CONFIRMATION}".`,
    });
  }

  const removed = db.transaction((): Omit<Removed, 'files'> => {
    const wipe = (sql: string, ...params: unknown[]): number => db.prepare(sql).run(...params).changes;

    const noticed = wipe('DELETE FROM signals WHERE user_id = ?', owner);
    wipe('DELETE FROM signal_scans WHERE user_id = ?', owner);
    wipe('DELETE FROM jobs WHERE user_id = ?', owner);
    wipe('DELETE FROM analyses WHERE user_id = ?', owner);
    const evidencePieces = wipe('DELETE FROM case_items WHERE user_id = ?', owner);
    const cases = wipe('DELETE FROM cases WHERE user_id = ?', owner);
    const tasks = wipe('DELETE FROM tasks WHERE user_id = ?', owner);
    wipe('DELETE FROM questions WHERE record_id IN (SELECT id FROM records WHERE user_id = ?)', owner);
    const entries = wipe('DELETE FROM records WHERE user_id = ?', owner);
    const meetings = wipe('DELETE FROM meetings WHERE user_id = ?', owner);
    const budgets = wipe('DELETE FROM budgets WHERE user_id = ?', owner);

    db.prepare('UPDATE files SET created_at = 0 WHERE user_id = ?').run(owner);

    return { entries, meetings, tasks, cases, evidencePieces, budgets, noticed };
  })();

  const files = collectOrphanFiles(owner);

  const remaining = (
    db.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id = ?').get(owner) as { n: number }
  ).n;

  if (remaining === 0) {
    db.prepare('DELETE FROM users WHERE id = ?').run(owner);
  } else {

    db.prepare(
      'UPDATE users SET email = NULL, name = NULL, display_name = NULL, currency = NULL, locale = NULL WHERE id = ?',
    ).run(owner);
  }

  const went = listed([
    countPhrase(removed.entries, 'entry', 'entries'),
    countPhrase(removed.meetings, 'meeting', 'meetings'),
    countPhrase(removed.tasks, 'task', 'tasks'),
    countPhrase(removed.cases, 'case', 'cases'),
    countPhrase(removed.evidencePieces, 'piece of evidence', 'pieces of evidence'),
    countPhrase(removed.budgets, 'budget', 'budgets'),
    countPhrase(removed.noticed, 'thing we had noticed', 'things we had noticed'),
    countPhrase(files, 'stored file', 'stored files'),
  ]);

  const message = [
    went
      ? `Your account is deleted, along with ${went}. This cannot be undone.`
      : 'Your account is deleted. There was nothing stored in it.',
    remaining > 0
      ? `${countPhrase(remaining, 'stored file', 'stored files')} could not be removed just now. ` +
        'They are no longer reachable from the app and will be cleared the next time the server starts.'
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  return context.json({ deleted: true, removed: { ...removed, files } satisfies Removed, message });
});

export { account };

import { db } from './db.ts';
import { exponentFor, toAsciiDigits } from './money.ts';

function detectFullText(): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.detact_fts_probe USING fts5(probe)');
    db.exec('DROP TABLE temp.detact_fts_probe');
    return true;
  } catch (cause) {
    console.error('[search] This SQLite build has no FTS5. Questions will only reach recent entries.', cause);
    return false;
  }
}

export const fullTextAvailable: boolean = detectFullText();

const STOPWORDS = new Set([

  'the', 'an', 'and', 'or', 'but', 'nor', 'if', 'than', 'then', 'as', 'so',
  'in', 'on', 'at', 'of', 'to', 'by', 'for', 'per', 'via', 'into', 'onto', 'upon', 'with', 'from',
  'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'done',
  'have', 'has', 'had', 'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'me', 'my', 'it', 'its', 'you', 'your', 'we', 'us', 'our', 'they', 'them', 'their',
  'he', 'she', 'him', 'her', 'his', 'that', 'those', 'these', 'there', 'not', 'no',

  'what', 'when', 'why', 'where', 'who', 'whom', 'whose', 'whether', 'which', 'how',
  'much', 'many', 'show', 'tell', 'list', 'give', 'about', 'all', 'any', 'each', 'every', 'some',
  'more', 'most', 'less', 'least', 'both',

  'today', 'yesterday', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
  'this', 'last', 'ago', 'recent', 'recently',

  'ka', 'ki', 'ke', 'ko', 'se', 'ne', 'hi', 'bhi', 'tak', 'liye', 'mein', 'par', 'aur',
  'kya', 'kitna', 'kitne', 'kitni', 'kaun', 'kab', 'mera', 'meri', 'mujhe', 'hai', 'tha', 'the',
  'ye', 'yeh', 'wo', 'woh', 'nahi', 'nahin',
  'aaj', 'kal', 'hafte', 'mahine', 'saal', 'pichle',
]);

export function keywords(question: string): string[] {
  const found = new Set<string>();
  for (const token of question.toLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (token.length >= 2 && !STOPWORDS.has(token)) found.add(token);
  }
  return [...found];
}

const MAX_TERMS = 16;

function isNumericTerm(term: string): boolean {
  return term.length > 0 && /^[0-9]+$/.test(term);
}

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

function digitVariants(term: string): string[] {
  if (!isNumericTerm(term)) return [term];
  const devanagari = [...term].map((digit) => DEVANAGARI_DIGITS[Number(digit)]).join('');
  const ascii = toAsciiDigits(term);
  return [...new Set([term, devanagari, ascii])];
}

function phrase(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

const WORD_COLUMNS = '{lead body dates}';

function termClause(term: string): string | null {
  const parts = digitVariants(term).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const words = parts.map((part) => `${phrase(part)} OR ${phrase(part)}*`).join(' OR ');
  const exact = parts.map((part) => phrase(part)).join(' OR ');
  return `((${WORD_COLUMNS} : (${words})) OR (meta : (${exact})))`;
}

export function matchExpression(question: string): string | null {
  const terms = keywords(question).slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  return termsExpression(terms);
}

function termsExpression(terms: string[]): string | null {
  const clauses = terms.map((term) => termClause(term)).filter((clause): clause is string => clause !== null);
  return clauses.length === 0 ? null : clauses.join(' OR ');
}

export type SearchSource = 'record' | 'meeting' | 'task' | 'case';

type SourceSpec = {
  source: SearchSource;
  table: string;
  index: string;

  lead: (prefix: string) => string;

  watched: string[];

  body: (prefix: string) => string;

  meta: (prefix: string) => string;

  dates: (prefix: string) => string;

  at: (prefix: string) => string;

  subject?: string;
};

function joined(parts: string[]): string {
  return parts.join(" || ' ' || ");
}

function jsonFields(column: string, paths: string[]): string {
  const fields = joined(paths.map((path) => `COALESCE(json_extract(${column}, '${path}'), '')`));
  return `CASE WHEN json_valid(${column}) THEN ${fields} ELSE '' END`;
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function dateWords(at: string): string {
  const millis = `(${at}) / 1000`;
  const month = `CAST(strftime('%m', ${millis}, 'unixepoch') AS INTEGER)`;
  const day = `CAST(strftime('%d', ${millis}, 'unixepoch') AS INTEGER)`;
  const names = MONTH_NAMES.map((name, position) => `WHEN ${position + 1} THEN '${name}'`).join(' ');
  return joined([
    `strftime('%Y', ${millis}, 'unixepoch')`,
    `CASE ${month} ${names} ELSE '' END`,
    `strftime('%m', ${millis}, 'unixepoch')`,
    `strftime('%d', ${millis}, 'unixepoch')`,
    `${day}`,
    `${month}`,
    `strftime('%Y-%m-%d', ${millis}, 'unixepoch')`,
  ]);
}

const SOURCES: SourceSpec[] = [
  {
    source: 'record',
    table: 'records',
    index: 'records_fts',
    watched: ['title', 'counterparty', 'category', 'note', 'kind', 'extraction'],
    at: (prefix) => `COALESCE(${prefix}.occurred_at, ${prefix}.created_at)`,
    lead: (prefix) => joined([`${prefix}.title`, `COALESCE(${prefix}.counterparty, '')`]),
    meta: (prefix) => joined([`${prefix}.kind`, `COALESCE(${prefix}.category, '')`]),
    dates: (prefix) => dateWords(`COALESCE(${prefix}.occurred_at, ${prefix}.created_at)`),
    body: (prefix) =>
      joined([
        `${prefix}.title`,
        `COALESCE(${prefix}.counterparty, '')`,
        `COALESCE(${prefix}.note, '')`,
        jsonFields(`${prefix}.extraction`, ['$.summary', '$.reference', '$.sourceText']),
      ]),
  },
  {
    source: 'meeting',
    table: 'meetings',
    index: 'meetings_fts',
    watched: ['title', 'summary', 'transcript', 'intelligence'],
    at: (prefix) => `${prefix}.started_at`,
    lead: (prefix) => `${prefix}.title`,
    meta: () => `'meeting'`,
    dates: (prefix) => dateWords(`${prefix}.started_at`),
    body: (prefix) =>
      joined([
        `${prefix}.title`,
        `COALESCE(${prefix}.summary, '')`,
        `COALESCE(${prefix}.transcript, '')`,
        jsonFields(`${prefix}.intelligence`, ['$.decisions', '$.keyPoints', '$.topics']),
      ]),
  },
  {
    source: 'task',
    table: 'tasks',
    index: 'tasks_fts',
    watched: ['text', 'owner_name'],
    at: (prefix) => `COALESCE(${prefix}.due_at, ${prefix}.created_at)`,
    lead: (prefix) => `${prefix}.text`,
    meta: (prefix) => `COALESCE(${prefix}.owner_name, '')`,
    dates: (prefix) => dateWords(`COALESCE(${prefix}.due_at, ${prefix}.created_at)`),
    body: (prefix) => `${prefix}.text`,
  },
  {
    source: 'case',
    table: 'cases',
    index: 'cases_fts',
    watched: ['title', 'question', 'my_claim', 'their_claim'],
    at: (prefix) => `${prefix}.created_at`,
    lead: (prefix) => `${prefix}.title`,
    meta: () => `'case'`,
    dates: (prefix) => dateWords(`${prefix}.created_at`),
    body: (prefix) =>
      joined([`${prefix}.title`, `${prefix}.question`, `${prefix}.my_claim`, `${prefix}.their_claim`]),
  },
  {
    source: 'case',
    table: 'case_items',
    index: 'case_items_fts',
    watched: ['label', 'text', 'extraction'],
    subject: 'case_id',
    at: (prefix) => `${prefix}.created_at`,
    lead: (prefix) => `${prefix}.label`,
    meta: () => `''`,
    dates: (prefix) => dateWords(`${prefix}.created_at`),
    body: (prefix) =>
      joined([`${prefix}.label`, `${prefix}.text`, jsonFields(`${prefix}.extraction`, ['$.sourceText'])]),
  },
];

function tableExists(name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;
}

const SHAPE_TABLE = 'search_index_shape';

function ensureShapeTable(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${SHAPE_TABLE} (index_name TEXT PRIMARY KEY, shape TEXT NOT NULL)`);
}

const TOKENIZER = `unicode61 remove_diacritics 2 categories 'L* N* Co Mc Mn'`;

function rowOf(spec: SourceSpec, prefix: string): Record<string, string> {
  return {
    lead: spec.lead(prefix),
    meta: spec.meta(prefix),
    body: spec.body(prefix),
    dates: spec.dates(prefix),
  };
}

function shapeOf(spec: SourceSpec): string {
  const row = rowOf(spec, spec.table);
  return [
    spec.table,
    spec.lead(spec.table),
    Object.values(row).join('\u0000'),
    spec.at(spec.table),
    TOKENIZER,
  ].join('\u0000');
}

function installedShape(spec: SourceSpec): string | null {
  const row = db.prepare(`SELECT shape FROM ${SHAPE_TABLE} WHERE index_name = ?`).get(spec.index) as
    | { shape: string }
    | undefined;
  return row?.shape ?? null;
}

function vocabTable(index: string): string {
  return `${index}_vocab`;
}

function install(spec: SourceSpec): void {
  const shape = shapeOf(spec);

  const columns = ['user_id', 'row_id', 'lead', 'body', 'meta', 'dates', 'recency'];
  if (!tableExists(spec.index) || installedShape(spec) !== shape) {
    const row = rowOf(spec, spec.table);
    db.transaction(() => {
      db.exec(`DROP TRIGGER IF EXISTS ${spec.index}_insert`);
      db.exec(`DROP TRIGGER IF EXISTS ${spec.index}_update`);
      db.exec(`DROP TRIGGER IF EXISTS ${spec.index}_delete`);
      db.exec(`DROP TABLE IF EXISTS ${spec.index}`);
      db.exec(
        `CREATE VIRTUAL TABLE ${spec.index} USING fts5(
           user_id UNINDEXED,
           row_id UNINDEXED,
           lead,
           body,
           meta,
           dates,
           recency UNINDEXED,
           tokenize = "${TOKENIZER.replace(/"/g, '""')}"
         )`,
      );
      db.exec(
        `INSERT INTO ${spec.index} (${columns.join(', ')})
         SELECT user_id, id, ${row.lead}, ${row.body}, ${row.meta}, ${row.dates}, ${spec.at(spec.table)}
         FROM ${spec.table}`,
      );
      db.prepare(`INSERT INTO ${SHAPE_TABLE} (index_name, shape) VALUES (?, ?)
                  ON CONFLICT(index_name) DO UPDATE SET shape = excluded.shape`).run(spec.index, shape);
    })();
  }

  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vocabTable(spec.index)} USING fts5vocab(${spec.index}, 'row')`);

  const fresh = rowOf(spec, 'new');
  const insert = `INSERT INTO ${spec.index} (${columns.join(', ')})
                  VALUES (new.user_id, new.id, ${fresh.lead}, ${fresh.body}, ${fresh.meta}, ${fresh.dates},
                          ${spec.at('new')});`;
  const remove = `DELETE FROM ${spec.index} WHERE row_id = old.id;`;
  const changed = spec.watched.map((column) => `old.${column} IS NOT new.${column}`).join(' OR ');

  db.exec(`
    DROP TRIGGER IF EXISTS ${spec.index}_insert;
    DROP TRIGGER IF EXISTS ${spec.index}_update;
    DROP TRIGGER IF EXISTS ${spec.index}_delete;

    CREATE TRIGGER ${spec.index}_insert AFTER INSERT ON ${spec.table} BEGIN
      ${insert}
    END;

    CREATE TRIGGER ${spec.index}_update AFTER UPDATE ON ${spec.table} WHEN ${changed} BEGIN
      ${remove}
      ${insert}
    END;

    CREATE TRIGGER ${spec.index}_delete AFTER DELETE ON ${spec.table} BEGIN
      ${remove}
    END;
  `);
}

export function installSearchIndexes(): void {
  if (!fullTextAvailable) return;
  ensureShapeTable();
  for (const spec of SOURCES) install(spec);
}

installSearchIndexes();

function editBudget(term: string): number {
  if (term.length < 4) return 0;
  if (term.length < 8) return 1;
  return 2;
}

const VOCAB_SCAN_LIMIT = 400;

const NEAR_MISSES_PER_TERM = 4;
const NEAR_MISSES_MAX_TERMS = 3;

function distance(left: string, right: string, budget: number): number | null {
  let previous: number[] = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current: number[] = [row];
    let best = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const value = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + cost,
      );
      current.push(value);
      if (value < best) best = value;
    }
    if (best > budget) return null;
    previous = current;
  }
  const total = previous[right.length] ?? budget + 1;
  return total <= budget ? total : null;
}

function nearMisses(index: string, term: string): string[] {
  const budget = editBudget(term);
  if (budget === 0) return [];
  const head = [...term][0];
  const rows = db
    .prepare(
      `SELECT term FROM ${vocabTable(index)}
        WHERE term >= ? AND term < ? AND length(term) >= ? AND length(term) <= ?
        ORDER BY term LIMIT ?`,
    )
    .all(head, `${head}￿`, term.length - budget, term.length + budget, VOCAB_SCAN_LIMIT) as Array<{
    term: string;
  }>;

  const scored = rows
    .filter((row) => row.term !== term)
    .map((row) => ({ term: row.term, distance: distance(term, row.term, budget) }))
    .filter((row): row is { term: string; distance: number } => row.distance !== null)
    .sort((left, right) => left.distance - right.distance || left.term.localeCompare(right.term));

  return scored.slice(0, NEAR_MISSES_PER_TERM).map((row) => row.term);
}

function hasAnyHit(spec: SourceSpec, term: string, userId: string): boolean {
  const expression = hitExpression(term);

  if (expression === null) return true;
  const row = db
    .prepare(`SELECT 1 FROM ${spec.index} WHERE ${spec.index} MATCH ? AND user_id = ? LIMIT 1`)
    .get(expression, userId);
  return row !== undefined;
}

function hitExpression(term: string): string | null {
  return termClause(term);
}

function corrections(terms: string[], specs: SourceSpec[], userId: string): Set<string> {
  const extra = new Set<string>();
  let corrected = 0;
  for (const term of terms) {
    if (corrected >= NEAR_MISSES_MAX_TERMS) break;
    if (editBudget(term) === 0) continue;

    try {
      const missed = specs.filter((spec) => !hasAnyHit(spec, term, userId));
      if (missed.length !== specs.length) continue;
      corrected += 1;
      for (const spec of missed) {
        for (const correction of nearMisses(spec.index, term)) extra.add(correction);
      }
    } catch (cause) {
      console.error('[search] spelling correction failed', { term, cause });
      return extra;
    }
  }
  return extra;
}

export type SearchHits = Record<SearchSource, string[]>;

const HITS_PER_SOURCE = 40;

function emptyHits(): SearchHits {
  return { record: [], meeting: [], task: [], case: [] };
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

const COLUMN_WEIGHTS = [0.0, 0.0, 5.0, 1.0, 0.05, 0.05].join(', ');

function byIndex(userId: string, spec: SourceSpec, match: string, terms: string[], limit: number): string[] {

  const bindings: Record<string, string | number> = { match, uid: userId, lim: limit };
  terms.forEach((term, index) => {
    bindings[`t${index}`] = `%${term.toLowerCase()}%`;
  });
  const named = terms.length
    ? terms.map((_term, index) => `(CASE WHEN lower(lead) LIKE @t${index} THEN 1 ELSE 0 END)`).join(' + ')
    : '0';

  const rows = db
    .prepare(
      `SELECT row_id FROM ${spec.index}
        WHERE ${spec.index} MATCH @match AND user_id = @uid
        ORDER BY (${named}) DESC,
                 CAST(bm25(${spec.index}, ${COLUMN_WEIGHTS}) / 0.5 AS INTEGER),
                 recency DESC
        LIMIT @lim`,
    )
    .all(bindings) as Array<{ row_id: string }>;
  return spec.subject ? subjectsOf(spec, userId, rows.map((row) => row.row_id)) : rows.map((row) => row.row_id);
}

function byScan(userId: string, spec: SourceSpec, terms: string[], limit: number): string[] {

  const haystack = `lower(${joined([spec.lead(spec.table), spec.body(spec.table), spec.meta(spec.table)])})`;

  const slots = terms.map((_term, index) => `@t${index}`);
  const looks = slots.map((slot) => `search LIKE ${slot}`);
  const names = slots.map((slot) => `name LIKE ${slot}`);
  const carried = looks.map((test) => `(CASE WHEN ${test} THEN 1 ELSE 0 END)`).join(' + ');
  const named = names.map((test) => `(CASE WHEN ${test} THEN 1 ELSE 0 END)`).join(' + ');

  const bindings: Record<string, string | number> = { uid: userId, lim: limit };
  terms.forEach((term, index) => {
    bindings[`t${index}`] = `%${term.toLowerCase()}%`;
  });

  const rows = db
    .prepare(
      `SELECT id, ${carried} AS carried FROM (
         SELECT ${spec.subject ?? 'id'} AS id, ${spec.at(spec.table)} AS at,
                lower(${spec.lead(spec.table)}) AS name,
                ${haystack} AS search
         FROM ${spec.table} WHERE user_id = @uid
       )
       WHERE ${looks.join(' OR ')}
       ORDER BY ${named} DESC, carried DESC, at DESC
       LIMIT @lim`,
    )
    .all(bindings) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function subjectsOf(spec: SourceSpec, userId: string, ids: string[]): string[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, ${spec.subject} AS subject FROM ${spec.table}
        WHERE user_id = ? AND id IN (${placeholders(ids.length)})`,
    )
    .all(userId, ...ids) as Array<{ id: string; subject: string }>;
  const bySubject = new Map(rows.map((row) => [row.id, row.subject] as const));
  return ids.map((id) => bySubject.get(id)).filter((subject): subject is string => subject !== undefined);
}

function mergeByPosition(lists: string[][]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...lists.map((list) => list.length));
  for (let position = 0; position < depth; position += 1) {
    for (const list of lists) {
      const id = list[position];
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

function amountLiterals(query: string): number[] {
  const literals = new Set<number>();
  const found = toAsciiDigits(query).match(/\d[\d.,]*/g) ?? [];
  for (const literal of found) {
    const digits = literal.replace(/[.,]/g, '');
    if (digits.length === 0 || digits.length > 12) continue;
    const value = Number(digits);
    if (!Number.isSafeInteger(value)) continue;
    literals.add(value);
  }
  return [...literals];
}

function amountCandidates(literals: number[]): number[] {
  const candidates = new Set<number>();
  for (const value of literals) {
    for (const exponent of [0, 2, 3]) candidates.add(value * 10 ** exponent);
  }
  return [...candidates].filter((value) => Number.isSafeInteger(value));
}

function amountMatches(userId: string, query: string, limit: number): string[] {
  const literals = amountLiterals(query);
  const candidates = amountCandidates(literals);
  if (candidates.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT id, amount_minor AS minor, currency FROM records
        WHERE user_id = ? AND amount_minor IS NOT NULL AND amount_minor IN (${placeholders(candidates.length)})
        ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT ?`,
    )
    .all(userId, ...candidates, limit) as Array<{ id: string; minor: number; currency: string | null }>;

  const scaled: string[] = [];
  const literal: string[] = [];
  for (const row of rows) {
    const exponent = row.currency === null ? 2 : exponentFor(row.currency);
    if (literals.some((value) => row.minor === value * 10 ** exponent)) scaled.push(row.id);
    else if (literals.includes(row.minor)) literal.push(row.id);
  }
  return [...scaled, ...literal].slice(0, limit);
}

export function search(
  userId: string,
  query: string,
  opts: { limit?: number; only?: SearchSource; amounts?: boolean; strict?: boolean } = {},
): SearchHits {
  const hits = emptyHits();
  const terms = keywords(query).slice(0, MAX_TERMS);
  const wantsAmounts = opts.amounts === true && (!opts.only || opts.only === 'record');
  if (terms.length === 0 && !wantsAmounts) return hits;

  const limit = Math.max(1, Math.min(opts.limit ?? HITS_PER_SOURCE, 200));
  const ranked: Record<SearchSource, string[][]> = { record: [], meeting: [], task: [], case: [] };

  if (wantsAmounts) {
    try {
      ranked.record.push(amountMatches(userId, query, limit));
    } catch (cause) {
      if (opts.strict) throw cause;
      console.error('[search] the amount pass failed', { query, cause });
    }
  }

  if (terms.length > 0) {

    const searched = fullTextAvailable
      ? [...new Set([...terms, ...corrections(terms, SOURCES, userId)])]
      : terms;
    const match = fullTextAvailable ? termsExpression(searched) : null;

    for (const spec of SOURCES) {
      if (opts.only && spec.source !== opts.only) continue;
      try {
        ranked[spec.source].push(
          match === null ? byScan(userId, spec, searched, limit) : byIndex(userId, spec, match, searched, limit),
        );
      } catch (cause) {

        if (opts.strict) throw cause;
        console.error(`[search] ${spec.index} rejected a query`, { match, cause });
      }
    }
  }

  for (const source of Object.keys(ranked) as SearchSource[]) {
    hits[source] = mergeByPosition(ranked[source]).slice(0, limit);
  }
  return hits;
}

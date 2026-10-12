import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'detact-search-'));
process.env.DATA_DIR = directory;
const { db, ensureUser } = await import('./db.ts');
const { fullTextAvailable, installSearchIndexes, matchExpression, search } = await import('./search.ts');

const DEGRADED = './search.ts?no-fts5';
const degraded = await (async () => {
  db.exec('CREATE TABLE temp.detact_fts_probe (probe)');
  const complain = console.error;
  console.error = () => {};
  try {
    return (await import(DEGRADED)) as typeof import('./search.ts');
  } finally {
    console.error = complain;
    db.exec('DROP TABLE temp.detact_fts_probe');
  }
})();

const DAY_MS = 86_400_000;

function addRecord(
  id: string,
  fields: {
    owner?: string;
    title?: string;
    kind?: string;
    counterparty?: string | null;
    category?: string | null;
    note?: string | null;
    extraction?: string;
    status?: string;
    at?: number;
    minor?: number | null;
    currency?: string | null;
  } = {},
): string {
  const at = fields.at ?? Date.now();
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, counterparty, category, note,
                          extraction, status, amount_minor, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.owner ?? 'owner-a',
    fields.kind ?? 'payment',
    fields.title ?? 'Payment',
    at,
    fields.counterparty ?? null,
    fields.category ?? null,
    fields.note ?? null,
    fields.extraction ?? '{}',
    fields.status ?? 'complete',
    fields.minor ?? null,
    fields.currency ?? null,
    at,
    at,
  );
  return id;
}

function addMeeting(id: string, title: string, transcript: string, intelligence = '{}'): string {
  const at = Date.now();
  db.prepare(
    `INSERT INTO meetings (id, user_id, title, transcript, intelligence, status, started_at, created_at, updated_at)
     VALUES (?, 'owner-a', ?, ?, ?, 'complete', ?, ?, ?)`,
  ).run(id, title, transcript, intelligence, at, at, at);
  return id;
}

function addTask(id: string, text: string, owner: string | null): string {
  const at = Date.now();
  db.prepare(`INSERT INTO tasks (id, user_id, text, owner_name, created_at) VALUES (?, 'owner-a', ?, ?, ?)`)
    .run(id, text, owner, at);
  return id;
}

function addCase(
  id: string,
  fields: { owner?: string; title?: string; question?: string; mine?: string; theirs?: string } = {},
): string {
  const at = Date.now();
  db.prepare(
    `INSERT INTO cases (id, user_id, title, question, my_claim, their_claim, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(
    id,
    fields.owner ?? 'owner-a',
    fields.title ?? 'Dispute',
    fields.question ?? '',
    fields.mine ?? '',
    fields.theirs ?? '',
    at,
    at,
  );
  return id;
}

function addCaseItem(
  id: string,
  caseId: string,
  fields: { owner?: string; label?: string; text?: string; extraction?: string } = {},
): string {
  const at = Date.now();
  db.prepare(
    `INSERT INTO case_items (id, case_id, user_id, side, label, text, extraction, status, kind, created_at)
     VALUES (?, ?, ?, 'mine', ?, ?, ?, 'ready', 'document', ?)`,
  ).run(
    id,
    caseId,
    fields.owner ?? 'owner-a',
    fields.label ?? 'Document',
    fields.text ?? '',
    fields.extraction ?? '{}',
    at,
  );
  return id;
}

function indexedCount(index: string, rowId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${index} WHERE row_id = ?`).get(rowId) as { n: number }).n;
}

beforeEach(() => {
  db.exec(
    'DELETE FROM case_items; DELETE FROM cases; DELETE FROM tasks; DELETE FROM meetings; DELETE FROM records; DELETE FROM users;',
  );
  ensureUser('owner-a', null, null);
  ensureUser('owner-b', null, null);
});

after(() => {
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-search-'));
  rmSync(target, { recursive: true, force: true });
});

test('the bundled SQLite build has FTS5, so questions are really searched', () => {

  assert.equal(fullTextAvailable, true);
});

test('a question is cut into a MATCH expression that cannot carry an FTS operator', () => {
  const expression = matchExpression('Did I pay "Sharma & Co." OR the NEAR-by shop -- 50% off?');
  assert.ok(expression);

  const phrases = [...expression.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1] ?? '');
  assert.ok(phrases.length > 0);
  for (const body of phrases) {
    assert.match(body, /^[\p{L}\p{N}\p{M}]+$/u, `unsafe phrase: ${body}`);
  }

  // What is left once the quoted phrases are removed must be only this file's own syntax.
  // Any leftover character would be a fragment of the question that escaped quoting, which
  // is the exact shape of the bug this guards: an apostrophe or a stray `"` read as syntax
  // raises inside better-sqlite3 rather than returning nothing.
  const skeleton = expression
    .replace(/"(?:[^"]|"")*"/g, ' ')
    .replace(/\bOR\b/g, ' ')
    .replace(/\b(?:lead|body|dates|meta)\b/g, ' ')
    .replace(/[\s(){}:*]/g, '');
  assert.equal(skeleton, '', `unexpected syntax outside quotes: ${skeleton}`);

  assert.ok(expression.includes('"sharma"'));
  // `NEAR` spells an FTS5 operator. It has to survive as a literal, not become one.
  assert.ok(expression.includes('"near"'));

  // Nothing to search for is not an empty MATCH — that raises — it is no search at all.
  assert.equal(matchExpression('kya hai?'), null);
  assert.equal(matchExpression('   '), null);
  assert.equal(matchExpression('"*" -- ()'), null);
});

test('a question full of punctuation searches rather than raising', () => {
  const id = addRecord('rec-sharma', { title: 'Wiring work', counterparty: 'Sharma & Co.' });
  const hits = search('owner-a', 'Did I pay "Sharma & Co." OR the NEAR-by shop -- 50% off?');
  assert.deepEqual(hits.record, [id]);
});

test('a record is found by a word in its counterparty from behind hundreds of newer rows', () => {
  const now = Date.now();
  const plumber = addRecord('rec-plumber', {
    title: 'Bathroom tap',
    counterparty: 'Anil the plumber',
    at: now - 200 * DAY_MS,
  });
  // More than the ask route's recency cap, so recency alone could never reach the answer.
  db.transaction(() => {
    for (let index = 0; index < 620; index += 1) {
      addRecord(`rec-noise-${index}`, { title: `Groceries ${index}`, counterparty: 'Big Bazaar', at: now - index });
    }
  })();

  const hits = search('owner-a', 'how much did I pay the plumber');
  assert.equal(hits.record[0], plumber);
});

test('a match older than the recency lookback is still reachable', () => {
  const old = addRecord('rec-old', {
    title: 'Gas cylinder refill',
    counterparty: 'Bharat Gas',
    at: Date.now() - 500 * DAY_MS,
  });
  addRecord('rec-new', { title: 'Groceries', counterparty: 'Big Bazaar' });

  assert.deepEqual(search('owner-a', 'what did I pay Bharat Gas').record, [old]);
});

test('the index follows an edit and a deletion', () => {
  const id = addRecord('rec-edit', { title: 'Repair', counterparty: 'Anil the plumber' });
  assert.deepEqual(search('owner-a', 'plumber').record, [id]);

  db.prepare('UPDATE records SET counterparty = ? WHERE id = ?').run('Ravi the electrician', id);
  assert.deepEqual(search('owner-a', 'plumber').record, []);
  assert.deepEqual(search('owner-a', 'electrician').record, [id]);
  assert.equal(indexedCount('records_fts', id), 1, 'an edit must replace the indexed row, not add one');

  db.prepare('DELETE FROM records WHERE id = ?').run(id);
  assert.deepEqual(search('owner-a', 'electrician').record, []);
  assert.equal(indexedCount('records_fts', id), 0);
});

test('a write that changes no indexed text leaves the index alone', () => {
  const id = addRecord('rec-status', { title: 'Repair', counterparty: 'Anil the plumber', status: 'needs_context' });
  db.prepare(`UPDATE records SET status = 'complete', updated_at = ? WHERE id = ?`).run(Date.now(), id);
  assert.deepEqual(search('owner-a', 'plumber').record, [id]);
  assert.equal(indexedCount('records_fts', id), 1);
});

test('an index created after the rows exist is filled from what is already stored', () => {
  // Exactly the shape of an upgrade: a database with a year of history in it meets an
  // index that did not exist yesterday. Without the backfill the feature is dead for
  // every account that already had data.
  db.exec(`
    DROP TRIGGER IF EXISTS records_fts_insert;
    DROP TRIGGER IF EXISTS records_fts_update;
    DROP TRIGGER IF EXISTS records_fts_delete;
    DROP TABLE IF EXISTS records_fts;
  `);
  const id = addRecord('rec-legacy', { title: 'Cylinder refill', counterparty: 'Bharat Gas' });

  installSearchIndexes();
  assert.deepEqual(search('owner-a', 'Bharat Gas').record, [id]);

  // Cheap and idempotent on a populated index: a second run must not double the rows.
  installSearchIndexes();
  assert.equal(indexedCount('records_fts', id), 1);
});

test('a record is found by words only its source document and summary carry', () => {
  const id = addRecord('rec-receipt', {
    title: 'IMG_2451.jpg',
    extraction: JSON.stringify({
      readBy: 'ocr',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      summary: 'Annual policy premium.',
      reference: 'UTR462318905577',
      sourceText: 'NEW INDIA ASSURANCE - two wheeler policy renewal - premium paid',
    }),
  });

  assert.deepEqual(search('owner-a', 'two wheeler policy renewal').record, [id]);
  assert.deepEqual(search('owner-a', 'UTR462318905577').record, [id]);
  // The blob also names the provider and the model that read the file. Indexing those
  // would make every read record answer to the word "groq".
  assert.deepEqual(search('owner-a', 'groq').record, []);
});

test('a record whose extraction is not JSON is still indexed by everything else', () => {
  // A trigger that raises aborts the insert that fired it, so a blob this code cannot
  // parse must cost the extra reach and nothing more.
  const id = addRecord('rec-corrupt', { title: 'Cylinder refill', counterparty: 'Bharat Gas', extraction: 'not json' });
  assert.deepEqual(search('owner-a', 'Bharat Gas').record, [id]);
});

test('a meeting is found deep in its transcript, and a task by its owner', () => {
  const meeting = addMeeting(
    'meet-wall',
    'Site review',
    `${'The contractor talked at length. '.repeat(400)} We agreed the boundary wall goes up first.`,
    JSON.stringify({ decisions: ['Boundary wall first'], keyPoints: [], topics: ['Construction'] }),
  );
  const task = addTask('task-priya', 'Send the signed estimate', 'Priya');

  assert.deepEqual(search('owner-a', 'what did we decide about the boundary wall').meeting, [meeting]);
  assert.deepEqual(search('owner-a', 'what is Priya doing').task, [task]);
});

test('a search never reaches another account', () => {
  addRecord('rec-theirs', { owner: 'owner-b', title: 'Cylinder refill', counterparty: 'Bharat Gas' });
  const mine = addRecord('rec-mine', { title: 'Cylinder refill', counterparty: 'Bharat Gas' });

  assert.deepEqual(search('owner-a', 'Bharat Gas').record, [mine]);
  assert.deepEqual(search('owner-b', 'Bharat Gas').record, ['rec-theirs']);
});

test('a question with no searchable word asks nothing of the index', () => {
  addRecord('rec-any', { title: 'Cylinder refill', counterparty: 'Bharat Gas' });
  assert.deepEqual(search('owner-a', 'kya hai?'), { record: [], meeting: [], task: [], case: [] });
});

// --- disputes -------------------------------------------------------------------

test('a dispute is found by its title, by the question it settles, and by either account of it', () => {
  const id = addCase('case-parcel', {
    title: 'Missing parcel',
    question: 'Should the courier refund me?',
    mine: 'I was at home all afternoon and nobody rang the bell.',
    theirs: 'They say the parcel was handed to a neighbour.',
  });

  assert.deepEqual(search('owner-a', 'missing parcel').case, [id]);
  assert.deepEqual(search('owner-a', 'will the courier refund me').case, [id]);
  assert.deepEqual(search('owner-a', 'nobody rang the bell').case, [id]);
  // The other side's account matters as much as the person's own: "they said it went to a
  // neighbour" is exactly the sentence somebody searches for three months later.
  assert.deepEqual(search('owner-a', 'handed to a neighbour').case, [id]);
});

test('a dispute is found by words that only appear inside one of its documents', () => {
  const id = addCase('case-wall', { title: 'Boundary wall' });
  addCaseItem('item-quote', id, {
    label: 'The quotation they emailed',
    text: 'Scope excludes plastering of the parapet.',
  });
  addCaseItem('item-photo', id, {
    label: 'Photograph of the finished work',
    extraction: JSON.stringify({ readBy: 'ocr', sourceText: 'SHREE CEMENT - 43 grade - batch dated 14 July' }),
  });

  // An attachment is not a screen anyone can open, so what comes back is the dispute.
  assert.deepEqual(search('owner-a', 'plastering of the parapet').case, [id]);
  assert.deepEqual(search('owner-a', 'shree cement 43 grade').case, [id]);
  // Two documents matched one dispute; it is one result, not two.
  assert.deepEqual(search('owner-a', 'parapet cement').case, [id]);
});

test('a dispute found by its own words outranks one found only inside an attachment', () => {
  const named = addCase('case-named', { title: 'Geyser installation' });
  const buried = addCase('case-buried', { title: 'Unrelated matter' });
  addCaseItem('item-buried', buried, { text: 'The geyser installation was signed off on site.' });

  assert.deepEqual(search('owner-a', 'geyser installation').case, [named, buried]);
});

test('the dispute index follows an edit, a removed document and a deletion', () => {
  const id = addCase('case-edit', { title: 'Broken geyser' });
  const kept = addCaseItem('item-kept', id, { text: 'The warranty card names the dealer.' });
  const removed = addCaseItem('item-removed', id, { text: 'A photograph of the leaking valve.' });

  assert.deepEqual(search('owner-a', 'broken geyser').case, [id]);
  assert.deepEqual(search('owner-a', 'leaking valve').case, [id]);

  db.prepare('UPDATE cases SET title = ? WHERE id = ?').run('Refund for the geyser', id);
  assert.deepEqual(search('owner-a', 'broken').case, []);
  assert.deepEqual(search('owner-a', 'refund').case, [id]);
  assert.equal(indexedCount('cases_fts', id), 1, 'an edit must replace the indexed row, not add one');

  // The point of keying the attachment index on the attachment and not on the dispute:
  // removing one document must not take the other one's text with it.
  db.prepare('DELETE FROM case_items WHERE id = ?').run(removed);
  assert.deepEqual(search('owner-a', 'leaking valve').case, []);
  assert.deepEqual(search('owner-a', 'warranty card').case, [id]);
  assert.equal(indexedCount('case_items_fts', removed), 0);
  assert.equal(indexedCount('case_items_fts', kept), 1);

  db.prepare('DELETE FROM cases WHERE id = ?').run(id);
  assert.deepEqual(search('owner-a', 'refund').case, []);
  // The documents went with it, by cascade — and the cascade fires the delete trigger, so
  // nothing is left in the index pointing at a dispute that no longer exists.
  assert.deepEqual(search('owner-a', 'warranty card').case, []);
  assert.equal(indexedCount('cases_fts', id), 0);
  assert.equal(indexedCount('case_items_fts', kept), 0);
});

test('a dispute index created after the rows exist is filled from what is already stored', () => {
  db.exec(`
    DROP TRIGGER IF EXISTS cases_fts_insert;
    DROP TRIGGER IF EXISTS cases_fts_update;
    DROP TRIGGER IF EXISTS cases_fts_delete;
    DROP TRIGGER IF EXISTS case_items_fts_insert;
    DROP TRIGGER IF EXISTS case_items_fts_update;
    DROP TRIGGER IF EXISTS case_items_fts_delete;
    DROP TABLE IF EXISTS cases_fts;
    DROP TABLE IF EXISTS case_items_fts;
  `);
  const id = addCase('case-legacy', { title: 'Overcharged for the cylinder' });
  addCaseItem('item-legacy', id, { text: 'The delivery slip shows the subsidised rate.' });

  installSearchIndexes();
  assert.deepEqual(search('owner-a', 'overcharged').case, [id]);
  assert.deepEqual(search('owner-a', 'subsidised rate').case, [id]);
});

test('a dispute search never reaches another account', () => {
  const theirs = addCase('case-theirs', { owner: 'owner-b', title: 'Missing parcel' });
  addCaseItem('item-theirs', theirs, { owner: 'owner-b', text: 'Signed for by a neighbour.' });
  const mine = addCase('case-mine', { title: 'Missing parcel' });
  addCaseItem('item-mine', mine, { text: 'Signed for by a neighbour.' });

  assert.deepEqual(search('owner-a', 'missing parcel').case, [mine]);
  assert.deepEqual(search('owner-a', 'signed for by a neighbour').case, [mine]);
  assert.deepEqual(search('owner-b', 'missing parcel').case, [theirs]);
  assert.deepEqual(search('owner-b', 'signed for by a neighbour').case, [theirs]);
});

test('a search narrowed to one kind touches nothing else', () => {
  const record = addRecord('rec-wall', { title: 'Boundary wall materials' });
  const task = addTask('task-wall', 'Chase the boundary wall estimate', null);
  const dispute = addCase('case-wall', { title: 'Boundary wall' });

  const everything = search('owner-a', 'boundary wall');
  assert.deepEqual(everything.record, [record]);
  assert.deepEqual(everything.task, [task]);
  assert.deepEqual(everything.case, [dispute]);

  assert.deepEqual(search('owner-a', 'boundary wall', { only: 'case' }), {
    record: [],
    meeting: [],
    task: [],
    case: [dispute],
  });
});

// --- the shapes people actually type -------------------------------------------

test('a partial word reaches the whole word', () => {
  // The reason the expression carries a prefix clause at all. Somebody looking for their
  // electricity bill types four letters and stops; without the prefix token FTS5 matches
  // whole words only and the answer is an empty screen.
  const bill = addRecord('rec-elec', { title: 'Electricity bill', counterparty: 'BESCOM' });
  assert.deepEqual(search('owner-a', 'elect').record, [bill]);
  assert.deepEqual(search('owner-a', 'bes').record, [bill]);
  assert.deepEqual(search('owner-a', 'electricity').record, [bill]);

  // A prefix of nothing is still nothing: the word has to actually start that way.
  assert.deepEqual(search('owner-a', 'ricity').record, []);
});

test('a near-miss spelling still finds the row', () => {
  const shop = addRecord('rec-sharma', { title: 'Wiring work', counterparty: 'Sharma Electronics' });
  // What a person types from memory, a letter short. The strict pass finds nothing for
  // `shrma`, so the index's own vocabulary is asked for a word within one edit of it.
  assert.deepEqual(search('owner-a', 'Shrma Electronics').record, [shop]);
  assert.deepEqual(search('owner-a', 'Sharrma').record, [shop]);

  // Correction is bounded, not a free-for-all: a three-letter term is too short to correct,
  // because at that length everything is within one edit of everything.
  assert.deepEqual(search('owner-a', 'xyz').record, []);
});

test('a name, an amount, a date, a reference, a document word and a private note all hit', () => {
  const id = addRecord('rec-everything', {
    title: 'Annual maintenance',
    counterparty: 'Kumar Services',
    note: 'paid from the joint account',
    minor: 249900,
    currency: 'INR',
    at: Date.UTC(2025, 6, 14),
    extraction: JSON.stringify({
      summary: 'Maintenance contract for the lift',
      reference: 'INV-2025-8842',
      sourceText: 'Annual maintenance contract covering the lift and the water pump',
    }),
  });

  assert.deepEqual(search('owner-a', 'Kumar Services').record, [id], 'a name');
  assert.deepEqual(search('owner-a', 'INV-2025-8842').record, [id], 'a reference number');
  assert.deepEqual(search('owner-a', 'water pump').record, [id], 'a word from inside the document');
  assert.deepEqual(search('owner-a', 'joint account').record, [id], "the person's own note");
  assert.deepEqual(search('owner-a', 'july 2025').record, [id], 'a month and a year');
  assert.deepEqual(search('owner-a', '2025-07-14').record, [id], 'a written date');

  // An amount is the one pass that is opt-in, because in a typed sentence a bare number is a
  // year or a count far more often than it is money.
  assert.deepEqual(search('owner-a', '2499', { amounts: true }).record, [id], 'the amount on the bill');
  assert.deepEqual(search('owner-a', '2,499', { amounts: true }).record, [id], 'the amount with a separator');
});

test('an amount is read at the currency of the row, not of the query', () => {
  const rupees = addRecord('rec-inr', { title: 'Repair', minor: 250000, currency: 'INR', at: Date.now() - DAY_MS });
  const yen = addRecord('rec-jpy', { title: 'Hotel', minor: 2500, currency: 'JPY' });

  // ₹2,500 is 250000 paise and ¥2,500 is 2500 yen. One typed figure, two stored values, and
  // only the row's own exponent says which is which — the bug this guards is a flat ×100 that
  // finds the rupee row and silently loses the yen one.
  const hits = search('owner-a', '2500', { amounts: true }).record;
  assert.ok(hits.includes(rupees), 'the rupee row');
  assert.ok(hits.includes(yen), 'the yen row');

  // A zero-exponent currency is not scaled, so a figure typed in paise reaches only the rupee row.
  assert.deepEqual(search('owner-a', '250000', { amounts: true }).record, [rupees]);
});

test('Devanagari, Devanagari digits and mixed script are all searchable', () => {
  const hindi = addRecord('rec-hindi', {
    title: 'बिजली का बिल',
    counterparty: 'बेस्कॉम',
    note: 'राशि १४०० रुपये',
  });
  const mixed = addRecord('rec-mixed', { title: 'Rent', counterparty: 'मकान मालिक Verma' });

  assert.deepEqual(search('owner-a', 'बिजली').record, [hindi], 'a Devanagari word');
  assert.deepEqual(search('owner-a', 'बिज').record, [hindi], 'a Devanagari prefix');
  assert.deepEqual(search('owner-a', '१४००').record, [hindi], 'Devanagari digits as typed');
  // The same number in the other digit system. These are different characters and FTS5
  // compares characters, so without the fold a receipt printed in Hindi is unreachable from
  // a phone keyboard.
  assert.deepEqual(search('owner-a', '1400').record, [hindi], 'the same number in ASCII digits');

  assert.deepEqual(search('owner-a', 'मकान').record, [mixed], 'the Devanagari half of a mixed row');
  assert.deepEqual(search('owner-a', 'Verma').record, [mixed], 'the Latin half of a mixed row');
  assert.deepEqual(search('owner-a', 'मकान Verma').record, [mixed], 'both scripts in one query');
});

test('a query of nothing but FTS syntax searches nothing instead of raising', () => {
  addRecord('rec-any', { title: 'Anything' });
  // Each of these is a well-formed FTS5 fragment on its own and a syntax error in context.
  // The product answer to all of them is an empty result, never an error a person has to read.
  for (const query of ['"', '*', '-', '(', ')', '^', ':', 'NEAR(', '""', '* AND', 'a OR', "'", '%_%']) {
    const hits = search('owner-a', query, { strict: true });
    assert.deepEqual(hits.record, [], `query ${query} should find nothing`);
  }

  // An apostrophe inside a real word is not a syntax error, and the word around it still works.
  const shop = addRecord('rec-apos', { title: "Raju's tyre shop" });
  assert.deepEqual(search('owner-a', "Raju's", { strict: true }).record, [shop]);
});

test('a title match outranks a body match, and among equals the recent one leads', () => {
  const titled = addRecord('rec-titled', { title: 'Plumber visit', at: Date.now() - 40 * DAY_MS });
  const mentioned = addRecord('rec-mentioned', {
    title: 'Bathroom repair',
    note: 'the plumber said the pipe behind the wall needs replacing',
  });

  // The older row wins, which is the point: relevance decides before recency does, or a
  // passing mention from this morning buries the record actually named for the thing.
  assert.deepEqual(search('owner-a', 'plumber').record, [titled, mentioned]);

  // With nothing to tell two rows apart, the recent one leads. This is what a daybook holding
  // the same monthly bill two dozen times looks like, and showing last year's copy first is
  // the failure it prevents.
  const older = addRecord('rec-jan', { title: 'Electricity bill', at: Date.now() - 300 * DAY_MS });
  const newer = addRecord('rec-dec', { title: 'Electricity bill', at: Date.now() - 2 * DAY_MS });
  const bills = search('owner-a', 'electricity bill').record;
  assert.deepEqual(bills, [newer, older]);
});

test('an empty answer and a broken search are different things', () => {
  addRecord('rec-present', { title: 'Something' });

  // Nothing matched. Not an error: a real, complete, empty answer, so the screen can say
  // "nothing matched that" rather than "something went wrong".
  assert.deepEqual(search('owner-a', 'helicopter', { strict: true }), {
    record: [],
    meeting: [],
    task: [],
    case: [],
  });

  // A search that genuinely cannot run must be loud when the caller says so, because the
  // alternative is a person being shown an empty daybook and believing it. The index is
  // dropped out from under the query to force the failure the guard normally swallows.
  db.exec('DROP TABLE records_fts');
  try {
    assert.throws(() => search('owner-a', 'something', { strict: true }));
    // The same failure without `strict` costs this one kind of result, not the whole search:
    // the ask box would rather answer from the meetings it can still read.
    const lenient = search('owner-a', 'something');
    assert.deepEqual(lenient.record, []);
    assert.deepEqual(lenient.meeting, []);
  } finally {
    installSearchIndexes();
  }
});

test('each kind of hit comes back under its own name', () => {
  // The client routes a hit by its kind — a task to the tasks tab, a dispute to the case —
  // so a hit arriving under the wrong name sends somebody to the wrong screen.
  const record = addRecord('rec-mango', { title: 'Mango crate' });
  const meeting = addMeeting('meet-mango', 'Mango supplier call', 'we agreed on the mango crate price');
  const task = addTask('task-mango', 'Collect the mango crate', null);
  const dispute = addCase('case-mango', { title: 'Mango crate shortfall' });

  assert.deepEqual(search('owner-a', 'mango crate'), {
    record: [record],
    meeting: [meeting],
    task: [task],
    case: [dispute],
  });
});

test('a question made only of grammar is recognised as having nothing to search for', () => {
  const id = addRecord('rec-spend', { title: 'Cement bags', counterparty: 'Shree Traders' });

  // None of these carries a subject. The failure they guard is not an error — it is an
  // answer: the index was asked for rows containing the word `in`, which is most of them,
  // ranked by nothing, and the person was shown that as a result.
  for (const query of [
    'in on at of to by',
    'what about it',
    'is it there or not',
    'kitna hai',
    'mujhe ye ka ki ke ko se',
  ]) {
    assert.equal(matchExpression(query), null, `${query} should carry no searchable term`);
    assert.deepEqual(search('owner-a', query, { strict: true }), {
      record: [],
      meeting: [],
      task: [],
      case: [],
    }, `${query} should search for nothing`);
  }

  // A verb is not grammar. `spend`, `paid`, `bought` are words a person writes in their own
  // note, so they survive the cut — only the scaffolding of the question is dropped.
  const spending = matchExpression('how much did I spend');
  assert.ok(spending);
  assert.ok(spending.includes('"spend"'));
  assert.ok(!spending.includes('"much"'), 'a question word must not reach the index');

  // The same sentence with a subject in it searches for the subject.
  assert.deepEqual(search('owner-a', 'how much did I spend on cement in 2025').record, [id]);
  const expression = matchExpression('how much did I spend on cement');
  assert.ok(expression);
  assert.ok(expression.includes('"cement"'));
  assert.ok(!expression.includes('"on"'), 'a preposition must not reach the index');
});

// --- without FTS5 ---------------------------------------------------------------

test('the module reports FTS5 as unavailable when the probe fails', () => {
  // Pins the fixture itself: if the probe collision stopped working, every test below would
  // quietly be re-testing the indexed path and passing for the wrong reason.
  assert.equal(degraded.fullTextAvailable, false);
});

test('without FTS5 a record, a meeting, a task and a dispute are all still found', () => {
  const record = addRecord('rec-plumber', { title: 'Bathroom tap', counterparty: 'Anil the plumber' });
  const meeting = addMeeting('meet-wall', 'Site review', 'We agreed the boundary wall goes up first.');
  const task = addTask('task-priya', 'Send the signed estimate', 'Priya');
  const dispute = addCase('case-parcel', { title: 'Missing parcel', question: 'Should the courier refund me?' });
  addCaseItem('item-parcel', dispute, { text: 'The tracking page says it was handed to a neighbour.' });

  assert.deepEqual(degraded.search('owner-a', 'how much did I pay the plumber').record, [record]);
  assert.deepEqual(degraded.search('owner-a', 'what did we decide about the boundary wall').meeting, [meeting]);
  assert.deepEqual(degraded.search('owner-a', 'what is Priya doing').task, [task]);
  assert.deepEqual(degraded.search('owner-a', 'missing parcel').case, [dispute]);
  assert.deepEqual(degraded.search('owner-a', 'handed to a neighbour').case, [dispute]);
});

test('without FTS5 a record is still found by words only its source document carries', () => {
  const id = addRecord('rec-receipt', {
    title: 'IMG_2451.jpg',
    extraction: JSON.stringify({
      readBy: 'ocr',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      summary: 'Annual policy premium.',
      reference: 'UTR462318905577',
      sourceText: 'NEW INDIA ASSURANCE - two wheeler policy renewal - premium paid',
    }),
  });

  assert.deepEqual(degraded.search('owner-a', 'two wheeler policy renewal').record, [id]);
  assert.deepEqual(degraded.search('owner-a', 'UTR462318905577').record, [id]);
  // The scan reads the same expression the index would have held, so the fields left out of
  // the index are left out here too. A degraded search must not reach further than the real one.
  assert.deepEqual(degraded.search('owner-a', 'groq').record, []);
});

test('without FTS5 the row carrying more of the question comes first', () => {
  // There is no relevance score to sort on, so the honest substitute is how many of the
  // question's own terms a row actually carries.
  const both = addRecord('rec-both', { title: 'Cylinder refill', counterparty: 'Bharat Gas' });
  const one = addRecord('rec-one', { title: 'Cylinder deposit', counterparty: 'Indane' });

  assert.deepEqual(degraded.search('owner-a', 'bharat gas cylinder').record, [both, one]);
});

test('without FTS5 a question full of punctuation searches rather than raising', () => {
  // The same guarantee as the MATCH expression, by the same means: the question never
  // becomes SQL. Nothing here can reach a LIKE pattern as a wildcard either — `%` and `_`
  // do not survive being cut into runs of letters and digits.
  const id = addRecord('rec-sharma', { title: 'Wiring work', counterparty: 'Sharma & Co.' });
  assert.deepEqual(degraded.search('owner-a', 'Did I pay "Sharma & Co." OR the NEAR-by shop -- 50% off?').record, [id]);

  const wild = addRecord('rec-wild', { title: 'Anything at all' });
  assert.deepEqual(degraded.search('owner-a', '%').record, [], 'a lone wildcard is not a search term');
  assert.deepEqual(degraded.search('owner-a', '_').record, []);
  assert.deepEqual(degraded.search('owner-a', 'anything').record, [wild]);
});

test('without FTS5 an edit and a deletion are followed, and no other account is reached', () => {
  // The scan reads the live table, so there is no index to drift — but that is a claim worth
  // holding to, because it is the reason the degraded path needs no triggers at all.
  const id = addRecord('rec-edit', { title: 'Repair', counterparty: 'Anil the plumber' });
  addRecord('rec-theirs', { owner: 'owner-b', title: 'Repair', counterparty: 'Anil the plumber' });

  assert.deepEqual(degraded.search('owner-a', 'plumber').record, [id]);
  assert.deepEqual(degraded.search('owner-b', 'plumber').record, ['rec-theirs']);

  db.prepare('UPDATE records SET counterparty = ? WHERE id = ?').run('Ravi the electrician', id);
  assert.deepEqual(degraded.search('owner-a', 'plumber').record, []);
  assert.deepEqual(degraded.search('owner-a', 'electrician').record, [id]);

  db.prepare('DELETE FROM records WHERE id = ?').run(id);
  assert.deepEqual(degraded.search('owner-a', 'electrician').record, []);
});

test('without FTS5 a question with no searchable word still searches nothing', () => {
  addRecord('rec-any', { title: 'Cylinder refill', counterparty: 'Bharat Gas' });
  assert.deepEqual(degraded.search('owner-a', 'kya hai?'), { record: [], meeting: [], task: [], case: [] });
  assert.deepEqual(degraded.search('owner-a', '   '), { record: [], meeting: [], task: [], case: [] });
});

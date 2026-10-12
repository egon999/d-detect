import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Account } from '../auth.ts';

const directory = mkdtempSync(join(tmpdir(), 'detact-search-route-'));
process.env.DATA_DIR = directory;
const { db, ensureUser } = await import('../db.ts');
const { formatMinorUnits } = await import('../money.ts');
const { search } = await import('./search.ts');
const { installSearchIndexes } = await import('../search.ts');

const app = new Hono<{ Variables: { account: Account } }>();
app.use('*', async (context, next) => {
  const id = context.req.header('x-test-owner') ?? 'owner-a';
  ensureUser(id, null, null);
  context.set('account', { id, email: null, name: null });
  await next();
});
app.route('/search', search);
app.onError((error, context) =>
  context.json({ error: error.message }, error instanceof HTTPException ? error.status : 500),
);

const realFetch = globalThis.fetch;
globalThis.fetch = (input) => {
  throw new Error(`Search must not reach the network: ${String(input)}`);
};

const DAY_MS = 86_400_000;

beforeEach(() => {
  db.exec(
    'DELETE FROM case_items; DELETE FROM cases; DELETE FROM tasks; DELETE FROM meetings; DELETE FROM records; DELETE FROM users;',
  );
  ensureUser('owner-a', null, null);
  ensureUser('owner-b', null, null);
});

after(() => {
  globalThis.fetch = realFetch;
  db.close();
  const target = realpathSync(directory);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.ok(target.split(/[\\/]/).at(-1)?.startsWith('detact-search-route-'));
  rmSync(target, { recursive: true, force: true });
});

function addRecord(
  id: string,
  fields: {
    owner?: string;
    title?: string;
    kind?: string;
    status?: string;
    counterparty?: string | null;
    direction?: string | null;
    category?: string | null;
    note?: string | null;
    amountMinor?: number | null;
    currency?: string | null;
    extraction?: string;
    at?: number | null;
  } = {},
): string {
  const now = Date.now();
  db.prepare(
    `INSERT INTO records (id, user_id, kind, title, occurred_at, amount_minor, currency, direction,
                          counterparty, category, note, extraction, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.owner ?? 'owner-a',
    fields.kind ?? 'payment',
    fields.title ?? 'Payment',
    fields.at === undefined ? now : fields.at,
    fields.amountMinor ?? null,
    fields.currency ?? null,
    fields.direction ?? null,
    fields.counterparty ?? null,
    fields.category ?? null,
    fields.note ?? null,
    fields.extraction ?? '{}',
    fields.status ?? 'complete',
    now,
    now,
  );
  return id;
}

function addMeeting(
  id: string,
  fields: { owner?: string; title?: string; note?: string; summary?: string | null; transcript?: string; at?: number } = {},
): string {
  const now = Date.now();
  db.prepare(
    `INSERT INTO meetings (id, user_id, title, note, summary, transcript, status, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)`,
  ).run(
    id,
    fields.owner ?? 'owner-a',
    fields.title ?? 'Meeting',
    fields.note ?? '',
    fields.summary ?? null,
    fields.transcript ?? '',
    fields.at ?? now,
    now,
    now,
  );
  return id;
}

function addTask(
  id: string,
  fields: { owner?: string; text?: string; ownerName?: string | null; dueAt?: number | null } = {},
): string {
  const now = Date.now();
  db.prepare(`INSERT INTO tasks (id, user_id, text, owner_name, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    fields.owner ?? 'owner-a',
    fields.text ?? 'Do the thing',
    fields.ownerName ?? null,
    fields.dueAt === undefined ? null : fields.dueAt,
    now,
  );
  return id;
}

function addCase(
  id: string,
  fields: { owner?: string; title?: string; question?: string; mine?: string; theirs?: string } = {},
): string {
  const now = Date.now();
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
    now,
    now,
  );
  return id;
}

function addCaseItem(
  id: string,
  caseId: string,
  fields: { owner?: string; label?: string; text?: string; extraction?: string } = {},
): string {
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
    Date.now(),
  );
  return id;
}

type Result = {
  type: string;
  id: string;
  title: string;
  subtitle: string | null;
  occurredAt: number | null;
  amountLabel: string | null;
};

type Body = { results?: Result[]; error?: string };

async function find(
  query: string | null,
  options: { kind?: string; limit?: number; owner?: string } = {},
): Promise<{ status: number; results: Result[]; error: string | undefined }> {
  const params = new URLSearchParams();
  if (query !== null) params.set('q', query);
  if (options.kind !== undefined) params.set('kind', options.kind);
  if (options.limit !== undefined) params.set('limit', String(options.limit));

  const response = await app.request(`/search?${params.toString()}`, {
    headers: { 'x-test-owner': options.owner ?? 'owner-a' },
  });
  const body = (await response.json()) as Body;
  return { status: response.status, results: body.results ?? [], error: body.error };
}

function keysOf(results: Result[]): string[] {
  return results.map((result) => `${result.type}:${result.id}`);
}

test('a record is found by its other party and by its title', async () => {
  const plumber = addRecord('rec-plumber', {
    title: 'Bathroom tap replaced',
    counterparty: 'Anil the plumber',
    direction: 'out',
  });
  addRecord('rec-groceries', { title: 'Groceries', counterparty: 'Big Bazaar', direction: 'out' });

  const byParty = await find('plumber');
  assert.equal(byParty.status, 200);
  assert.deepEqual(keysOf(byParty.results), [`record:${plumber}`]);
  assert.equal(byParty.results[0]?.title, 'Bathroom tap replaced');
  assert.equal(byParty.results[0]?.subtitle, 'Paid to Anil the plumber');

  const byTitle = await find('bathroom tap');
  assert.deepEqual(keysOf(byTitle.results), [`record:${plumber}`]);
});

test('a record is found by a word only the document it was read from carries', async () => {
  const id = addRecord('rec-policy', {
    title: 'IMG_2451.jpg',
    extraction: JSON.stringify({
      readBy: 'ocr',
      provider: 'groq',
      sourceText: 'NEW INDIA ASSURANCE - two wheeler policy renewal - premium paid',
    }),
  });

  assert.deepEqual(keysOf((await find('two wheeler policy')).results), [`record:${id}`]);
});

test('a meeting is found, and its subtitle is what the person said it was about', async () => {
  const id = addMeeting('meet-wall', {
    title: 'Site review',
    note: 'Walking the plot with the contractor',
    summary: 'Agreed the boundary wall goes up first.',
    transcript: `${'The contractor talked at length. '.repeat(200)} We agreed the boundary wall goes up first.`,
  });

  const found = await find('what did we decide about the boundary wall');
  assert.deepEqual(keysOf(found.results), [`meeting:${id}`]);
  assert.equal(found.results[0]?.title, 'Site review');
  assert.equal(found.results[0]?.subtitle, 'Walking the plot with the contractor');
  assert.equal(found.results[0]?.amountLabel, null, 'a meeting records no money, and none is invented for it');
});

test('a meeting with nothing written about it falls back to the summary, then to nothing', async () => {
  addMeeting('meet-summary', { title: 'Call with the bank', summary: 'They will reissue the cheque.' });
  const summarised = await find('reissue the cheque');
  assert.equal(summarised.results[0]?.subtitle, 'They will reissue the cheque.');

  db.exec(`DELETE FROM meetings WHERE id = 'meet-summary'`);
  addMeeting('meet-bare', { title: 'Call with the bank' });
  const bare = await find('call with the bank');
  assert.deepEqual(keysOf(bare.results), ['meeting:meet-bare']);
  assert.equal(bare.results[0]?.subtitle, null, 'an empty column is null, never an empty line held open');
});

test('a task is found, and its subtitle names whose it is', async () => {
  const due = Date.now() + 2 * DAY_MS;
  const owned = addTask('task-priya', { text: 'Send the signed estimate', ownerName: 'Priya', dueAt: due });
  const nobodys = addTask('task-nobody', { text: 'Send the estimate to the bank' });

  const found = await find('send the estimate');
  assert.deepEqual(keysOf(found.results).sort(), [`task:${nobodys}`, `task:${owned}`].sort());

  const mine = found.results.find((result) => result.id === owned);
  assert.equal(mine?.title, 'Send the signed estimate');
  assert.equal(mine?.subtitle, 'For Priya');
  assert.equal(mine?.occurredAt, due);

  const unowned = found.results.find((result) => result.id === nobodys);
  assert.equal(unowned?.subtitle, null);
  assert.equal(unowned?.occurredAt, null, 'a task with no due date says so rather than borrowing one');
});

test('a dispute is found by its title and by text inside one of its documents', async () => {
  const id = addCase('case-parcel', {
    title: 'Missing parcel',
    question: 'Should the courier refund me?',
    theirs: 'They say it was handed to a neighbour.',
  });
  addCaseItem('item-tracking', id, {
    label: 'The tracking page',
    extraction: JSON.stringify({ readBy: 'ocr', sourceText: 'Delivered - signed for by SURESH at gate' }),
  });

  const byTitle = await find('missing parcel');
  assert.deepEqual(keysOf(byTitle.results), [`case:${id}`]);
  assert.equal(byTitle.results[0]?.title, 'Missing parcel');
  assert.equal(byTitle.results[0]?.subtitle, 'Should the courier refund me?');

  const byDocument = await find('signed for by Suresh at the gate');
  assert.deepEqual(keysOf(byDocument.results), [`case:${id}`]);
});

test('everything matching comes back together, whatever kind it is', async () => {
  const record = addRecord('rec-wall', { title: 'Boundary wall materials', counterparty: 'Shree Cement' });
  const meeting = addMeeting('meet-wall', { title: 'Boundary wall review' });
  const task = addTask('task-wall', { text: 'Chase the boundary wall estimate' });
  const dispute = addCase('case-wall', { title: 'Boundary wall overrun' });

  const found = await find('boundary wall');
  assert.deepEqual(keysOf(found.results).sort(), [
    `case:${dispute}`,
    `meeting:${meeting}`,
    `record:${record}`,
    `task:${task}`,
  ]);
});

test('a result carries exactly what a row needs and nothing that was invented', async () => {
  const id = addRecord('rec-shape', {
    title: 'Annual premium',
    counterparty: 'New India Assurance',
    direction: 'out',
    amountMinor: 250_000,
    currency: 'INR',
    at: 1_700_000_000_000,
  });

  const found = await find('annual premium');
  const result = found.results[0];
  assert.ok(result);

  assert.deepEqual(Object.keys(result).sort(), [
    'amountLabel',
    'id',
    'occurredAt',
    'subtitle',
    'title',
    'type',
  ]);
  assert.deepEqual(result, {
    type: 'record',
    id,
    title: 'Annual premium',
    subtitle: 'Paid to New India Assurance',
    occurredAt: 1_700_000_000_000,

    amountLabel: formatMinorUnits(250_000, 'INR'),
  });
});

test('an amount is shown only where one was recorded with a currency to read it in', async () => {
  addRecord('rec-none', { title: 'Site visit notes', amountMinor: null, currency: null });
  addRecord('rec-unplaced', { title: 'Site visit receipt', amountMinor: 50_000, currency: null });

  const found = await find('site visit');
  assert.equal(found.results.length, 2);
  for (const result of found.results) {
    assert.equal(result.amountLabel, null, `${result.id} must not print a figure with no currency`);
  }
});

test('a record with no date reports none, and is still ordered sensibly', async () => {
  const undated = addRecord('rec-undated', { title: 'Cylinder refill', at: null });
  const found = await find('cylinder refill');
  assert.deepEqual(keysOf(found.results), [`record:${undated}`]);
  assert.equal(found.results[0]?.occurredAt, null, '"I do not know when" must not become a date');
});

test('no result describes a row in the product’s own vocabulary', async () => {
  addRecord('rec-words', {
    title: 'Cylinder refill',
    kind: 'payment',
    status: 'needs_context',
    counterparty: 'Bharat Gas',
    direction: 'out',
    extraction: JSON.stringify({
      readBy: 'ocr',
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      sourceText: 'BHARAT GAS - cylinder refill - paid',
    }),
  });
  addMeeting('meet-words', { title: 'Cylinder supplier call', note: 'Asking about the refill rate' });
  addCase('case-words', { title: 'Cylinder overcharge', question: 'Was I charged the subsidised rate?' });

  const found = await find('cylinder');
  assert.equal(found.results.length, 3);

  const forbidden = [
    'needs_context',
    'occurred_at',
    'counterparty',
    'amount_minor',
    'sourceText',
    'readBy',
    'extraction',
    'groq',
    'openai',
    'ocr',
    'bm25',
    'MATCH',
    'fts',
    'SELECT',
  ];
  for (const result of found.results) {
    const shown = `${result.title} ${result.subtitle ?? ''}`;
    for (const token of forbidden) {
      assert.ok(!shown.toLowerCase().includes(token.toLowerCase()), `"${shown}" mentions ${token}`);
    }
  }
});

test('the other party stands on its own when which way the money went was never established', async () => {
  const out = addRecord('rec-out', { title: 'Wiring', counterparty: 'Ravi', direction: 'out' });
  const received = addRecord('rec-in', { title: 'Wiring refund', counterparty: 'Ravi', direction: 'in' });
  const unknown = addRecord('rec-unknown', { title: 'Wiring quote', counterparty: 'Ravi', direction: null });

  const found = await find('wiring');
  const subtitleOf = (id: string) => found.results.find((result) => result.id === id)?.subtitle;
  assert.equal(subtitleOf(out), 'Paid to Ravi');
  assert.equal(subtitleOf(received), 'Received from Ravi');

  assert.equal(subtitleOf(unknown), 'Ravi');
});

test('a record with no other party falls back to its category, then to the person’s own note', async () => {
  addRecord('rec-category', { title: 'Weekly shop', category: 'Groceries' });
  const categorised = await find('weekly shop');
  assert.equal(categorised.results[0]?.subtitle, 'Groceries');

  addRecord('rec-note', { title: 'Monsoon repairs', note: 'The terrace was\nleaking into the back room' });
  const noted = await find('monsoon repairs');

  assert.equal(noted.results[0]?.subtitle, 'The terrace was leaking into the back room');
});

test('a row carrying more of the query comes before one carrying less', async () => {
  const both = addRecord('rec-both', { title: 'Cylinder refill', counterparty: 'Bharat Gas' });
  const one = addRecord('rec-one', { title: 'Cylinder deposit', counterparty: 'Indane' });

  const found = await find('bharat gas cylinder');
  assert.deepEqual(keysOf(found.results), [`record:${both}`, `record:${one}`]);
});

test('between the best of two kinds, the more recent one comes first', async () => {

  const older = addRecord('rec-plumber', { title: 'Plumber visit', at: Date.now() - 10 * DAY_MS });
  const newer = addTask('task-plumber', { text: 'Call the plumber', dueAt: Date.now() - DAY_MS });

  const found = await find('plumber');
  assert.deepEqual(keysOf(found.results), [`task:${newer}`, `record:${older}`]);
});

test('a capture still being read is findable, because it is already on the timeline', async () => {

  const reading = addRecord('rec-reading', { title: 'IMG_8831.jpg', status: 'processing' });
  const failed = addRecord('rec-failed', { title: 'IMG_8832.jpg', status: 'failed' });
  addRecord('rec-read', { title: 'Cylinder refill', status: 'complete' });

  const found = await find('IMG_8831');

  assert.deepEqual(keysOf(found.results), [`record:${reading}`, `record:${failed}`]);
  assert.equal(found.results[0]?.title, 'IMG_8831.jpg');
  assert.deepEqual(keysOf((await find('IMG_8832')).results), [`record:${failed}`, `record:${reading}`]);
});

test('a query too short to search for is an empty list, not an error', async () => {
  addRecord('rec-any', { title: 'Cylinder refill', counterparty: 'Bharat Gas' });

  for (const query of ['', '   ', 'a', '?', 'kya hai?']) {
    const found = await find(query);
    assert.equal(found.status, 200, `"${query}" must not be an error`);
    assert.deepEqual(found.results, [], `"${query}" must find nothing`);
  }

  const missing = await find(null);
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.results, []);
});

test('an amount typed into the box finds the record carrying it', async () => {

  const bill = addRecord('rec-amount', {
    title: 'Annual maintenance',
    counterparty: 'Kumar Services',
    amountMinor: 249900,
    currency: 'INR',
  });
  addRecord('rec-other', { title: 'Cylinder refill', amountMinor: 110000, currency: 'INR' });

  assert.deepEqual(keysOf((await find('2499')).results), [`record:${bill}`]);
  assert.deepEqual(keysOf((await find('2,499')).results), [`record:${bill}`]);
});

test('a search that cannot run says so instead of returning an empty list', async () => {

  addRecord('rec-present', { title: 'Cylinder refill', counterparty: 'Bharat Gas' });
  assert.deepEqual(keysOf((await find('Bharat Gas')).results), ['record:rec-present']);

  db.exec('DROP TABLE records_fts');
  try {
    const broken = await find('Bharat Gas');
    assert.notEqual(broken.status, 200, 'a failed search must not look like an empty one');
    assert.deepEqual(broken.results, []);

    assert.ok(broken.error, 'a failure has to carry a sentence');
    assert.match(broken.error, /^[A-Z].*\.$/s, `not a sentence: ${broken.error}`);
    for (const leak of ['records_fts', 'SQLITE', 'sqlite', 'SQL', 'fts5', 'no such table', 'Error:']) {
      assert.ok(!broken.error.includes(leak), `the message leaks "${leak}": ${broken.error}`);
    }
  } finally {
    installSearchIndexes();
  }

  assert.deepEqual(keysOf((await find('Bharat Gas')).results), ['record:rec-present']);
});

test('a search narrowed to one kind returns only that kind', async () => {
  const record = addRecord('rec-wall', { title: 'Boundary wall materials' });
  const meeting = addMeeting('meet-wall', { title: 'Boundary wall review' });
  const task = addTask('task-wall', { text: 'Chase the boundary wall estimate' });
  const dispute = addCase('case-wall', { title: 'Boundary wall overrun' });

  assert.deepEqual(keysOf((await find('boundary wall', { kind: 'record' })).results), [`record:${record}`]);
  assert.deepEqual(keysOf((await find('boundary wall', { kind: 'meeting' })).results), [`meeting:${meeting}`]);
  assert.deepEqual(keysOf((await find('boundary wall', { kind: 'task' })).results), [`task:${task}`]);
  assert.deepEqual(keysOf((await find('boundary wall', { kind: 'case' })).results), [`case:${dispute}`]);
});

test('a kind nobody can search is refused in words, not ignored', async () => {
  addRecord('rec-wall', { title: 'Boundary wall materials' });
  const found = await find('boundary wall', { kind: 'budget' });
  assert.equal(found.status, 400);
  assert.equal(found.error, 'You can narrow a search to records, meetings, tasks or cases.');

  assert.deepEqual(found.results, []);
});

test('the number of rows asked for is the number that come back', async () => {
  for (let index = 0; index < 6; index += 1) {
    addRecord(`rec-${index}`, { title: `Groceries ${index}`, counterparty: 'Big Bazaar' });
  }

  assert.equal((await find('groceries', { limit: 2 })).results.length, 2);
  assert.equal((await find('groceries')).results.length, 6);

  assert.equal((await find('groceries', { limit: 0 })).results.length, 1);
});

test('one account never sees another account’s rows', async () => {
  addRecord('rec-theirs', { owner: 'owner-b', title: 'Cylinder refill', counterparty: 'Bharat Gas' });
  addMeeting('meet-theirs', { owner: 'owner-b', title: 'Cylinder supplier call' });
  addTask('task-theirs', { owner: 'owner-b', text: 'Order a cylinder' });
  const theirCase = addCase('case-theirs', { owner: 'owner-b', title: 'Cylinder overcharge' });
  addCaseItem('item-theirs', theirCase, { owner: 'owner-b', text: 'The subsidised rate was not applied.' });

  const mine = await find('cylinder');
  assert.deepEqual(mine.results, [], 'nothing of theirs may surface under another account');
  assert.deepEqual(keysOf((await find('subsidised rate')).results), []);

  const theirs = await find('cylinder', { owner: 'owner-b' });
  assert.equal(theirs.results.length, 4);
  assert.deepEqual(keysOf((await find('subsidised rate', { owner: 'owner-b' })).results), [`case:${theirCase}`]);
});

test('an edited row is found by what it says now and not by what it said before', async () => {
  const record = addRecord('rec-edit', { title: 'Repair', counterparty: 'Anil the plumber', direction: 'out' });
  const dispute = addCase('case-edit', { title: 'Broken geyser' });

  assert.deepEqual(keysOf((await find('plumber')).results), [`record:${record}`]);

  db.prepare('UPDATE records SET counterparty = ?, updated_at = ? WHERE id = ?').run(
    'Ravi the electrician',
    Date.now(),
    record,
  );
  assert.deepEqual((await find('plumber')).results, []);

  const again = await find('electrician');
  assert.deepEqual(keysOf(again.results), [`record:${record}`]);
  assert.equal(again.results[0]?.subtitle, 'Paid to Ravi the electrician', 'the row must also read as it now is');

  db.prepare('UPDATE cases SET title = ?, updated_at = ? WHERE id = ?').run('Refund for the geyser', Date.now(), dispute);
  assert.deepEqual((await find('broken')).results, []);
  assert.deepEqual(keysOf((await find('refund')).results), [`case:${dispute}`]);
});

test('a deleted row disappears from results', async () => {
  const record = addRecord('rec-gone', { title: 'Cylinder refill', counterparty: 'Bharat Gas' });
  const meeting = addMeeting('meet-gone', { title: 'Cylinder supplier call' });
  const task = addTask('task-gone', { text: 'Order a cylinder' });
  const dispute = addCase('case-gone', { title: 'Cylinder overcharge' });
  addCaseItem('item-gone', dispute, { text: 'The cylinder was billed at the open rate.' });

  assert.equal((await find('cylinder')).results.length, 4);

  db.prepare('DELETE FROM records WHERE id = ?').run(record);
  db.prepare('DELETE FROM meetings WHERE id = ?').run(meeting);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task);
  db.prepare('DELETE FROM cases WHERE id = ?').run(dispute);

  assert.deepEqual((await find('cylinder')).results, []);

  assert.deepEqual((await find('billed at the open rate')).results, []);
});

test('removing one document from a dispute leaves the rest of it findable', async () => {
  const dispute = addCase('case-two', { title: 'Boundary wall overrun' });
  addCaseItem('item-kept', dispute, { text: 'The warranty card names the dealer.' });
  addCaseItem('item-removed', dispute, { text: 'A photograph of the leaking valve.' });

  assert.deepEqual(keysOf((await find('leaking valve')).results), [`case:${dispute}`]);

  db.prepare('DELETE FROM case_items WHERE id = ?').run('item-removed');
  assert.deepEqual((await find('leaking valve')).results, []);
  assert.deepEqual(keysOf((await find('warranty card')).results), [`case:${dispute}`]);
  assert.deepEqual(keysOf((await find('boundary wall')).results), [`case:${dispute}`]);
});

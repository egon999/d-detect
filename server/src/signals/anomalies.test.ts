import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectAnomalies,
  detectPending,
  detectUntouchedMeetings,
  type AnomalyRecord,
  type MeetingProgress,
  type PendingRecord,
} from './anomalies.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);

let counter = 0;
function record(overrides: Partial<AnomalyRecord>): AnomalyRecord {
  counter += 1;
  return {
    id: `rec_${counter}`,
    kind: 'payment',
    occurredAt: NOW,
    amountMinor: 50_000,
    currency: 'INR',
    direction: 'out',
    counterparty: 'Netflix',
    status: 'complete',
    extraction: '{}',
    ...overrides,
  };
}

function rules(records: AnomalyRecord[], now = NOW): string[] {
  return detectAnomalies(records, now).map((draft) => draft.rule);
}

function draftFor(records: AnomalyRecord[], rule: string, now = NOW) {
  return detectAnomalies(records, now).find((draft) => draft.rule === rule);
}

test('the same amount to the same place on the same day is a duplicate', () => {
  const drafts = detectAnomalies([
    record({ occurredAt: NOW - 2 * DAY, counterparty: 'Sharma Electricals', amountMinor: 249_900 }),
    record({ occurredAt: NOW - 2 * DAY + 3_600_000, counterparty: 'Sharma Electricals', amountMinor: 249_900 }),
  ]);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.rule, 'duplicate_charge');
  assert.equal(drafts[0]?.amountMinor, 249_900);

  assert.equal(drafts[0]?.sources.length, 2);
});

test('the sentence claims a resemblance, never that a charge happened twice', () => {
  const draft = draftFor(
    [
      record({ occurredAt: Date.UTC(2026, 8, 22, 4, 30), counterparty: 'Sharma Electricals', amountMinor: 249_900 }),
      record({ occurredAt: Date.UTC(2026, 8, 23, 4, 30), counterparty: 'Sharma Electricals', amountMinor: 249_900 }),
    ],
    'duplicate_charge',
  );
  assert.ok(draft);

  assert.match(draft.title, /look the same/);
  assert.doesNotMatch(draft.title, /twice|double/);

  assert.match(draft.detail, /₹2,499\.00/);
  assert.match(draft.detail, /22\/09\/2026/);
  assert.match(draft.detail, /23\/09\/2026/);
});

test('an amount that is merely close is not a duplicate', () => {
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 2 * DAY, amountMinor: 249_900 }),
      record({ occurredAt: NOW - 2 * DAY, amountMinor: 250_000 }),
    ]),
    [],
  );
});

test('the same amount a week apart is not a duplicate', () => {
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 9 * DAY, amountMinor: 249_900 }),
      record({ occurredAt: NOW - 2 * DAY, amountMinor: 249_900 }),
    ]),
    [],
  );
});

test('a third payment a week earlier does not make the later pair a run', () => {

  const drafts = detectAnomalies([
    record({ occurredAt: NOW - 9 * DAY, counterparty: 'Bharat Traders', amountMinor: 300_000 }),
    record({ occurredAt: NOW - DAY, counterparty: 'Bharat Traders', amountMinor: 300_000 }),
    record({ occurredAt: NOW - DAY + 3_600_000, counterparty: 'Bharat Traders', amountMinor: 300_000 }),
  ]);
  assert.deepEqual(drafts.map((draft) => draft.rule), ['duplicate_charge']);
  assert.equal(drafts[0]?.sources.length, 2, 'the pair, not all three');
});

test('a third payment inside the window is a run, and raises nothing', () => {

  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 2 * DAY, counterparty: 'Sai Tea Stall', amountMinor: 4_000 }),
      record({ occurredAt: NOW - 2 * DAY + 3_600_000, counterparty: 'Sai Tea Stall', amountMinor: 4_000 }),
      record({ occurredAt: NOW - DAY, counterparty: 'Sai Tea Stall', amountMinor: 4_000 }),
    ]),
    [],
  );
});

test('two small payments the same size on the same day are below the floor', () => {

  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - DAY, counterparty: 'Metro Card', amountMinor: 4_000 }),
      record({ occurredAt: NOW - DAY + 600_000, counterparty: 'Metro Card', amountMinor: 4_000 }),
    ]),
    [],
  );

  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - DAY, counterparty: 'Metro Card', amountMinor: 9_999 }),
      record({ occurredAt: NOW - DAY + 600_000, counterparty: 'Metro Card', amountMinor: 9_999 }),
    ]),
    [],
  );
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - DAY, counterparty: 'Metro Card', amountMinor: 10_000 }),
      record({ occurredAt: NOW - DAY + 600_000, counterparty: 'Metro Card', amountMinor: 10_000 }),
    ]),
    ['duplicate_charge'],
  );
});

test('an unpaid bill captured twice is not a double payment', () => {

  const unpaid = { extraction: JSON.stringify({ status: 'unpaid' }) };
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - DAY, kind: 'bill', amountMinor: 120_000, ...unpaid }),
      record({ occurredAt: NOW - DAY, kind: 'bill', amountMinor: 120_000, ...unpaid }),
    ]),
    [],
  );
});

test('money coming in is never a duplicate charge', () => {
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - DAY, direction: 'in', amountMinor: 500_000 }),
      record({ occurredAt: NOW - DAY, direction: 'in', amountMinor: 500_000 }),
    ]),
    [],
  );
});

test('a payment is never paired with the refund that reverses it', () => {

  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 2 * DAY, counterparty: 'Anand Sports', amountMinor: 250_000 }),
      record({ occurredAt: NOW - DAY, counterparty: 'Anand Sports', amountMinor: -250_000, kind: 'receipt' }),
    ]),
    [],
  );
});

test('one owner\'s payments are not compared with another\'s', () => {

  const mine = record({ occurredAt: NOW - DAY, counterparty: 'Ganesh Kirana', amountMinor: 150_000 });
  assert.deepEqual(rules([mine]), []);
});

test('a steady subscription that jumps is reported as a change, with its history', () => {
  const drafts = detectAnomalies([
    record({ occurredAt: NOW - 95 * DAY, amountMinor: 49_900 }),
    record({ occurredAt: NOW - 65 * DAY, amountMinor: 49_900 }),
    record({ occurredAt: NOW - 35 * DAY, amountMinor: 49_900 }),
    record({ occurredAt: NOW - 5 * DAY, amountMinor: 64_900 }),
  ]);
  assert.deepEqual(drafts.map((draft) => draft.rule), ['recurring_amount_changed']);

  assert.equal(drafts[0]?.amountMinor, 64_900);
  assert.match(drafts[0]?.title ?? '', /higher/);
  assert.match(drafts[0]?.detail ?? '', /₹499\.00/);
  assert.match(drafts[0]?.detail ?? '', /₹649\.00/);
  assert.equal(drafts[0]?.sources.length, 3);
});

test('a bill that was never the same twice has no price to have changed', () => {
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 95 * DAY, counterparty: 'Power board', amountMinor: 81_200 }),
      record({ occurredAt: NOW - 65 * DAY, counterparty: 'Power board', amountMinor: 93_400 }),
      record({ occurredAt: NOW - 35 * DAY, counterparty: 'Power board', amountMinor: 77_500 }),
      record({ occurredAt: NOW - 5 * DAY, counterparty: 'Power board', amountMinor: 104_000 }),
    ]),
    [],
  );
});

test('a rise under a twentieth is below the noise floor', () => {
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 95 * DAY, amountMinor: 100_000 }),
      record({ occurredAt: NOW - 65 * DAY, amountMinor: 100_000 }),
      record({ occurredAt: NOW - 35 * DAY, amountMinor: 100_000 }),
      record({ occurredAt: NOW - 5 * DAY, amountMinor: 103_000 }),
    ]),
    [],
  );
});

test('a monthly electricity bill that has merely swung with the weather is left alone', () => {

  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 125 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 118_000 }),
      record({ occurredAt: NOW - 95 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 126_500 }),
      record({ occurredAt: NOW - 65 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 122_300 }),
      record({ occurredAt: NOW - 35 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 129_000 }),
      record({ occurredAt: NOW - 5 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 148_000 }),
    ]),
    [],
  );
});

test('a bill that has sat still for months and then triples is worth a look', () => {
  const draft = draftFor(
    [
      record({ occurredAt: NOW - 125 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 118_000 }),
      record({ occurredAt: NOW - 95 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 126_500 }),
      record({ occurredAt: NOW - 65 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 122_300 }),
      record({ occurredAt: NOW - 35 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 129_000 }),
      record({ occurredAt: NOW - 5 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 486_000 }),
    ],
    'recurring_amount_changed',
  );
  assert.ok(draft, 'a bill three times its usual size is the case this rule exists for');
  assert.match(draft.title, /Karnataka Power is higher this time/);

  assert.match(draft.detail, /₹1,180\.00/);
  assert.match(draft.detail, /₹1,290\.00/);
  assert.match(draft.detail, /₹4,860\.00/);
});

test('a bill that comes in small is not worth an explanation', () => {
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 125 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 118_000 }),
      record({ occurredAt: NOW - 95 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 126_500 }),
      record({ occurredAt: NOW - 65 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 122_300 }),
      record({ occurredAt: NOW - 35 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 129_000 }),
      record({ occurredAt: NOW - 5 * DAY, counterparty: 'Karnataka Power', kind: 'bill', amountMinor: 30_000 }),
    ]),
    [],
  );
});

test('a price that halves is still reported, because the record itself says so', () => {
  const draft = draftFor(
    [
      record({ occurredAt: NOW - 95 * DAY, amountMinor: 100_000 }),
      record({ occurredAt: NOW - 65 * DAY, amountMinor: 100_000 }),
      record({ occurredAt: NOW - 35 * DAY, amountMinor: 100_000 }),
      record({ occurredAt: NOW - 5 * DAY, amountMinor: 50_000 }),
    ],
    'recurring_amount_changed',
  );
  assert.ok(draft);
  assert.match(draft.title, /lower this time/);
  assert.equal(draft.amountMinor, 50_000);
});

test('two payments are a duplicate only when the payee is spelled the same way', () => {

  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - DAY, counterparty: 'Jio', amountMinor: 89_900 }),
      record({ occurredAt: NOW - DAY, counterparty: 'Reliance Jio', amountMinor: 89_900 }),
    ]),
    [],
  );
});

test('a series uses the app\'s one payee identity rule, not a second opinion', () => {

  const drafts = detectAnomalies([
    record({ occurredAt: NOW - 95 * DAY, counterparty: 'Jio', amountMinor: 34_900 }),
    record({ occurredAt: NOW - 65 * DAY, counterparty: 'Jio', amountMinor: 34_900 }),
    record({ occurredAt: NOW - 35 * DAY, counterparty: 'Jio', amountMinor: 34_900 }),
    record({ occurredAt: NOW - 5 * DAY, counterparty: 'Reliance Jio', amountMinor: 89_900 }),
  ]);
  assert.deepEqual(drafts.map((draft) => draft.rule), ['recurring_amount_changed']);

  assert.match(drafts[0]?.title ?? '', /^Reliance Jio is higher this time$/);
});

test('two payees sharing a word but neither containing the other stay apart', () => {

  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 95 * DAY, counterparty: 'Reliance Jio', amountMinor: 34_900 }),
      record({ occurredAt: NOW - 65 * DAY, counterparty: 'Reliance Jio', amountMinor: 34_900 }),
      record({ occurredAt: NOW - 35 * DAY, counterparty: 'Reliance Jio', amountMinor: 34_900 }),
      record({ occurredAt: NOW - 5 * DAY, counterparty: 'Reliance Digital', amountMinor: 1_200_000 }),
    ]),
    [],
  );
});

test('the same payee with different spacing and case is one payee', () => {
  const drafts = detectAnomalies([
    record({ occurredAt: NOW - 95 * DAY, counterparty: 'shakti  electric', amountMinor: 120_000 }),
    record({ occurredAt: NOW - 65 * DAY, counterparty: 'Shakti Electric ', amountMinor: 120_000 }),
    record({ occurredAt: NOW - 35 * DAY, counterparty: 'SHAKTI ELECTRIC', amountMinor: 120_000 }),
    record({ occurredAt: NOW - 5 * DAY, counterparty: ' Shakti Electric', amountMinor: 240_000 }),
  ]);
  assert.deepEqual(drafts.map((draft) => draft.rule), ['recurring_amount_changed']);
});

test('a payment in another currency does not join a rupee series', () => {

  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 95 * DAY, currency: 'INR', amountMinor: 100_000 }),
      record({ occurredAt: NOW - 65 * DAY, currency: 'INR', amountMinor: 100_000 }),
      record({ occurredAt: NOW - 35 * DAY, currency: 'INR', amountMinor: 100_000 }),
      record({ occurredAt: NOW - 5 * DAY, currency: 'USD', amountMinor: 2_500_000 }),
    ]),
    [],
  );
});

test('a record with no amount, no payee or no date supports nothing', () => {
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 95 * DAY, amountMinor: null }),
      record({ occurredAt: NOW - 65 * DAY, amountMinor: null }),
      record({ occurredAt: NOW - 35 * DAY, amountMinor: null }),
      record({ occurredAt: NOW - 5 * DAY, amountMinor: null }),
      record({ occurredAt: NOW, currency: null }),
      record({ occurredAt: NOW, counterparty: '   ' }),
      record({ occurredAt: null }),
    ]),
    [],
  );
});

test('no records at all produce nothing', () => {
  assert.deepEqual(detectAnomalies([], NOW), []);
  assert.deepEqual(detectPending([], NOW), []);
  assert.deepEqual(detectUntouchedMeetings([], NOW), []);
});

test('three payments and then nothing for a cycle plus a week is raised as missing', () => {
  const drafts = detectAnomalies([
    record({ occurredAt: NOW - 100 * DAY }),
    record({ occurredAt: NOW - 70 * DAY }),
    record({ occurredAt: NOW - 40 * DAY }),
  ]);
  assert.deepEqual(drafts.map((draft) => draft.rule), ['recurring_missing']);

  assert.equal(drafts[0]?.dueAt, NOW - 40 * DAY + 30 * DAY);
});

test('the missing-payment sentence says nothing was saved, not that nothing was paid', () => {
  const draft = draftFor(
    [
      record({ occurredAt: NOW - 100 * DAY, counterparty: 'Shakti Electric' }),
      record({ occurredAt: NOW - 70 * DAY, counterparty: 'Shakti Electric' }),
      record({ occurredAt: NOW - 40 * DAY, counterparty: 'Shakti Electric' }),
    ],
    'recurring_missing',
  );
  assert.ok(draft);

  assert.match(draft.title, /Nothing saved for Shakti Electric/);
  assert.doesNotMatch(draft.title, /missed|failed|not paid/);
  assert.match(draft.detail, /every 30 days/);
});

test('a payment only days overdue is not yet missing', () => {
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 93 * DAY }),
      record({ occurredAt: NOW - 63 * DAY }),
      record({ occurredAt: NOW - 33 * DAY }),
    ]),
    [],
  );
});

test('a subscription cancelled months ago stops being raised', () => {
  assert.deepEqual(
    rules([
      record({ occurredAt: NOW - 190 * DAY }),
      record({ occurredAt: NOW - 160 * DAY }),
      record({ occurredAt: NOW - 130 * DAY }),
    ]),
    [],
  );
});

test('once the late payment is saved, the finding goes away', () => {
  const history = [
    record({ occurredAt: NOW - 100 * DAY, counterparty: 'Shakti Electric' }),
    record({ occurredAt: NOW - 70 * DAY, counterparty: 'Shakti Electric' }),
    record({ occurredAt: NOW - 40 * DAY, counterparty: 'Shakti Electric' }),
  ];
  assert.deepEqual(rules(history), ['recurring_missing']);

  const arrived = [...history, record({ occurredAt: NOW - 2 * DAY, counterparty: 'Shakti Electric' })];
  assert.deepEqual(rules(arrived), []);
});

let pendingCounter = 0;
function pending(overrides: Partial<PendingRecord> = {}): PendingRecord {
  pendingCounter += 1;
  return {
    id: `rec_p${pendingCounter}`,
    title: `Entry ${pendingCounter}`,
    createdAt: NOW - 10 * DAY,
    question: 'What was the amount?',
    unread: false,
    ...overrides,
  };
}

test('one entry waiting on one answer is a card naming it and the question', () => {
  const drafts = detectPending(
    [pending({ id: 'rec_1', title: 'Repair bill', question: 'How much did this cost?' })],
    NOW,
  );
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.rule, 'unfinished_entries');
  assert.equal(drafts[0]?.kind, 'anomaly');
  assert.match(drafts[0]?.title ?? '', /Repair bill is not finished/);

  assert.match(drafts[0]?.detail ?? '', /How much did this cost\?/);
  assert.deepEqual(drafts[0]?.sources, [{ kind: 'record', id: 'rec_1' }]);
});

test('several entries waiting are one card, not one card each', () => {

  const drafts = detectPending(
    [
      pending({ id: 'rec_1', createdAt: NOW - 30 * DAY }),
      pending({ id: 'rec_2', createdAt: NOW - 20 * DAY }),
      pending({ id: 'rec_3', createdAt: NOW - 10 * DAY }),
      pending({ id: 'rec_4', createdAt: NOW - 5 * DAY }),
    ],
    NOW,
  );
  assert.equal(drafts.length, 1);
  assert.match(drafts[0]?.title ?? '', /4 entries are waiting on one detail/);
  assert.equal(drafts[0]?.sources.length, 4);

  const oldest = new Date(NOW - 30 * DAY);
  assert.match(drafts[0]?.detail ?? '', new RegExp(String(oldest.getUTCDate()).padStart(2, '0')));
});

test('the card names a bounded number of entries however many are waiting', () => {
  const many = Array.from({ length: 40 }, (_unused, index) =>
    pending({ id: `rec_${index}`, createdAt: NOW - (index + 5) * DAY }),
  );
  const drafts = detectPending(many, NOW);
  assert.equal(drafts.length, 1);
  assert.match(drafts[0]?.title ?? '', /40 entries are waiting/);
  assert.equal(drafts[0]?.sources.length, 6, 'the chips on one card have to stay tappable');
});

test('a capture from this morning is in progress, not neglected', () => {
  assert.deepEqual(detectPending([pending({ createdAt: NOW - 2 * 3_600_000 })], NOW), []);
});

test('two days is still too soon, and three days is not', () => {
  assert.deepEqual(detectPending([pending({ createdAt: NOW - 2 * DAY })], NOW), []);
  assert.equal(detectPending([pending({ createdAt: NOW - 3 * DAY - 1 })], NOW).length, 1);
});

test('a file nothing could be read from is raised on its own, unattached to a question', () => {
  const drafts = detectPending(
    [
      pending({
        id: 'rec_blur',
        title: 'IMG_4471.jpg',
        unread: true,
        question: 'Nothing could be read from this. What is it? A few words is enough.',
      }),
    ],
    NOW,
  );
  assert.deepEqual(drafts.map((draft) => draft.rule), ['unread_captures']);
  assert.match(drafts[0]?.title ?? '', /Nothing could be read from IMG_4471\.jpg/);

  assert.match(drafts[0]?.detail ?? '', /clearer photo/);
});

test('an unreadable file is never counted twice, once as a question and once as a read', () => {
  const drafts = detectPending(
    [
      pending({ id: 'rec_blur', unread: true, question: 'Nothing could be read from this.' }),
      pending({ id: 'rec_ask', unread: false, question: 'What was the amount?' }),
    ],
    NOW,
  );
  assert.deepEqual(drafts.map((draft) => draft.rule), ['unfinished_entries', 'unread_captures']);
  assert.deepEqual(drafts[0]?.sources, [{ kind: 'record', id: 'rec_ask' }]);
  assert.deepEqual(drafts[1]?.sources, [{ kind: 'record', id: 'rec_blur' }]);
});

test('a failed read is worth raising sooner than an unanswered question', () => {

  assert.equal(detectPending([pending({ unread: true, createdAt: NOW - 2 * DAY })], NOW).length, 1);
  assert.deepEqual(detectPending([pending({ unread: true, createdAt: NOW - 3_600_000 })], NOW), []);
});

test('an entry with no question is not waiting on one', () => {
  assert.deepEqual(detectPending([pending({ question: null })], NOW), []);
});

test('the card changes when one of the entries is answered, rather than going stale', () => {
  const three = [
    pending({ id: 'rec_1' }),
    pending({ id: 'rec_2' }),
    pending({ id: 'rec_3' }),
  ];
  const before = detectPending(three, NOW)[0]!.fingerprint;

  const after = detectPending([three[0]!, three[2]!], NOW)[0]!.fingerprint;
  assert.notEqual(before, after);

  assert.deepEqual(detectPending([], NOW), []);
});

function meeting(overrides: Partial<MeetingProgress> = {}): MeetingProgress {
  return { id: 'mtg_1', title: 'Builder call', startedAt: NOW - 20 * DAY, items: 4, done: 0, ...overrides };
}

test('a meeting a fortnight old with nothing marked done is raised', () => {
  const drafts = detectUntouchedMeetings([meeting()], NOW);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.rule, 'meeting_untouched');
  assert.match(drafts[0]?.title ?? '', /4 things from Builder call are still open/);
  assert.match(drafts[0]?.detail ?? '', /20 days ago/);
  assert.deepEqual(drafts[0]?.sources, [{ kind: 'meeting', id: 'mtg_1' }]);
});

test('one open thing from a meeting is a thing to do, and the things-to-do list holds it', () => {
  assert.deepEqual(detectUntouchedMeetings([meeting({ items: 2 })], NOW), []);
});

test('a meeting where anything was ticked off is not untouched', () => {
  assert.deepEqual(detectUntouchedMeetings([meeting({ done: 1 })], NOW), []);
});

test('last week is too soon and last spring is history', () => {
  assert.deepEqual(detectUntouchedMeetings([meeting({ startedAt: NOW - 10 * DAY })], NOW), []);
  assert.deepEqual(detectUntouchedMeetings([meeting({ startedAt: NOW - 90 * DAY })], NOW), []);
});

test('a meeting with nothing recorded from it supports nothing', () => {
  assert.deepEqual(detectUntouchedMeetings([meeting({ items: 0 })], NOW), []);
});

test('every draft cites at least one record and carries a rule and a fingerprint', () => {
  const drafts = detectAnomalies([
    record({ occurredAt: NOW - 100 * DAY }),
    record({ occurredAt: NOW - 70 * DAY }),
    record({ occurredAt: NOW - 40 * DAY }),
    record({ occurredAt: NOW - DAY, counterparty: 'Cafe', amountMinor: 18_000 }),
    record({ occurredAt: NOW - DAY, counterparty: 'Cafe', amountMinor: 18_000 }),
  ]);
  assert.ok(drafts.length >= 2);
  for (const draft of drafts) {
    assert.ok(draft.sources.length > 0, `${draft.rule} cited nothing`);
    assert.ok(draft.fingerprint.length > 0);
    assert.ok(draft.title.length > 0);
    assert.ok(draft.detail.length > 0);
  }
});

test('the same records scanned twice produce the same fingerprints', () => {
  const records = [
    record({ occurredAt: NOW - DAY, counterparty: 'Cafe', amountMinor: 18_000 }),
    record({ occurredAt: NOW - DAY, counterparty: 'Cafe', amountMinor: 18_000 }),
  ];
  assert.deepEqual(
    detectAnomalies(records, NOW).map((draft) => draft.fingerprint),
    detectAnomalies(records, NOW + DAY).map((draft) => draft.fingerprint),
  );
});

test('nothing a person reads is a token, a percentage or a provider name', () => {
  const drafts = [
    ...detectAnomalies(
      [
        record({ occurredAt: NOW - 100 * DAY, counterparty: 'Shakti Electric' }),
        record({ occurredAt: NOW - 70 * DAY, counterparty: 'Shakti Electric' }),
        record({ occurredAt: NOW - 40 * DAY, counterparty: 'Shakti Electric' }),
      ],
      NOW,
    ),
    ...detectPending([pending(), pending({ id: 'rec_b', unread: true })], NOW),
    ...detectUntouchedMeetings([meeting()], NOW),
  ];
  assert.ok(drafts.length >= 4);
  for (const draft of drafts) {
    const shown = `${draft.title} ${draft.detail}`;
    for (const word of ['anomaly', 'signal', 'heuristic', 'confidence', 'rule', 'fingerprint', '%']) {
      assert.doesNotMatch(shown.toLowerCase(), new RegExp(`\\b${word}\\b`), `${draft.rule} leaked "${word}"`);
    }
    assert.doesNotMatch(shown, /\b(groq|grok|xai|errno|E[A-Z]{3}\d|undefined|NaN)\b/i);
  }
});

test('the whole pass stays linear over a long history', () => {

  const payees = ['Sharma Electricals', 'Ganesh Kirana', 'Sai Tea Stall', 'Metro Card', 'Bharat Traders'];
  const many: AnomalyRecord[] = [];
  for (let index = 0; index < 3_650; index += 1) {
    many.push(
      record({
        occurredAt: NOW - index * DAY,
        counterparty: payees[index % payees.length]!,
        kind: index % 5 === 0 ? 'bill' : 'payment',
        amountMinor: 20_000 + (index % 37) * 1_000,
      }),
    );
  }
  const started = Date.now();
  detectAnomalies(many, NOW);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3_000, `detectors took ${elapsed}ms over 3650 records`);
});

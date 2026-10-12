import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MIN_HISTORY_DAYS_FOR_NEW_PAYEE,
  MIN_HISTORY_FOR_NEW_PAYEE,
  MIN_OUTLIER_HISTORY,
  MIN_SERIES_OCCURRENCES,
  OVERDUE_SILENCE_DAYS,
  amountOutliers,
  detectRecurring,
  duplicateCharges,
  lapsedSeries,
  newLargePayees,
  overdueSeries,
  recurringSeries,
  type RecurringRecord,
} from './recurring.ts';

const DAY = 86_400_000;

const NOW = new Date(2026, 9, 2, 11, 0, 0).getTime();

function on(year: number, month: number, day: number, hour = 10): number {
  return new Date(year, month - 1, day, hour, 0, 0).getTime();
}

function dateOf(at: number): string {
  const when = new Date(at);
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
}

let counter = 0;
function record(overrides: Partial<RecurringRecord> = {}): RecurringRecord {
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
    ...overrides,
  };
}

function monthly(
  counterparty: string,
  amountMinor: number,
  from: { year: number; month: number; day: number },
  count: number,
): RecurringRecord[] {
  return Array.from({ length: count }, (_, index) =>
    record({
      counterparty,
      amountMinor,
      occurredAt: on(from.year, from.month + index, from.day),
    }),
  );
}

test('one payment is not a pattern, and neither are two', () => {
  assert.deepEqual(detectRecurring([record({ occurredAt: on(2026, 9, 5) })], NOW), []);

  assert.equal(MIN_SERIES_OCCURRENCES, 3);
  const two = [record({ occurredAt: on(2026, 8, 5) }), record({ occurredAt: on(2026, 9, 5) })];
  assert.deepEqual(detectRecurring(two, NOW), []);
  assert.deepEqual(recurringSeries(two, NOW), []);
});

test('a single large one-off is never turned into a pattern', () => {

  const gift = [record({ counterparty: 'Tanishq', amountMinor: 85_000_00, occurredAt: on(2026, 9, 14) })];
  assert.deepEqual(detectRecurring(gift, NOW), []);
  assert.deepEqual(lapsedSeries(gift, NOW), []);
  assert.deepEqual(amountOutliers(gift, NOW), []);
});

test('thin data produces no figure at all, not a figure with a caveat', () => {

  const thin = [
    record({ counterparty: 'Swiggy', amountMinor: 42_000, occurredAt: on(2026, 8, 11) }),
    record({ counterparty: 'Swiggy', amountMinor: 38_000, occurredAt: on(2026, 9, 11) }),
  ];
  assert.deepEqual(detectRecurring(thin, NOW), []);
  assert.deepEqual(recurringSeries(thin, NOW), []);
  assert.deepEqual(lapsedSeries(thin, NOW), []);
  assert.deepEqual(overdueSeries(thin, NOW), []);
  assert.deepEqual(amountOutliers(thin, NOW), []);
});

const CADENCE_CASES: Array<{
  name: string;
  records: RecurringRecord[];
  cadence: string;
  label: string;
  nextAt: string;
  amountMinor: number;
}> = [
  {
    name: 'a year of Airtel bills paid on the 5th',
    records: monthly('Airtel', 59_900, { year: 2025, month: 10, day: 5 }, 12),
    cadence: 'monthly',
    label: 'every month',
    nextAt: '2026-10-05',
    amountMinor: 59_900,
  },
  {
    name: 'school fees every quarter',
    records: [
      record({ counterparty: 'Podar International School', amountMinor: 24_500_00, occurredAt: on(2025, 7, 10) }),
      record({ counterparty: 'Podar International School', amountMinor: 24_500_00, occurredAt: on(2025, 10, 10) }),
      record({ counterparty: 'Podar International School', amountMinor: 26_000_00, occurredAt: on(2026, 1, 12) }),
      record({ counterparty: 'Podar International School', amountMinor: 26_000_00, occurredAt: on(2026, 4, 10) }),
      record({ counterparty: 'Podar International School', amountMinor: 26_000_00, occurredAt: on(2026, 7, 10) }),
    ],
    cadence: 'quarterly',
    label: 'every three months',
    nextAt: '2026-10-10',
    amountMinor: 26_000_00,
  },
  {
    name: 'a yearly insurance premium that drifts a few days',
    records: [
      record({ counterparty: 'LIC', amountMinor: 18_400_00, occurredAt: on(2023, 10, 18) }),
      record({ counterparty: 'LIC', amountMinor: 18_400_00, occurredAt: on(2024, 10, 20) }),
      record({ counterparty: 'LIC', amountMinor: 19_100_00, occurredAt: on(2025, 10, 16) }),
    ],
    cadence: 'annual',
    label: 'once a year',
    nextAt: '2026-10-18',
    amountMinor: 18_400_00,
  },
  {
    name: 'a half-yearly vehicle insurance renewal',
    records: [
      record({ counterparty: 'Bajaj Allianz', amountMinor: 7_200_00, occurredAt: on(2024, 10, 8) }),
      record({ counterparty: 'Bajaj Allianz', amountMinor: 7_200_00, occurredAt: on(2025, 4, 8) }),
      record({ counterparty: 'Bajaj Allianz', amountMinor: 7_450_00, occurredAt: on(2025, 10, 9) }),
      record({ counterparty: 'Bajaj Allianz', amountMinor: 7_450_00, occurredAt: on(2026, 4, 8) }),
    ],
    cadence: 'half-yearly',
    label: 'every six months',
    nextAt: '2026-10-08',
    amountMinor: 7_325_00,
  },
  {
    name: 'a weekly maid payment',
    records: [
      record({ counterparty: 'Sunita', amountMinor: 1_500_00, occurredAt: on(2026, 9, 11) }),
      record({ counterparty: 'Sunita', amountMinor: 1_500_00, occurredAt: on(2026, 9, 18) }),
      record({ counterparty: 'Sunita', amountMinor: 1_500_00, occurredAt: on(2026, 9, 25) }),
    ],
    cadence: 'weekly',
    label: 'every week',
    nextAt: '2026-10-02',
    amountMinor: 1_500_00,
  },
];

for (const scenario of CADENCE_CASES) {
  test(`cadence: ${scenario.name}`, () => {
    const predictions = detectRecurring(scenario.records, NOW);
    assert.equal(predictions.length, 1, scenario.name);
    const prediction = predictions[0]!;
    assert.equal(prediction.cadence, scenario.cadence);
    assert.equal(prediction.cadenceLabel, scenario.label);
    assert.equal(dateOf(prediction.at), scenario.nextAt);
    assert.equal(prediction.amountMinor, scenario.amountMinor);
    assert.equal(prediction.occurrences, scenario.records.length);

    assert.match(prediction.basis, /^based on the last /);
    assert.deepEqual([...prediction.recordIds].sort(), scenario.records.map((r) => r.id).sort());
  });
}

test('a monthly bill whose date drifts is still monthly, and says what it drifted between', () => {

  const days = [3, 3, 4, 5, 4, 6, 5, 7, 6, 8];
  const bills = days.map((day, index) =>
    record({ counterparty: 'Airtel', amountMinor: 59_900, occurredAt: on(2025, 12 + index, day) }),
  );
  const prediction = detectRecurring(bills, NOW)[0];
  assert.equal(prediction?.cadence, 'monthly');
  assert.equal(dateOf(prediction!.at), '2026-10-05');
  assert.match(prediction!.basis, /based on the last ten months, between the 3rd and the 8th — usually the 5th\./);
});

test('a summer electricity bill is one series whose amount is given as a range', () => {
  const amounts = [84_000, 79_000, 81_000, 88_000, 1_42_000, 2_38_000, 3_12_000, 2_04_000, 1_10_000, 92_000, 86_000];
  const power = amounts.map((amountMinor, index) =>
    record({ counterparty: 'MSEDCL', kind: 'bill', amountMinor, occurredAt: on(2025, 11 + index, 12) }),
  );
  const prediction = detectRecurring(power, NOW)[0];
  assert.equal(prediction?.cadence, 'monthly');
  assert.equal(dateOf(prediction!.at), '2026-10-12');

  assert.equal(prediction?.steadyAmount, false);
  assert.equal(prediction?.lowAmountMinor, 79_000);
  assert.equal(prediction?.highAmountMinor, 3_12_000);
  assert.equal(prediction?.amountMinor, 92_000);
});

const NOT_RECURRING: Array<{ name: string; records: RecurringRecord[] }> = [
  {
    name: 'gaps that fit no single cadence window',
    records: [
      record({ occurredAt: on(2026, 8, 7) }),
      record({ occurredAt: on(2026, 8, 22) }),
      record({ occurredAt: on(2026, 9, 21) }),
    ],
  },
  {
    name: 'a shop visited twice some months and once in others',
    records: [
      record({ counterparty: 'Big Bazaar', amountMinor: 1_200_00, occurredAt: on(2026, 6, 1) }),
      record({ counterparty: 'Big Bazaar', amountMinor: 1_200_00, occurredAt: on(2026, 6, 16) }),
      record({ counterparty: 'Big Bazaar', amountMinor: 1_200_00, occurredAt: on(2026, 7, 16) }),
      record({ counterparty: 'Big Bazaar', amountMinor: 1_200_00, occurredAt: on(2026, 8, 1) }),
      record({ counterparty: 'Big Bazaar', amountMinor: 1_200_00, occurredAt: on(2026, 8, 31) }),
    ],
  },
  {
    name: 'a daily chai that is not weekly, fortnightly or anything else',
    records: Array.from({ length: 40 }, (_, index) =>
      record({ counterparty: 'Amar Tea Stall', amountMinor: 2_000, occurredAt: NOW - index * DAY }),
    ),
  },
  {
    name: 'three payments on the same instant',
    records: [record({ occurredAt: NOW }), record({ occurredAt: NOW }), record({ occurredAt: NOW })],
  },
];

for (const scenario of NOT_RECURRING) {
  test(`not a cadence: ${scenario.name}`, () => {
    assert.deepEqual(detectRecurring(scenario.records, NOW), []);
  });
}

test('two unrelated charges to one payee are two series, not one fortnightly invention', () => {

  const phone = monthly('Airtel', 39_900, { year: 2026, month: 5, day: 1 }, 5);
  const fibre = monthly('Airtel', 99_900, { year: 2026, month: 5, day: 16 }, 5);
  const predictions = detectRecurring([...phone, ...fibre], NOW);

  assert.equal(predictions.length, 2);
  assert.deepEqual(predictions.map((p) => p.cadence), ['monthly', 'monthly']);
  assert.deepEqual(predictions.map((p) => dateOf(p.at)), ['2026-10-01', '2026-10-16']);
  assert.deepEqual(predictions.map((p) => p.amountMinor), [39_900, 99_900]);

  assert.deepEqual([...predictions[0]!.recordIds].sort(), phone.map((r) => r.id).sort());
  assert.deepEqual([...predictions[1]!.recordIds].sort(), fibre.map((r) => r.id).sort());
});

test('two charges of the same size on two days are still two series', () => {

  const first = monthly('Vodafone Idea', 44_900, { year: 2026, month: 5, day: 2 }, 5);
  const second = monthly('Vodafone Idea', 44_900, { year: 2026, month: 5, day: 18 }, 5);
  const predictions = detectRecurring([...first, ...second], NOW);
  assert.equal(predictions.length, 2);
  assert.deepEqual(predictions.map((p) => dateOf(p.at)), ['2026-10-02', '2026-10-18']);
});

test('the same payee written differently is grouped as one', () => {
  const bills = [
    record({ counterparty: 'AIRTEL PREPAID', amountMinor: 59_900, occurredAt: on(2026, 6, 5) }),
    record({ counterparty: 'Bharti Airtel', amountMinor: 59_900, occurredAt: on(2026, 7, 5) }),
    record({ counterparty: 'UPI/DR/412345678901/Airtel', amountMinor: 59_900, occurredAt: on(2026, 8, 5) }),
    record({ counterparty: '  airtel ', amountMinor: 59_900, occurredAt: on(2026, 9, 5) }),
  ];
  const predictions = detectRecurring(bills, NOW);
  assert.equal(predictions.length, 1);
  assert.equal(predictions[0]?.occurrences, 4);
  assert.equal(dateOf(predictions[0]!.at), '2026-10-05');

  assert.deepEqual(predictions[0]?.aliases, [
    'AIRTEL PREPAID',
    'Bharti Airtel',
    'UPI/DR/412345678901/Airtel',
    'airtel',
  ]);
});

test('two companies that share a word are not merged', () => {

  const mixed = [
    record({ counterparty: 'Reliance Jio', amountMinor: 34_900, occurredAt: on(2026, 7, 9) }),
    record({ counterparty: 'Reliance Jio', amountMinor: 34_900, occurredAt: on(2026, 8, 9) }),
    record({ counterparty: 'Reliance Digital', amountMinor: 42_000_00, occurredAt: on(2026, 9, 9) }),
  ];
  assert.deepEqual(detectRecurring(mixed, NOW), []);
});

test('a cancelled subscription stops being predicted and is reported as stopped instead', () => {
  const netflix = monthly('Netflix', 64_900, { year: 2026, month: 1, day: 7 }, 4);
  assert.deepEqual(detectRecurring(netflix, NOW), []);

  const lapsed = lapsedSeries(netflix, NOW);
  assert.equal(lapsed.length, 1);
  assert.equal(lapsed[0]?.cadence, 'monthly');
  assert.equal(lapsed[0]?.lapsed, true);
  assert.equal(dateOf(lapsed[0]!.lastAt), '2026-04-07');
  assert.match(lapsed[0]!.basis, /based on the last four months, always on the 7th\./);

  assert.deepEqual(overdueSeries(netflix, NOW), []);
});

test('a bill that has not arrived is raised only after a week of silence', () => {
  assert.equal(OVERDUE_SILENCE_DAYS, 7);
  const power = [
    record({ counterparty: 'Tata Power', kind: 'bill', amountMinor: 1_40_000, occurredAt: on(2026, 5, 12) }),
    record({ counterparty: 'Tata Power', kind: 'bill', amountMinor: 1_38_000, occurredAt: on(2026, 6, 12) }),
    record({ counterparty: 'Tata Power', kind: 'bill', amountMinor: 1_41_000, occurredAt: on(2026, 7, 12) }),
    record({ counterparty: 'Tata Power', kind: 'bill', amountMinor: 1_39_000, occurredAt: on(2026, 8, 12) }),
  ];

  assert.deepEqual(overdueSeries(power, on(2026, 9, 15)), []);

  const late = overdueSeries(power, NOW);
  assert.equal(late.length, 1);
  assert.equal(late[0]?.overdueDays, 20);
  assert.equal(late[0]?.lapsed, false);
});

test('a payment three days late is still shown as due rather than hidden', () => {

  const rent = monthly('Landlord', 28_000_00, { year: 2026, month: 6, day: 30 }, 3);
  const prediction = detectRecurring(rent, on(2026, 10, 1))[0];
  assert.equal(dateOf(prediction!.at), '2026-09-30');
});

test('a payment predicted for today stays in the forecast all day', () => {

  const rent = monthly('Landlord', 32_000_00, { year: 2026, month: 6, day: 5 }, 4);
  for (const hour of [0, 8, 14, 23]) {
    const prediction = detectRecurring(rent, on(2026, 10, 5, hour))[0];
    assert.equal(dateOf(prediction!.at), '2026-10-05', `at ${hour}:00`);
  }
});

test('lateness is counted in whole days, so an evening is not a day late', () => {
  const power = monthly('Tata Power', 1_40_000, { year: 2026, month: 5, day: 12 }, 4);

  assert.equal(overdueSeries(power, on(2026, 9, 19, 8))[0]?.overdueDays, 7);

  assert.deepEqual(overdueSeries(power, on(2026, 9, 18, 23)), []);
});

test('a year of weekly payments stays one weekly series', () => {

  const maid = Array.from({ length: 52 }, (_, index) =>
    record({ counterparty: 'Sunita', amountMinor: 1_500_00, occurredAt: on(2025, 10, 4 + index * 7) }),
  );
  const predictions = detectRecurring(maid, NOW);
  assert.equal(predictions.length, 1);
  assert.equal(predictions[0]?.cadence, 'weekly');
  assert.equal(predictions[0]?.occurrences, 52);
});

test('records that cannot support a cadence are skipped rather than defaulted', () => {
  const broken = [
    record({ counterparty: 'A', occurredAt: null }),
    record({ counterparty: 'A', occurredAt: on(2026, 7, 1), amountMinor: null }),
    record({ counterparty: 'A', occurredAt: on(2026, 8, 1), currency: null }),
    record({ counterparty: '   ', occurredAt: on(2026, 9, 1) }),
  ];
  assert.deepEqual(detectRecurring(broken, NOW), []);
});

test('a refund is not a recurring outgoing, and neither is a zero', () => {
  const refunds = monthly('Amazon', -1_200_00, { year: 2026, month: 6, day: 4 }, 4);
  assert.deepEqual(detectRecurring(refunds, NOW), []);
  const zeroes = monthly('Amazon', 0, { year: 2026, month: 6, day: 4 }, 4);
  assert.deepEqual(detectRecurring(zeroes, NOW), []);
});

test('income, unsettled records and other payees are left out of a cadence', () => {
  const records = [
    ...monthly('Netflix', 64_900, { year: 2026, month: 6, day: 7 }, 4),
    record({ counterparty: 'Netflix', occurredAt: on(2026, 8, 20), direction: 'in' }),
    record({ counterparty: 'Netflix', occurredAt: on(2026, 8, 25), status: 'needs_context' }),
    record({ counterparty: 'Hotstar', occurredAt: on(2026, 8, 25) }),
  ];
  const predictions = detectRecurring(records, NOW);
  assert.equal(predictions.length, 1);
  assert.equal(predictions[0]?.occurrences, 4);
  assert.equal(dateOf(predictions[0]!.at), '2026-10-07');
});

test('a directionless record counts as spend only for a transactional kind', () => {
  const payments = monthly('Netflix', 64_900, { year: 2026, month: 6, day: 7 }, 4).map((row) => ({
    ...row,
    direction: null,
  }));
  assert.equal(detectRecurring(payments, NOW).length, 1);

  const notes = payments.map((row) => ({ ...row, kind: 'note' }));
  assert.deepEqual(detectRecurring(notes, NOW), []);
});

test('a month shorter than the day a bill is paid on clamps rather than skipping', () => {

  const rent = [
    record({ counterparty: 'Landlord', amountMinor: 2_00_000, occurredAt: on(2025, 12, 31) }),
    record({ counterparty: 'Landlord', amountMinor: 2_00_000, occurredAt: on(2026, 1, 31) }),
    record({ counterparty: 'Landlord', amountMinor: 2_00_000, occurredAt: on(2026, 2, 28) }),
    record({ counterparty: 'Landlord', amountMinor: 2_00_000, occurredAt: on(2026, 3, 31) }),
  ];
  const series = recurringSeries(rent, on(2026, 4, 2))[0];
  assert.equal(dateOf(series!.nextAt), '2026-04-30');
});

test('a currency the payee is not usually paid in is left out rather than added up', () => {

  const comcast = [
    record({ counterparty: 'Comcast', amountMinor: 80_00, currency: 'USD', occurredAt: on(2026, 6, 9) }),
    record({ counterparty: 'Comcast', amountMinor: 80_00, currency: 'USD', occurredAt: on(2026, 7, 9) }),
    record({ counterparty: 'Comcast', amountMinor: 85_00, currency: 'USD', occurredAt: on(2026, 8, 9) }),
    record({ counterparty: 'Comcast', amountMinor: 85_00, currency: 'USD', occurredAt: on(2026, 9, 9) }),
    record({ counterparty: 'Comcast', amountMinor: 5_000, currency: 'INR', occurredAt: on(2026, 9, 20) }),
  ];
  const predictions = detectRecurring(comcast, NOW);
  assert.equal(predictions.length, 1);
  assert.equal(predictions[0]?.currency, 'USD');
  assert.equal(predictions[0]?.occurrences, 4);
  assert.equal(predictions[0]?.amountMinor, 82_50);
});

test('a date read month-first does not push the next payment a season away', () => {

  const jio = [
    ...monthly('Jio', 39_900, { year: 2026, month: 6, day: 5 }, 4),
    record({ counterparty: 'Jio', amountMinor: 39_900, occurredAt: on(2027, 1, 9) }),
  ];
  const prediction = detectRecurring(jio, NOW)[0];
  assert.equal(dateOf(prediction!.at), '2026-10-05');
  assert.equal(prediction?.occurrences, 4);
});

test('an even number of occurrences takes the midpoint amount as whole minor units', () => {
  const records = [
    record({ occurredAt: on(2026, 6, 5), amountMinor: 10_000 }),
    record({ occurredAt: on(2026, 7, 5), amountMinor: 10_000 }),
    record({ occurredAt: on(2026, 8, 5), amountMinor: 10_001 }),
    record({ occurredAt: on(2026, 9, 5), amountMinor: 10_001 }),
  ];
  const prediction = detectRecurring(records, NOW)[0];
  assert.equal(prediction?.amountMinor, 10_001);
  assert.ok(Number.isInteger(prediction?.amountMinor));
});

test('a long history is read in a time a request can afford', () => {

  const many: RecurringRecord[] = [];
  for (let payee = 0; payee < 400; payee += 1) {
    for (let index = 0; index < 50; index += 1) {
      many.push(
        record({
          counterparty: `Shop ${payee}`,
          amountMinor: 10_000 + index * 7 + payee,
          occurredAt: NOW - index * DAY * (1 + (payee % 5)),
        }),
      );
    }
  }
  const started = Date.now();
  detectRecurring(many, NOW);
  amountOutliers(many, NOW);
  assert.ok(Date.now() - started < 2_000, `20,000 records took ${Date.now() - started}ms`);
});

test('an unusual amount is named only once a payee has a usual one', () => {
  assert.equal(MIN_OUTLIER_HISTORY, 5);
  const four = [
    record({ counterparty: 'Tata Power', amountMinor: 82_000, occurredAt: on(2026, 6, 8) }),
    record({ counterparty: 'Tata Power', amountMinor: 79_000, occurredAt: on(2026, 7, 8) }),
    record({ counterparty: 'Tata Power', amountMinor: 84_000, occurredAt: on(2026, 8, 8) }),
    record({ counterparty: 'Tata Power', amountMinor: 2_48_000, occurredAt: on(2026, 9, 8) }),
  ];

  assert.deepEqual(amountOutliers(four, NOW), []);

  const five = [
    record({ counterparty: 'Tata Power', amountMinor: 81_000, occurredAt: on(2026, 5, 8) }),
    ...four,
  ];
  const flagged = amountOutliers(five, NOW);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0]?.amountMinor, 2_48_000);
  assert.equal(flagged[0]?.usualMinor, 82_000);

  assert.equal(flagged[0]?.lowMinor, 79_000);
  assert.equal(flagged[0]?.highMinor, 84_000);
  assert.equal(flagged[0]?.comparedWith.length, 4);
  assert.equal(
    flagged[0]?.text,
    '₹2,480.00 to Tata Power, where you usually pay about ₹820.00 (₹790.00 to ₹840.00).',
  );
});

test('a payee whose amounts always wander has nothing unusual in them', () => {

  const kirana = [240_00, 1_850_00, 620_00, 3_100_00, 980_00, 2_400_00, 1_200_00].map((amountMinor, index) =>
    record({ counterparty: 'Ganesh Kirana', amountMinor, occurredAt: on(2026, 9, index + 1) }),
  );
  assert.deepEqual(amountOutliers(kirana, NOW), []);
});

test('a payee paid the identical amount every time has a floor under what counts as unusual', () => {

  const gym = Array.from({ length: 6 }, (_, index) =>
    record({ counterparty: 'Cult Fit', amountMinor: 1_500_00, occurredAt: on(2026, 3 + index, 6) }),
  );
  gym.push(record({ counterparty: 'Cult Fit', amountMinor: 1_500_02, occurredAt: on(2026, 9, 6) }));
  assert.deepEqual(amountOutliers(gym, NOW), []);

  const doubled = [...gym, record({ counterparty: 'Cult Fit', amountMinor: 3_000_00, occurredAt: on(2026, 10, 6) })];
  assert.equal(amountOutliers(doubled, on(2026, 10, 20)).length, 1);
});

function household(): RecurringRecord[] {
  const history: RecurringRecord[] = [];
  for (let month = 7; month <= 9; month += 1) {
    history.push(record({ counterparty: 'Airtel', amountMinor: 59_900, occurredAt: on(2026, month, 5) }));
    history.push(record({ counterparty: 'Tata Power', amountMinor: 1_40_000, occurredAt: on(2026, month, 8) }));
    history.push(record({ counterparty: 'Landlord', amountMinor: 28_000_00, occurredAt: on(2026, month, 1) }));
    for (let visit = 0; visit < 5; visit += 1) {
      history.push(
        record({ counterparty: 'Ganesh Kirana', amountMinor: 80_000 + visit * 9_000, occurredAt: on(2026, month, 10 + visit * 3) }),
      );
    }
  }
  return history;
}

test('a large first payment to an unseen payee is raised, and described rather than accused', () => {
  const records = [...household(), record({ counterparty: 'Tanishq', amountMinor: 85_000_00, occurredAt: on(2026, 9, 20) })];
  const found = newLargePayees(records, NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.counterparty, 'Tanishq');
  assert.equal(found[0]?.text, '₹85,000.00 to Tanishq, a payee with no earlier payments recorded.');

  assert.equal(found[0]?.usualMinor, 1_07_000);
  assert.doesNotMatch(found[0]!.text, /suspicious|fraud|unauthorised|check this/i);
});

test('nothing is said about a new payee until there is history to call it new against', () => {

  assert.equal(MIN_HISTORY_FOR_NEW_PAYEE, 20);
  assert.equal(MIN_HISTORY_DAYS_FOR_NEW_PAYEE, 60);

  const firstWeek = [
    record({ counterparty: 'Landlord', amountMinor: 28_000_00, occurredAt: on(2026, 10, 1) }),
    record({ counterparty: 'Airtel', amountMinor: 59_900, occurredAt: on(2026, 10, 1) }),
    record({ counterparty: 'Tanishq', amountMinor: 85_000_00, occurredAt: on(2026, 10, 2) }),
  ];
  assert.deepEqual(newLargePayees(firstWeek, NOW), []);

  const oneAfternoon = Array.from({ length: 24 }, (_, index) =>
    record({ counterparty: `Shop ${index}`, amountMinor: 50_000, occurredAt: on(2026, 10, 1, 9) }),
  );
  oneAfternoon.push(record({ counterparty: 'Tanishq', amountMinor: 85_000_00, occurredAt: on(2026, 10, 2) }));
  assert.deepEqual(newLargePayees(oneAfternoon, NOW), []);
});

test('an ordinary first payment to a new payee is not news', () => {

  const records = [...household(), record({ counterparty: 'Apollo Pharmacy', amountMinor: 62_000, occurredAt: on(2026, 9, 21) })];
  assert.deepEqual(newLargePayees(records, NOW), []);
});

test('a large payment to a payee already in the history is not a new payee', () => {

  const records = [...household(), record({ counterparty: 'Landlord', amountMinor: 90_000_00, occurredAt: on(2026, 9, 25) })];
  assert.deepEqual(newLargePayees(records, NOW), []);
});

test('a duplicate is only raised when the payee does not repeat that amount by habit', () => {
  const base = household();

  const twice = [
    ...base,
    record({ counterparty: 'BigBasket', amountMinor: 1_299_00, occurredAt: on(2026, 10, 1, 9) }),
    record({ counterparty: 'BigBasket', amountMinor: 1_299_00, occurredAt: on(2026, 10, 1, 14) }),
  ];
  const found = duplicateCharges(twice, NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.text, 'Two payments of ₹1,299.00 to BigBasket within a day of each other.');

  const apart = [
    ...base,
    record({ counterparty: 'BigBasket', amountMinor: 1_299_00, occurredAt: on(2026, 9, 28, 9) }),
    record({ counterparty: 'BigBasket', amountMinor: 1_299_00, occurredAt: on(2026, 10, 1, 9) }),
  ];
  assert.deepEqual(duplicateCharges(apart, NOW), []);
});

test('a future-dated record is not half of a duplicate', () => {
  const slip = [
    ...household(),
    record({ counterparty: 'BigBasket', amountMinor: 1_299_00, occurredAt: on(2026, 10, 2, 9) }),
    record({ counterparty: 'BigBasket', amountMinor: 1_299_00, occurredAt: on(2027, 1, 9) }),
  ];
  assert.deepEqual(duplicateCharges(slip, NOW), []);
});

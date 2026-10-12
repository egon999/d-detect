import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MIN_DAYS_FOR_PACE,
  MIN_RECORDS_FOR_PACE,
  budgetAdvice,
  projectionOf,
  spendingAlerts,
  type BudgetFacts,
} from './budget.ts';
import type { RecurringRecord } from './recurring.ts';

function facts(overrides: Partial<BudgetFacts> = {}): BudgetFacts {
  return {
    currency: 'INR',
    budgetMinor: 30_000_00,
    spentMinor: 10_000_00,
    dayOfPeriod: 10,
    daysInPeriod: 30,
    daysLeft: 20,
    current: true,
    committed: [],
    topCategory: null,
    previousToDateMinor: null,
    excludedRecordCount: 0,
    needsContextCount: 0,
    ...overrides,
  };
}

const kinds = (advice: { kind: string }[]) => advice.map((item) => item.kind);
const find = (advice: { kind: string; text: string; tone: string }[], kind: string) =>
  advice.find((item) => item.kind === kind);

test('a month is not projected from its first days', () => {

  for (const day of [1, 2, 3]) {
    const advice = budgetAdvice(facts({ dayOfPeriod: day, daysLeft: 30 - day, spentMinor: 4_000_00 }));
    assert.equal(find(advice, 'pace'), undefined, `day ${day}`);
  }
  const fourth = budgetAdvice(facts({ dayOfPeriod: 4, daysLeft: 26, spentMinor: 4_000_00 }));
  assert.ok(find(fourth, 'pace'));
});

test('a month with nothing in it says nothing', () => {
  assert.deepEqual(budgetAdvice(facts({ spentMinor: 0 })), []);
});

test('an over-budget month states the overspend and drops the projection', () => {
  const advice = budgetAdvice(facts({ spentMinor: 34_000_00 }));
  const over = find(advice, 'over');
  assert.equal(over?.tone, 'danger');
  assert.match(over!.text, /₹4,000\.00 over the ₹30,000\.00 budget with 20 days of the month left\./);

  assert.equal(find(advice, 'pace'), undefined);
});

test('pace judges against the budget and states the recovery figure only when it is reachable', () => {
  const heading = budgetAdvice(facts({ spentMinor: 10_000_00, budgetMinor: 25_000_00 }));
  const over = find(heading, 'pace');
  assert.equal(over?.tone, 'warn');

  assert.match(over!.text, /₹1,000\.00 a day/);
  assert.match(over!.text, /lands near ₹30,000\.00 — ₹5,000\.00 over/);
  assert.match(over!.text, /₹750\.00 a day for the last 20 days/);

  const comfortable = budgetAdvice(facts({ spentMinor: 5_000_00, budgetMinor: 25_000_00 }));
  assert.equal(find(comfortable, 'pace')?.tone, 'ok');
  assert.match(find(comfortable, 'pace')!.text, /₹15,000\.00, about ₹10,000\.00 under/);

  const lastDay = budgetAdvice(facts({ dayOfPeriod: 30, daysLeft: 0, spentMinor: 28_000_00, budgetMinor: 25_000_00 }));
  assert.doesNotMatch(find(lastDay, 'over')!.text, /a day for the last/);
});

test('what is left is reduced by what is already committed', () => {

  const advice = budgetAdvice(
    facts({
      committed: [
        { counterparty: 'Landlord', amountMinor: 6_000_00, at: Date.now() },
        { counterparty: 'Airtel', amountMinor: 2_000_00, at: Date.now() },
      ],
    }),
  );
  const committed = find(advice, 'committed');
  assert.match(committed!.text, /₹8,000\.00 of regular payments still due this month \(Landlord and Airtel\)/);
  assert.match(committed!.text, /leaving ₹12,000\.00 genuinely free/);
});

test('committed payments larger than the remainder are called what they are', () => {
  const advice = budgetAdvice(
    facts({ spentMinor: 26_000_00, committed: [{ counterparty: 'Landlord', amountMinor: 6_000_00, at: Date.now() }] }),
  );
  const committed = find(advice, 'committed');
  assert.equal(committed?.tone, 'danger');
  assert.match(committed!.text, /more than the ₹4,000\.00 left in the budget/);
});

test('a finished month is not told what is still coming', () => {
  const advice = budgetAdvice(
    facts({
      current: false,
      daysLeft: 0,
      dayOfPeriod: 30,
      committed: [{ counterparty: 'Landlord', amountMinor: 6_000_00, at: Date.now() }],
    }),
  );
  assert.deepEqual(kinds(advice), []);
});

test('a comparison under fifteen percent is the same month twice', () => {
  const quiet = budgetAdvice(facts({ spentMinor: 10_000_00, previousToDateMinor: 9_500_00 }));
  assert.equal(find(quiet, 'trend'), undefined);

  const up = budgetAdvice(facts({ spentMinor: 10_000_00, previousToDateMinor: 6_000_00 }));
  assert.match(find(up, 'trend')!.text, /₹4,000\.00 more than the same point last month \(₹6,000\.00\)/);

  const down = budgetAdvice(facts({ spentMinor: 6_000_00, previousToDateMinor: 10_000_00 }));
  assert.match(find(down, 'trend')!.text, /₹4,000\.00 less than/);

  assert.equal(find(budgetAdvice(facts({ previousToDateMinor: 0 })), 'trend'), undefined);
});

test('concentration distinguishes one large purchase from a habit', () => {
  const single = budgetAdvice(
    facts({ topCategory: { name: 'Appliances', amountMinor: 6_000_00, sharePercent: 60, count: 1 } }),
  );
  assert.match(find(single, 'concentration')!.text, /₹6,000\.00 — 60% of the month — went to Appliances, in a single entry\./);

  const habit = budgetAdvice(
    facts({ topCategory: { name: 'Food', amountMinor: 6_000_00, sharePercent: 60, count: 22 } }),
  );
  assert.match(find(habit, 'concentration')!.text, /across 22 entries/);

  const spread = budgetAdvice(
    facts({ topCategory: { name: 'Food', amountMinor: 3_000_00, sharePercent: 30, count: 9 } }),
  );
  assert.equal(find(spread, 'concentration'), undefined);
});

test('guidance drawn from an incomplete total always admits it, even when crowded out', () => {
  const advice = budgetAdvice(
    facts({
      spentMinor: 34_000_00,
      committed: [{ counterparty: 'Landlord', amountMinor: 6_000_00, at: Date.now() }],
      topCategory: { name: 'Food', amountMinor: 20_000_00, sharePercent: 58, count: 12 },
      previousToDateMinor: 6_000_00,
      needsContextCount: 1,
      excludedRecordCount: 3,
    }),
  );

  assert.equal(advice.length, 4);
  assert.equal(advice.at(-1)!.kind, 'incomplete');
  assert.match(advice.at(-1)!.text, /1 entry needs one more detail, and 3 entries could not be counted\./);
});

test('the honesty line says what it is counting', () => {

  const one = budgetAdvice(facts({ excludedRecordCount: 1 }));
  assert.match(find(one, 'incomplete')!.text, /Not everything is in these figures: 1 entry could not be counted\./);

  const many = budgetAdvice(facts({ excludedRecordCount: 4 }));
  assert.match(find(many, 'incomplete')!.text, /4 entries could not be counted\./);

  const both = budgetAdvice(facts({ needsContextCount: 2, excludedRecordCount: 1 }));
  assert.match(find(both, 'incomplete')!.text, /2 entries need one more detail, and 1 entry could not be counted\./);
});

test('the projection floor is a single shared number', () => {

  assert.equal(MIN_DAYS_FOR_PACE, 4);
  const day = MIN_DAYS_FOR_PACE - 1;
  assert.equal(find(budgetAdvice(facts({ dayOfPeriod: day, daysLeft: 30 - day })), 'pace'), undefined);
  assert.ok(
    find(budgetAdvice(facts({ dayOfPeriod: MIN_DAYS_FOR_PACE, daysLeft: 30 - MIN_DAYS_FOR_PACE })), 'pace'),
  );
});

test('no currency is assumed and no budget is required', () => {
  const advice = budgetAdvice(
    facts({
      currency: 'USD',
      budgetMinor: null,
      spentMinor: 1_000_00,
      committed: [{ counterparty: 'Comcast', amountMinor: 80_00, at: Date.now() }],
    }),
  );
  for (const item of advice) assert.doesNotMatch(item.text, /₹/);

  assert.equal(find(advice, 'pace')?.tone, 'neutral');
  assert.match(find(advice, 'pace')!.text, /heading for about \$3,000\.00/);
  assert.doesNotMatch(find(advice, 'committed')!.text, /free|left in the budget/);
});

test('a long list of payees is summarised rather than recited', () => {
  const advice = budgetAdvice(
    facts({
      committed: [
        { counterparty: 'Landlord', amountMinor: 1_00, at: 1 },
        { counterparty: 'Airtel', amountMinor: 1_00, at: 2 },
        { counterparty: 'Netflix', amountMinor: 1_00, at: 3 },
        { counterparty: 'Gym', amountMinor: 1_00, at: 4 },
      ],
    }),
  );
  assert.match(find(advice, 'committed')!.text, /\(Landlord, Airtel and 2 more\)/);
});

test('a month with almost nothing in it is told so, not projected', () => {

  assert.equal(MIN_RECORDS_FOR_PACE, 5);
  const thin = facts({ dayOfPeriod: 21, daysLeft: 9, spentMinor: 40_000_00, budgetMinor: null, contributingRecordCount: 3 });
  const pace = find(budgetAdvice(thin), 'pace');
  assert.equal(pace?.tone, 'neutral');
  assert.equal(pace?.text, 'Only 3 entries so far — not enough to say where the month is heading.');
  assert.doesNotMatch(pace!.text, /₹/);
  assert.equal(projectionOf(thin), null);

  const enough = facts({ ...thin, contributingRecordCount: MIN_RECORDS_FOR_PACE });
  assert.match(find(budgetAdvice(enough), 'pace')!.text, /heading for about/);
  assert.equal(projectionOf(enough), 57_142_86);
});

test('a single entry reads as singular in the not-enough sentence', () => {
  const advice = budgetAdvice(facts({ dayOfPeriod: 21, daysLeft: 9, contributingRecordCount: 1 }));
  assert.match(find(advice, 'pace')!.text, /^Only 1 entry so far/);
});

test('a caller that does not count its records still gets a projection', () => {

  const advice = budgetAdvice(facts({ budgetMinor: null }));
  assert.match(find(advice, 'pace')!.text, /heading for about ₹30,000\.00/);
});

test('one large one-off does not become a monthly habit', () => {

  const wedding = facts({
    dayOfPeriod: 12,
    daysLeft: 18,
    spentMinor: 99_000_00,
    budgetMinor: null,
    contributingRecordCount: 24,
    largestEntry: { label: 'Tanishq', amountMinor: 85_000_00 },
  });
  assert.equal(projectionOf(wedding), null);
  const pace = find(budgetAdvice(wedding), 'pace');
  assert.equal(pace?.tone, 'neutral');
  assert.equal(
    pace?.text,
    '₹85,000.00 of this month is the one payment to Tanishq — too much of it for a daily pace to mean anything.',
  );

  const ordinary = facts({ ...wedding, largestEntry: { label: 'Tanishq', amountMinor: 40_000_00 } });
  assert.match(find(budgetAdvice(ordinary), 'pace')!.text, /heading for about/);
});

test('a month defined by one purchase says what it looks like without it', () => {

  const advice = budgetAdvice(
    facts({
      spentMinor: 20_000_00,
      topCategory: { name: 'Appliances', amountMinor: 14_000_00, sharePercent: 70, count: 1 },
    }),
  );
  assert.match(find(advice, 'concentration')!.text, /Without it the month is ₹6,000\.00\./);

  const habit = budgetAdvice(
    facts({
      spentMinor: 20_000_00,
      topCategory: { name: 'Food', amountMinor: 14_000_00, sharePercent: 70, count: 31 },
    }),
  );
  assert.doesNotMatch(find(habit, 'concentration')!.text, /Without it/);
});

test('a budget set mid-month does not pass judgement on the days before it', () => {
  const advice = budgetAdvice(facts({ spentMinor: 34_000_00, budgetSetOnDay: 20 }));
  const over = find(advice, 'over');
  assert.match(over!.text, /₹4,000\.00 over the ₹30,000\.00 budget/);
  assert.match(over!.text, /The budget was set on the 20th, so earlier days of the month are in that figure too\./);
});

test('a budget set on the first of the month needs no excuse', () => {
  for (const day of [undefined, null, 1]) {
    const advice = budgetAdvice(facts({ spentMinor: 34_000_00, budgetSetOnDay: day }));
    assert.doesNotMatch(find(advice, 'over')!.text, /budget was set on/, `day ${day}`);
  }
});

test('a first month of use invents no comparison and no forecast', () => {

  const advice = budgetAdvice(
    facts({
      budgetMinor: null,
      spentMinor: 1_200_00,
      dayOfPeriod: 2,
      daysLeft: 28,
      contributingRecordCount: 1,
      previousToDateMinor: null,
    }),
  );
  assert.deepEqual(kinds(advice), []);
});

test('a period with no days elapsed divides by nothing and says nothing', () => {

  for (const spent of [0, 5_000_00]) {
    const advice = budgetAdvice(facts({ dayOfPeriod: 0, daysLeft: 30, spentMinor: spent }));
    for (const line of advice) assert.doesNotMatch(line.text, /Infinity|NaN/);
    assert.equal(find(advice, 'pace'), undefined);
  }
  assert.equal(projectionOf(facts({ dayOfPeriod: 0, spentMinor: 5_000_00 })), null);
});

test('a refunded month does not report negative spending as progress', () => {

  const advice = budgetAdvice(facts({ spentMinor: -2_000_00 }));
  assert.equal(find(advice, 'pace'), undefined);
  assert.equal(projectionOf(facts({ spentMinor: -2_000_00 })), null);
});

const NOW = new Date(2026, 9, 2, 11, 0, 0).getTime();
const on = (year: number, month: number, day: number, hour = 10) =>
  new Date(year, month - 1, day, hour, 0, 0).getTime();

let counter = 0;
function spend(counterparty: string, amountMinor: number, at: number): RecurringRecord {
  counter += 1;
  return {
    id: `rec_${counter}`,
    kind: 'payment',
    occurredAt: at,
    amountMinor,
    currency: 'INR',
    direction: 'out',
    counterparty,
    status: 'complete',
  };
}

test('a brand-new account is warned about nothing at all', () => {

  const fresh = [
    spend('Big Bazaar', 2_400_00, on(2026, 9, 22)),
    spend('Airtel', 59_900, on(2026, 9, 25)),
    spend('Landlord', 28_000_00, on(2026, 10, 1)),
    spend('Swiggy', 48_000, on(2026, 10, 2)),
  ];
  assert.deepEqual(spendingAlerts(fresh, NOW), []);
});

test('two identical charges in one afternoon are shown without being called a mistake', () => {
  const records = [
    ...Array.from({ length: 10 }, (_, index) => spend('Ganesh Kirana', 30_000 + index * 1_000, on(2026, 8, index + 1))),
    spend('BigBasket', 1_299_00, on(2026, 10, 1, 9)),
    spend('BigBasket', 1_299_00, on(2026, 10, 1, 14)),
  ];
  const duplicate = spendingAlerts(records, NOW).find((alert) => alert.kind === 'possible-duplicate');
  assert.equal(duplicate?.text, 'Two payments of ₹1,299.00 to BigBasket within a day of each other.');
  assert.equal(duplicate?.recordIds.length, 2);

  assert.doesNotMatch(duplicate!.text, /twice|charged again|error|refund/i);
});

test('a payee who buys the same thing twice every day is not reported every day', () => {

  const chai: RecurringRecord[] = [];
  for (let day = 1; day <= 20; day += 1) {
    chai.push(spend('Amar Tea Stall', 2_000, on(2026, 9, day, 9)));
    chai.push(spend('Amar Tea Stall', 2_000, on(2026, 9, day, 17)));
  }
  assert.deepEqual(
    spendingAlerts(chai, NOW).filter((alert) => alert.kind === 'possible-duplicate'),
    [],
  );
});

test('a monthly subscription is not a duplicate of itself', () => {
  const netflix = Array.from({ length: 10 }, (_, index) => spend('Netflix', 64_900, on(2026, 1 + index, 7)));
  assert.deepEqual(
    spendingAlerts(netflix, NOW).filter((alert) => alert.kind === 'possible-duplicate'),
    [],
  );
});

test('every alert carries the records it was drawn from', () => {
  const history: RecurringRecord[] = [];
  for (let month = 3; month <= 9; month += 1) {
    history.push(spend('Tata Power', 1_40_000 + month * 1_000, on(2026, month, 8)));
    history.push(spend('Ganesh Kirana', 80_000 + month * 2_000, on(2026, month, 14)));
    history.push(spend('Airtel', 59_900, on(2026, month, 5)));
  }
  history.push(spend('Tata Power', 9_80_000, on(2026, 9, 8)));

  const alerts = spendingAlerts(history, NOW);
  assert.ok(alerts.length > 0);
  for (const alert of alerts) {
    assert.ok(alert.recordIds.length > 0, alert.text);

    for (const id of alert.recordIds) assert.ok(history.some((record) => record.id === id), id);

    assert.doesNotMatch(alert.text, /\d+%|undefined|null|NaN|Infinity|groq|model/i);
  }
});

test('no more than a handful of alerts is raised at once', () => {

  const noisy: RecurringRecord[] = [];
  for (let payee = 0; payee < 12; payee += 1) {
    for (let month = 3; month <= 9; month += 1) {
      noisy.push(spend(`Shop ${payee}`, 50_000 + month * 500, on(2026, month, 4 + payee)));
    }
    noisy.push(spend(`Shop ${payee}`, 9_00_000, on(2026, 9, 20)));
  }
  assert.ok(spendingAlerts(noisy, NOW).length <= 4);
});

test('one event is one alert, even when two detectors both describe it', () => {

  const history: RecurringRecord[] = [];
  for (let month = 7; month <= 9; month += 1) {
    history.push(spend('Airtel', 59_900, on(2026, month, 5)));
    history.push(spend('Tata Power', 1_40_000, on(2026, month, 8)));
    history.push(spend('Landlord', 28_000_00, on(2026, month, 1)));
    for (let visit = 0; visit < 5; visit += 1) {
      history.push(spend('Ganesh Kirana', 80_000 + visit * 9_000, on(2026, month, 10 + visit * 3)));
    }
  }
  const jeweller = spend('Tanishq', 85_000_00, on(2026, 9, 20));

  const alerts = spendingAlerts([...history, jeweller], NOW);
  const about = alerts.filter((alert) => alert.recordIds.includes(jeweller.id));
  assert.equal(about.length, 1);
  assert.equal(about[0]?.kind, 'new-payee');
});

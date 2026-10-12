import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareSides, extractFacts, type FactSource } from './facts.ts';
import { normalizeCurrency } from './money.ts';

function source(
  id: string,
  side: 'mine' | 'theirs',
  text: string,
  hasFile = true,
  origin: 'item' | 'claim' = 'item',
): FactSource {
  return { id, label: id, side, hasFile, origin, facts: extractFacts(text) };
}

function find(sources: FactSource[], kind: string) {
  return compareSides(sources).find((signal) => signal.kind === kind);
}

test('a ten-digit phone number is not a reference number', () => {
  const facts = extractFacts('Contact 9188004321 for queries. Paid Rs 4500.');
  assert.deepEqual(facts.references, []);
});

test('two documents sharing only a phone number do not claim the same transaction', () => {
  const signals = compareSides([
    source('mine', 'mine', 'Contact 9188004321. Paid Rs 4500 on 12/09/2026.'),
    source('theirs', 'theirs', 'Call 9188004321, I never got it. Due 4500 rupees.'),
  ]);
  assert.equal(
    signals.some((signal) => signal.kind === 'shared_reference'),
    false,
  );
});

test('a labelled reference on both sides is strong; an unlabelled digit run is not compared at all', () => {
  const labelled = find(
    [
      source('mine', 'mine', 'UTR: 462318905577 Total Rs 900'),
      source('theirs', 'theirs', 'Transaction ID 462318905577 Amount due Rs 900'),
    ],
    'shared_reference',
  );
  assert.equal(labelled?.strength, 'strong');

  const loose = find(
    [
      source('mine', 'mine', '501234567890123 Total Rs 900'),
      source('theirs', 'theirs', '501234567890123 Amount due Rs 900'),
    ],
    'shared_reference',
  );
  assert.equal(loose, undefined);
});

test('an unlabelled long number is never harvested, and a sensitive shape is refused even when labelled', () => {
  assert.deepEqual(extractFacts('Paid Rs 4500 to 234567890123 yesterday.').references, []);
  assert.deepEqual(extractFacts('Reference 4111111111111111 for Rs 900.').references, []);
  assert.deepEqual(extractFacts('Ref: 919188004321 credited Rs 900.').references, []);
  assert.deepEqual(
    extractFacts('UTR: 462318905577 Total Rs 900').references.map((entry) => entry.value),
    ['462318905577'],
  );
});

test('a typed account of the other side is opposing material, weighed below a document', () => {
  const claimed = compareSides([
    source('mine', 'mine', 'Total Rs 4500 paid on 10/09/2026'),
    source('theirs:their_claim', 'theirs', 'Amount due Rs 8200 and nothing arrived on 22/09/2026', false, 'claim'),
  ]);
  assert.equal(claimed.some((signal) => signal.kind === 'no_opposing_material'), false);
  assert.equal(claimed.find((signal) => signal.kind === 'amount_mismatch')?.strength, 'moderate');
  assert.ok(claimed.some((signal) => signal.kind === 'undocumented_claim'));
});

test('a subtotal is not treated as the total', () => {
  const facts = extractFacts('Subtotal Rs 120\nTax Rs 45\nTotal Rs 4500');
  const roles = new Map(facts.amounts.map((amount) => [amount.minor, amount.role]));
  assert.equal(roles.get(12_000), 'line');
  assert.equal(roles.get(450_000), 'total');
});

test('a mismatch compares the labelled totals, not the first figure in the document', () => {
  const signal = find(
    [
      source('mine', 'mine', 'Paneer 120\nRoti Rs 60\nTotal Rs 4500'),
      source('theirs', 'theirs', 'Subtotal Rs 120\nAmount due Rs 8200'),
    ],
    'amount_mismatch',
  );
  assert.equal(signal?.strength, 'strong');
  assert.match(signal?.headline ?? '', /4,500\.00.*8,200\.00/);
});

test('with no identifiable total on either side a mismatch is weak, not a contradiction', () => {
  const signal = find(
    [
      source('mine', 'mine', 'Rs 120 Rs 300 Rs 80'),
      source('theirs', 'theirs', 'Rs 260 Rs 999'),
    ],
    'amount_mismatch',
  );
  assert.equal(signal?.strength, 'weak');
});

test('a date conflict needs one unambiguous date on each side', () => {
  const single = find(
    [source('mine', 'mine', 'Paid 10/09/2026'), source('theirs', 'theirs', 'Owed as of 22/09/2026')],
    'date_conflict',
  );
  assert.equal(single?.strength, 'moderate');

  const many = find(
    [
      source('mine', 'mine', 'Issued 01/03/2026 revised 09/03/2026 sent 11/03/2026'),
      source('theirs', 'theirs', 'Period 01/07/2026 to 31/07/2026'),
    ],
    'date_conflict',
  );
  assert.equal(many?.strength, 'weak');
});

test('a due date is not read as an unpaid status', () => {
  const facts = extractFacts('Invoice paid 12/09/2026. Due date 15/09/2026.');
  assert.equal(facts.statuses.includes('due'), false);
  assert.equal(facts.statuses.includes('paid'), true);
});

test('a status conflict is only strong when neither side is mixed', () => {
  const clean = find(
    [source('mine', 'mine', 'Payment successful'), source('theirs', 'theirs', 'Payment pending')],
    'status_conflict',
  );
  assert.equal(clean?.strength, 'strong');

  const mixed = find(
    [source('mine', 'mine', 'Payment successful, delivery pending'), source('theirs', 'theirs', 'Payment pending')],
    'status_conflict',
  );
  assert.equal(mixed?.strength, 'weak');
});

test('the same finding across many items is reported once', () => {
  const signals = compareSides([
    source('m1', 'mine', 'Total Rs 500 paid 10/09/2026'),
    source('m2', 'mine', 'Total Rs 500 paid 10/09/2026'),
    source('m3', 'mine', 'Total Rs 500 paid 10/09/2026'),
    source('t1', 'theirs', 'Amount due Rs 700 on 22/09/2026', false),
    source('t2', 'theirs', 'Amount due Rs 700 on 22/09/2026', false),
  ]);
  const mismatches = signals.filter((signal) => signal.kind === 'amount_mismatch');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]?.itemIds.length, 5);
});

test('findings are ordered strongest first', () => {
  const rank = { weak: 0, moderate: 1, strong: 2 } as const;
  const signals = compareSides([
    source('mine', 'mine', 'UTR: 462318905577 Total Rs 4500 Status: Paid on 10/09/2026'),
    source('theirs', 'theirs', 'UTR: 462318905577 Amount due Rs 8200 Unpaid, 22/09/2026', false),
  ]);
  assert.ok(signals.length > 1);
  for (let index = 1; index < signals.length; index += 1) {
    assert.ok(rank[signals[index - 1]!.strength] >= rank[signals[index]!.strength]);
  }
});

test('an amount written in words still becomes an amount', () => {
  assert.equal(normalizeCurrency('rupees'), 'INR');
  const facts = extractFacts('He still owes me 4500 rupees.');
  assert.equal(facts.amounts[0]?.minor, 450_000);
  assert.equal(facts.amounts[0]?.currency, 'INR');
});

test('nothing on the other side is said plainly rather than treated as a win', () => {
  const signals = compareSides([source('mine', 'mine', 'Total Rs 4500 paid')]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.kind, 'no_opposing_material');
});

test('matching line items cannot hide different receipt totals', () => {
  const signals = compareSides([
    source('mine', 'mine', 'Item Rs 120\nTotal Rs 500'),
    source('theirs', 'theirs', 'Item Rs 120\nTotal Rs 900'),
  ]);
  assert.equal(signals.some((signal) => signal.kind === 'amount_agreement'), false);
  assert.equal(signals.find((signal) => signal.kind === 'amount_mismatch')?.strength, 'strong');
});

test('adjacent dates are not presented as the same day and invalid days disappear', () => {
  const signals = compareSides([
    source('mine', 'mine', 'Paid on 10/09/2026'),
    source('theirs', 'theirs', 'Paid on 11/09/2026'),
  ]);
  assert.equal(signals.some((signal) => signal.kind === 'date_agreement'), false);
  assert.ok(signals.some((signal) => signal.kind === 'date_conflict'));
  assert.deepEqual(extractFacts('2026-02-31 and 31 February 2026 and 31/02/2026').dates, []);
});

test('negated payment words and reversed sides retain their meaning', () => {
  assert.deepEqual(extractFacts('I have not paid and never received it.').statuses, ['unpaid', 'not received']);
  const signal = find([
    source('mine', 'mine', 'Payment unpaid'),
    source('theirs', 'theirs', 'Payment successful'),
  ], 'status_conflict');
  assert.equal(signal?.strength, 'strong');
});

test('a side that rests on nothing but its own words is told so', () => {
  const unproven = find(
    [
      source('mine', 'mine', 'I paid Rs 4500 in cash on 05/09/2026.', false),
      source('theirs', 'theirs', 'Nothing was received.', false),
    ],
    'your_side_unproven',
  );
  assert.ok(unproven, 'an account with nothing uploaded behind it must be reported');
  assert.match(unproven.detail, /uploaded/i);
  assert.deepEqual(unproven.itemIds, ['mine']);

  assert.equal(
    find(
      [
        source('mine', 'mine', 'Receipt: Total Rs 4500 paid on 05/09/2026.'),
        source('theirs', 'theirs', 'Nothing was received.', false),
      ],
      'your_side_unproven',
    ),
    undefined,
  );
});

test('a file that says a payment happened without showing it is weaker than one that shows it', () => {
  const thin = find(
    [
      source('mine', 'mine', 'The shop confirmed it was paid.'),
      source('theirs', 'theirs', 'Nothing was received.', false),
    ],
    'your_side_unproven',
  );
  assert.equal(thin?.strength, 'weak');
  assert.match(thin?.detail ?? '', /no amount and no reference number/);
});

test('facts say when a piece held more than is kept, and stay silent when nothing was cut', () => {
  const bill = Array.from({ length: 15 }, (_, index) => `Line ${index + 1}: Rs ${201 + index}`).join('\n');
  const facts = extractFacts(bill);
  assert.equal(facts.amounts.length, 12);
  assert.deepEqual(facts.partial, ['amounts']);

  assert.equal(extractFacts('Paid Rs 4500 on 05/09/2026.').partial, undefined);
});

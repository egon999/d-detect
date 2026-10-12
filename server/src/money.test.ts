import assert from 'node:assert/strict';
import { test } from 'node:test';

import { directionOf, toAsciiDigits, toEpoch, toMinorUnits, normalizeCurrency } from './money.ts';

test('money accepts Indian and international grouping without merging separate figures', () => {
  assert.equal(toMinorUnits('₹1,23,456.78', 'INR'), 12_345_678);
  assert.equal(toMinorUnits('1.234,56 EUR', 'EUR'), 123_456);
  assert.equal(toMinorUnits('4500 rupees', 'INR'), 450_000);
  for (const value of ['50 and 70', '50 70', '1,2,3', '1.2.3', '1e3', '12.345']) {
    assert.equal(toMinorUnits(value, 'INR'), null, value);
  }
  assert.equal(toMinorUnits('$50', 'INR'), null);
  assert.equal(normalizeCurrency('ABC'), null);
});

test('currency precision never silently discards meaningful money', () => {
  assert.equal(toMinorUnits('125.5', 'JPY'), null);
  assert.equal(toMinorUnits('125.00', 'JPY'), 125);
  assert.equal(toMinorUnits('1.234', 'KWD'), 1234);
  assert.equal(toMinorUnits('9999999999999999', 'INR'), null);
});

test('dates reject impossible days and preserve day-first input and precision', () => {
  for (const date of ['31/02/2026', '2026-02-29', '31 February 2026', '2026-13-01', '2026-01-01T25:00', 'next Tuesday']) {
    assert.equal(toEpoch(date, null).at, null, date);
  }
  const date = toEpoch('04/09/2026', null);
  assert.equal(new Date(date.at!).getMonth(), 8);
  assert.equal(new Date(date.at!).getDate(), 4);
  assert.equal(toEpoch('2024-02-29', null).precision, 'day');
  assert.equal(toEpoch('2026-09', null).precision, 'month');
  assert.equal(toEpoch('2026', null).precision, 'year');
  assert.equal(toEpoch('2026-09-26T15:00:00+05:30', null).at, Date.parse('2026-09-26T09:30:00Z'));
});

test('money reads a figure the way an Indian bill actually prints it', () => {

  assert.equal(toMinorUnits('1,14,450', 'INR'), 11_445_000);
  assert.equal(toMinorUnits('23,400', 'INR'), 2_340_000);
  assert.equal(toMinorUnits('4,500.00', 'INR'), 450_000);
  assert.equal(toMinorUnits('1,144.50', 'INR'), 114_450);

  assert.equal(toMinorUnits('Rs 4,500', 'INR'), 450_000);
  assert.equal(toMinorUnits('Rs. 4,500', 'INR'), 450_000);
  assert.equal(toMinorUnits('INR 4,500', 'INR'), 450_000);
  assert.equal(toMinorUnits('₹4,500', 'INR'), 450_000);
  assert.equal(toMinorUnits('₨ 4,500', 'INR'), 450_000);

  assert.equal(toMinorUnits('4,500/-', 'INR'), 450_000);
  assert.equal(toMinorUnits('Rs 4,500/=', 'INR'), 450_000);
  assert.equal(toMinorUnits('4500 only', 'INR'), 450_000);

  assert.equal(toMinorUnits('1,250.50 Dr', 'INR'), 125_050);
  assert.equal(toMinorUnits('1,250.50 Cr.', 'INR'), 125_050);

  assert.equal(toAsciiDigits('४,५००.००'), '4,500.00');
  assert.equal(toMinorUnits('४,५००.००', 'INR'), 450_000);
  assert.equal(toMinorUnits('₹१,१४,४५०', 'INR'), 11_445_000);
  assert.equal(toMinorUnits('௧௨௩', 'INR'), 12_300);
  assert.equal(toAsciiDigits('plain 123'), 'plain 123');

  assert.equal(toMinorUnits('-1,250.50', 'INR'), -125_050);
  assert.equal(toMinorUnits('(1,250.50)', 'INR'), -125_050);
  assert.equal(toMinorUnits('(-1,250.50)', 'INR'), 125_050);
  assert.equal(toMinorUnits('+1,250.50', 'INR'), 125_050);

  for (const value of ['$4,500', '4,500 USD', '4500 dollars', '4,500 x 2', '4,500 and 70']) {
    assert.equal(toMinorUnits(value, 'INR'), null, value);
  }
});

test('dates read the clock and the calendar as the source printed them', () => {

  const bill = toEpoch('29/09/2026 20:15', null);
  assert.equal(bill.precision, 'minute');
  assert.equal(new Date(bill.at!).getHours(), 20);
  assert.equal(new Date(bill.at!).getMinutes(), 15);
  assert.equal(new Date(bill.at!).getDate(), 29);
  assert.equal(new Date(bill.at!).getMonth(), 8);

  const upi = toEpoch('28 Sep 2026, 7:42 PM', null);
  assert.equal(upi.precision, 'minute');
  assert.equal(new Date(upi.at!).getHours(), 19);
  assert.equal(new Date(upi.at!).getMinutes(), 42);
  assert.equal(new Date(upi.at!).getDate(), 28);

  assert.equal(new Date(toEpoch('05/09/2026, 12:30 am', null).at!).getHours(), 0);
  assert.equal(new Date(toEpoch('05/09/2026, 12:30 pm', null).at!).getHours(), 12);
  assert.equal(new Date(toEpoch('05/09/2026 at 2.32 p.m.', null).at!).getHours(), 14);

  for (const written of ['29/09/2026', '29-09-2026', '29.09.2026', '29/9/26', '29 September 2026', '29th Sept 2026']) {
    const read = toEpoch(written, null);
    assert.equal(new Date(read.at!).getDate(), 29, written);
    assert.equal(new Date(read.at!).getMonth(), 8, written);
    assert.equal(new Date(read.at!).getFullYear(), 2026, written);
    assert.equal(read.precision, 'day', written);
  }

  assert.equal(new Date(toEpoch('09/29/2026', null).at!).getDate(), 29);
  assert.equal(new Date(toEpoch('09/29/2026', null).at!).getMonth(), 8);
  assert.equal(new Date(toEpoch('Sep 29, 2026', null).at!).getDate(), 29);

  const hindi = toEpoch('२९ सितंबर २०२६', null);
  assert.equal(new Date(hindi.at!).getDate(), 29);
  assert.equal(new Date(hindi.at!).getMonth(), 8);
  assert.equal(new Date(toEpoch('29 सितम्बर 2026', null).at!).getMonth(), 8);
  assert.equal(new Date(toEpoch('1 दिसंबर 2026', null).at!).getMonth(), 11);

  assert.equal(new Date(toEpoch('29/09/26', null).at!).getFullYear(), 2026);
  assert.equal(new Date(toEpoch('29/09/99', null).at!).getFullYear(), 1999);

  assert.equal(toEpoch('29/09/2026 20:15', 'day').precision, 'day');
  assert.equal(toEpoch('29/09/2026', 'minute').precision, 'day');

  for (const written of ['29/09/2026 25:15', '29/09/2026 20:75', '29/09/2026 13:15 pm', '29/13/2026', '32/09/2026']) {
    assert.equal(toEpoch(written, null).at, null, written);
  }
});

test('dates handle relative conversational dates', () => {
  const today = toEpoch('today', null);
  assert.equal(today.precision, 'day');
  assert.ok(today.at);
  const aaj = toEpoch('aaj', null);
  assert.equal(aaj.at, today.at);

  const yesterday = toEpoch('yesterday', null);
  assert.equal(yesterday.precision, 'day');
  assert.ok(yesterday.at);
  const kal = toEpoch('kal', null);
  assert.equal(kal.at, yesterday.at);
  assert.ok(today.at! > yesterday.at!);
});

test('a scale word scales the figure instead of being read as rupees', () => {

  const cases: Array<[string, string, number]> = [
    ['1.5 lakh', 'INR', 15_000_000],
    ['1.5 Lakh', 'INR', 15_000_000],
    ['2 Cr', 'INR', 2_000_000_000],
    ['2 cr', 'INR', 2_000_000_000],
    ['2 crore', 'INR', 2_000_000_000],
    ['12 lakh', 'INR', 120_000_000],
    ['75 thousand', 'INR', 7_500_000],
    ['1,50,000', 'INR', 15_000_000],
    ['₹1.5 lakh', 'INR', 15_000_000],
    ['Rs 2.25 crore', 'INR', 2_250_000_000],
    ['1.50 lakh', 'INR', 15_000_000],
    ['2 लाख', 'INR', 20_000_000],
    ['3 करोड़', 'INR', 3_000_000_000],
    ['1.5 million', 'USD', 150_000_000],
    ['1.5 million dollars', 'USD', 150_000_000],
    ['USD 1.5 million', 'USD', 150_000_000],
  ];
  for (const [written, currency, minor] of cases) {
    assert.equal(toMinorUnits(written, currency), minor, written);
  }

  for (const nonsense of ['2 crore x 3', '1.5 lakhs and 30', '2 cr each', '1.5 lakh extra']) {
    assert.equal(toMinorUnits(nonsense, 'INR'), null, nonsense);
  }

  assert.equal(toMinorUnits('2 crore USD', 'INR'), null);
  assert.equal(toMinorUnits('1.5 lakh dollars', 'INR'), null);
});

test('Cr beside a statement figure is a credit column, not a crore', () => {

  assert.equal(toMinorUnits('1,250.50 Cr', 'INR'), 125_050);
  assert.equal(toMinorUnits('1,250.50 Cr.', 'INR'), 125_050);
  assert.equal(toMinorUnits('12.00 Cr', 'INR'), 1_200);
  assert.equal(toMinorUnits('4,500 Cr', 'INR'), 450_000);

  assert.equal(toMinorUnits('2 Cr', 'INR'), 2_000_000_000);
});

test('an amount written out in words is an amount', () => {
  const cases: Array<[string, string, number]> = [
    ['Four Thousand Five Hundred Only', 'INR', 450_000],
    ['Rupees Four Thousand Five Hundred Only', 'INR', 450_000],
    ['one lakh twenty thousand', 'INR', 12_000_000],
    ['One Lakh Fifty Thousand Rupees', 'INR', 15_000_000],
    ['two crore fifty lakh', 'INR', 2_500_000_000],
    ['Rupees Twenty Only', 'INR', 2_000],
    ['RUPEES NINE HUNDRED NINETY NINE ONLY', 'INR', 99_900],
    ['Five Hundred', 'INR', 50_000],
    ['Rupees Four Thousand Five Hundred and Fifty Paise Only', 'INR', 450_050],
    ['Twenty Five Paise', 'INR', 25],
    ['One Thousand Rupees', 'INR', 100_000],
    ['fifty rupees', 'INR', 5_000],
    ['Four Thousand Dollars', 'USD', 400_000],
  ];
  for (const [written, currency, minor] of cases) {
    assert.equal(toMinorUnits(written, currency), minor, written);
  }

  for (const nonsense of [
    'paid to four friends', 'one of the two', 'four thousand x 3',
    'four hundred rupees and more', 'many rupees', 'hundred',
  ]) {
    assert.equal(toMinorUnits(nonsense, 'INR'), null, nonsense);
  }
  assert.equal(toMinorUnits('Four Thousand Dollars', 'INR'), null);
});

test('money reads both digit scripts and refuses to round what it cannot express', () => {

  assert.equal(toMinorUnits('₹४,५००.००', 'INR'), 450_000);
  assert.equal(toMinorUnits('४५००', 'INR'), 450_000);
  assert.equal(toAsciiDigits('०१२३४५६७८९'), '0123456789');
  assert.equal(toAsciiDigits('১२৩৪৫৬৭৮৯০'), '1234567890');

  assert.equal(toMinorUnits('125.5', 'JPY'), null);
  assert.equal(toMinorUnits('125.50', 'JPY'), null);
  assert.equal(toMinorUnits('125.00', 'JPY'), 125);
  assert.equal(toMinorUnits('1.2345', 'INR'), null);
  assert.equal(toMinorUnits('1.2300', 'INR'), 123);
  assert.equal(toMinorUnits('1.525 lakh', 'INR'), 15_250_000);
});

test('direction comes from the document\'s own words, and is null when they disagree', () => {
  const out = [
    'Your account has been debited by Rs 4,500.00',
    'Sent to Sharma Traders',
    'Paid to SHARMA KIRANA STORE',
    'You paid ₹1,250.50 to Swiggy',
    'Withdrawn from ATM',
    '1,250.50 Dr',
    'Dr 1,250.50',
    '₹500.00 debited from your account',
    'आपके खाते से ₹५०० डेबिट हुए',
  ];
  for (const text of out) assert.equal(directionOf(text), 'out', text);

  const into = [
    'Your account has been credited with Rs 45,000.00',
    'Received from Ramesh Kumar',
    'Refund of ₹499.00 processed',
    '1,250.50 Cr',
    'Cr 1,250.50',
    'Amount deposited',
    '₹४५,००० जमा हुए',
  ];
  for (const text of into) assert.equal(directionOf(text), 'in', text);

  assert.equal(directionOf('Rs 500 debited from your account and credited to the beneficiary'), null);
  assert.equal(directionOf('Invoice INV-4471 for the period 01/09/2026 to 30/09/2026'), null);
  assert.equal(directionOf(null), null);
  assert.equal(directionOf(''), null);

  assert.equal(directionOf('Consultation with Dr. Sharma, Cardiology'), null);
});

test('a date that names only a month or a year keeps that precision and does not gain a day', () => {

  for (const written of ['March 2026', 'Mar 2026', 'मार्च 2026', '03/2026', '3-2026', '2026-03']) {
    const read = toEpoch(written, null);
    assert.equal(read.precision, 'month', written);
    assert.equal(new Date(read.at!).getMonth(), 2, written);
    assert.equal(new Date(read.at!).getFullYear(), 2026, written);
  }
  assert.equal(toEpoch('2026', null).precision, 'year');
  assert.equal(toEpoch('2026-03-14', null).precision, 'day');

  assert.equal(toEpoch('March 2026', 'month').precision, 'month');
  assert.equal(toEpoch('March 2026', 'year').precision, 'year');
  assert.equal(toEpoch('March 2026', 'day').precision, 'month');
});

test('every printed date and clock a bill or a screenshot uses is read the same way', () => {
  const cases: Array<[string, number, number, number]> = [
    ['14/03/2026', 2026, 2, 14],
    ['14-03-2026', 2026, 2, 14],
    ['14.03.2026', 2026, 2, 14],
    ['14 Mar 2026', 2026, 2, 14],
    ['14th March 2026', 2026, 2, 14],
    ['14th Mar 2026', 2026, 2, 14],
    ['14 March 2026', 2026, 2, 14],
    ['2026-03-14', 2026, 2, 14],
    ['2026/03/14', 2026, 2, 14],
    ['14/3/26', 2026, 2, 14],
  ];
  for (const [written, year, month, day] of cases) {
    const read = toEpoch(written, null);
    const at = new Date(read.at!);
    assert.equal(at.getFullYear(), year, written);
    assert.equal(at.getMonth(), month, written);
    assert.equal(at.getDate(), day, written);
  }

  const clocks: Array<[string, number, number]> = [
    ['14/03/2026 02:45 PM', 14, 45],
    ['14/03/2026 14:12', 14, 12],
    ['14/03/2026 2:45pm', 14, 45],
    ['14/03/2026, 2.45 p.m.', 14, 45],
    ['14 Mar 2026 9:05 AM', 9, 5],
    ['14/03/2026 23:59', 23, 59],
    ['14/03/2026 12:05 am', 0, 5],
    ['14/03/2026 12:05 pm', 12, 5],
  ];
  for (const [written, hour, minute] of clocks) {
    const read = toEpoch(written, null);
    assert.equal(read.precision, 'minute', written);
    assert.equal(new Date(read.at!).getHours(), hour, written);
    assert.equal(new Date(read.at!).getMinutes(), minute, written);
  }
});

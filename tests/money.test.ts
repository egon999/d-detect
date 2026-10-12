/**
 * The money screen's pure logic.
 *
 * Everything the two money screens decide for themselves — what a typed budget amount means,
 * which month to open on, which months the switcher may offer, and the order a breakdown
 * reads in — lives in `src/api/insights.ts` as plain functions, so it can be tested here
 * without rendering a screen or mocking a native module.
 *
 * The budget tests are the ones that matter most. A budget is a figure somebody typed about
 * their own money; it has to come back out of storage as exactly what they typed, and the
 * only way to guarantee that is to keep it away from floating point and prove it.
 */

import { describe, expect, it } from 'vitest';

import {
  alertLook,
  alertsHeading,
  budgetAmountText,
  currencyDecimals,
  drillDownLoadProblem,
  excludedReasonSheet,
  fallbackPeriodKey,
  hiddenEntryCount,
  monthKeyOf,
  monthLabelOf,
  orderedCategories,
  periodChoices,
  readBudgetAmount,
  showableAlerts,
  spendingGuidance,
  UNCATEGORISED_LABEL,
  UNCATEGORISED_NAME,
  type AvailablePeriod,
  type BudgetGuidance,
  type ExclusionReason,
  type AlertKind,
  type SpendingAlert,
} from '../src/api/insights';

describe('readBudgetAmount', () => {
  it('accepts a grouped figure and keeps the grouping as typed', () => {
    const amount = readBudgetAmount('30,000', 2);
    expect(amount.status).toBe('ok');
    if (amount.status !== 'ok') return;
    expect(amount.text).toBe('30,000');
    expect(amount.decimal).toBe('30000.00');
    expect(amount.minorUnits).toBe(3000000);
  });

  it('groups digits the Indian way as the number is typed', () => {
    const steps = ['3', '30', '300', '3000', '30000', '300000', '3000000'];
    const shown = steps.map((step) => readBudgetAmount(step, 2).text);
    expect(shown).toEqual(['3', '30', '300', '3,000', '30,000', '3,00,000', '30,00,000']);
  });

  /*
   * The reason this module exists. `19.99 * 100` is 1998.9999999999998, so an amount read
   * through a float is a paisa short the moment anything truncates it — invisible until a
   * figure elsewhere is wrong by a rupee.
   */
  it('reads paise exactly, where multiplying by 100 would not', () => {
    const amount = readBudgetAmount('1,16,000.70', 2);
    expect(amount.status).toBe('ok');
    if (amount.status !== 'ok') return;
    expect(amount.minorUnits).toBe(11600070);
    expect(amount.decimal).toBe('116000.70');

    const drifts = readBudgetAmount('19.99', 2);
    expect(drifts.status).toBe('ok');
    if (drifts.status !== 'ok') return;
    expect(drifts.minorUnits).toBe(1999);
    expect(Math.trunc(19.99 * 100)).toBe(1998);
  });

  it('keeps a half-typed decimal usable', () => {
    expect(readBudgetAmount('30000.', 2).text).toBe('30,000.');
    expect(readBudgetAmount('30000.', 2).status).toBe('ok');
    expect(readBudgetAmount('30000.5', 2)).toMatchObject({
      status: 'ok',
      text: '30,000.5',
      decimal: '30000.50',
      minorUnits: 3000050,
    });
  });

  it('starts a leading point at zero and drops leading zeros', () => {
    expect(readBudgetAmount('.5', 2)).toMatchObject({ status: 'ok', text: '0.5', minorUnits: 50 });
    expect(readBudgetAmount('007', 2)).toMatchObject({ status: 'ok', text: '7', minorUnits: 700 });
  });

  it('refuses a pasted phrase rather than salvaging digits from it', () => {
    // "around 30k" stripped down to its digits would become a budget of ₹30.
    expect(readBudgetAmount('around 30k', 2).status).toBe('unreadable');
    expect(readBudgetAmount('50 and 70', 2).status).toBe('unreadable');
    expect(readBudgetAmount('₹30,000', 2).status).toBe('unreadable');
    expect(readBudgetAmount('30.00.5', 2).status).toBe('unreadable');
    expect(readBudgetAmount('-500', 2).status).toBe('unreadable');
    expect(readBudgetAmount('.', 2).status).toBe('unreadable');
  });

  it('names each thing that is wrong, so the field can say which', () => {
    expect(readBudgetAmount('', 2).status).toBe('empty');
    expect(readBudgetAmount('   ', 2).status).toBe('empty');
    expect(readBudgetAmount('30.005', 2).status).toBe('tooPrecise');
    expect(readBudgetAmount('0', 2).status).toBe('notPositive');
    expect(readBudgetAmount('0.00', 2).status).toBe('notPositive');
    expect(readBudgetAmount('1234567890123', 2).status).toBe('tooLarge');
  });

  it('follows the currency when it has no decimal places', () => {
    expect(readBudgetAmount('30000', 0)).toMatchObject({
      status: 'ok',
      text: '30,000',
      decimal: '30000',
      minorUnits: 30000,
    });
    expect(readBudgetAmount('30.5', 0).status).toBe('tooPrecise');
  });

  it('shows an unreadable entry back as typed, so it can be corrected', () => {
    expect(readBudgetAmount('  30k  ', 2).text).toBe('30k');
  });
});

describe('budgetAmountText', () => {
  it('writes a stored amount back as editable text', () => {
    expect(budgetAmountText(3000000, 2)).toBe('30,000');
    expect(budgetAmountText(11600070, 2)).toBe('1,16,000.70');
    expect(budgetAmountText(50, 2)).toBe('0.50');
    expect(budgetAmountText(30000, 0)).toBe('30,000');
  });

  it('round-trips through the reader without losing a paisa', () => {
    for (const minor of [1, 50, 3000000, 11600070, 999999999999]) {
      const text = budgetAmountText(minor, 2);
      const read = readBudgetAmount(text, 2);
      expect(read.status).toBe('ok');
      if (read.status === 'ok') expect(read.minorUnits).toBe(minor);
    }
  });
});

describe('currencyDecimals', () => {
  it('takes the places from the currency, and two when there is nothing to go on', () => {
    expect(currencyDecimals('INR')).toBe(2);
    expect(currencyDecimals('JPY')).toBe(0);
    expect(currencyDecimals(null)).toBe(2);
    // A code the platform has never heard of must not throw inside a keystroke handler.
    expect(currencyDecimals('NOTACURRENCY')).toBe(2);
  });
});

describe('fallbackPeriodKey', () => {
  const available: AvailablePeriod[] = [
    { key: '2025-08', label: 'August 2025', hasData: true },
    { key: '2025-09', label: 'September 2025', hasData: true },
    { key: '2025-11', label: 'November 2025', hasData: true },
  ];

  it('moves off an empty current month to the most recent one with anything in it', () => {
    const period = { key: '2025-10', isCurrent: true, hasData: false };
    expect(fallbackPeriodKey(period, available)).toBe('2025-09');
  });

  it('never moves forward into a month that has not happened', () => {
    const period = { key: '2025-10', isCurrent: true, hasData: false };
    const laterOnly: AvailablePeriod[] = [{ key: '2025-11', label: 'November 2025', hasData: true }];
    expect(fallbackPeriodKey(period, laterOnly)).toBeNull();
  });

  it('stays put on a brand-new account with no history at all', () => {
    expect(fallbackPeriodKey({ key: '2025-10', isCurrent: true, hasData: false }, [])).toBeNull();
  });

  it('leaves a month alone once it has something in it', () => {
    expect(fallbackPeriodKey({ key: '2025-10', isCurrent: true, hasData: true }, available)).toBeNull();
  });

  /** Somebody who taps August gets August, empty or not. */
  it('does not redirect a past month that was asked for', () => {
    expect(fallbackPeriodKey({ key: '2025-07', isCurrent: false, hasData: false }, available)).toBeNull();
  });

  it('ignores months listed with nothing in them', () => {
    const thin: AvailablePeriod[] = [
      { key: '2025-09', label: 'September 2025', hasData: false },
      { key: '2025-08', label: 'August 2025', hasData: true },
    ];
    expect(fallbackPeriodKey({ key: '2025-10', isCurrent: true, hasData: false }, thin)).toBe('2025-08');
  });
});

describe('periodChoices', () => {
  const available: AvailablePeriod[] = [
    { key: '2025-09', label: 'September 2025', hasData: true },
    { key: '2025-08', label: 'August 2025', hasData: true },
  ];

  it('offers the months with data plus the month we are living in, newest first', () => {
    const choices = periodChoices({ key: '2025-09', label: 'September 2025' }, available, '2025-10');
    expect(choices.map((choice) => choice.key)).toEqual(['2025-10', '2025-09', '2025-08']);
    expect(choices[0]).toMatchObject({ hasData: false, isCurrent: true });
    expect(choices[1]).toMatchObject({ hasData: true, isCurrent: false });
  });

  it('does not list the current month twice when it already has figures', () => {
    const withCurrent = [{ key: '2025-10', label: 'October 2025', hasData: true }, ...available];
    const choices = periodChoices({ key: '2025-10', label: 'October 2025' }, withCurrent, '2025-10');
    expect(choices.map((choice) => choice.key)).toEqual(['2025-10', '2025-09', '2025-08']);
    expect(choices[0]).toMatchObject({ hasData: true, isCurrent: true });
  });

  it('prefers the label the server wrote for the month on screen', () => {
    const choices = periodChoices({ key: '2025-07', label: 'July 2025' }, available, '2025-10');
    expect(choices.find((choice) => choice.key === '2025-07')?.label).toBe('July 2025');
  });

  it('drops anything that is not a month', () => {
    const junk: AvailablePeriod[] = [
      { key: '2025-13', label: 'Thirteenth 2025', hasData: true },
      { key: 'last-month', label: 'Last month', hasData: true },
      { key: '2025-09', label: 'September 2025', hasData: true },
    ];
    const choices = periodChoices({ key: '2025-09', label: 'September 2025' }, junk, '2025-10');
    expect(choices.map((choice) => choice.key)).toEqual(['2025-10', '2025-09']);
  });
});

describe('orderedCategories', () => {
  it('puts the biggest first and the unlabelled remainder last, however large', () => {
    const rows = orderedCategories([
      { name: 'Groceries', amountMinor: 450000 },
      { name: UNCATEGORISED_NAME, amountMinor: 900000 },
      { name: 'Rent', amountMinor: 800000 },
    ]);
    expect(rows.map((row) => row.displayName)).toEqual(['Rent', 'Groceries', UNCATEGORISED_LABEL]);
    expect(rows[2]?.unlabelled).toBe(true);
    expect(rows[0]?.unlabelled).toBe(false);
  });

  it('breaks a tie on the name, so the order does not shuffle between loads', () => {
    const rows = orderedCategories([
      { name: 'Travel', amountMinor: 100000 },
      { name: 'Bills', amountMinor: 100000 },
    ]);
    expect(rows.map((row) => row.name)).toEqual(['Bills', 'Travel']);
  });

  it('carries the caller’s own fields through, so both money screens can share it', () => {
    const rows = orderedCategories([
      { name: 'Rent', amountMinor: 800000, label: '₹8,000', percent: 64 },
      { name: 'Bills', amountMinor: 200000, label: '₹2,000', percent: 16 },
    ]);
    expect(rows[0]).toMatchObject({ name: 'Rent', label: '₹8,000', percent: 64, unlabelled: false });
  });

  it('is unbothered by nothing to order', () => {
    expect(orderedCategories([])).toEqual([]);
  });
});

describe('spendingGuidance', () => {
  it('drops the incomplete-figures line, which the screen says in its own words', () => {
    const guidance: BudgetGuidance[] = [
      { kind: 'pace', tone: 'warn', text: 'At ₹1,200 a day the month lands near ₹36,000.' },
      { kind: 'incomplete', tone: 'neutral', text: 'Not everything is in these figures: 2 entries.' },
      { kind: 'trend', tone: 'neutral', text: '₹2,000 more than the same point last month.' },
    ];
    expect(spendingGuidance(guidance).map((line) => line.kind)).toEqual(['pace', 'trend']);
  });

  it('survives a response with no guidance in it', () => {
    expect(spendingGuidance([])).toEqual([]);
  });
});

describe('month keys', () => {
  it('keys a date by its own month, zero-padded', () => {
    expect(monthKeyOf(new Date(2025, 8, 28))).toBe('2025-09');
    expect(monthKeyOf(new Date(2026, 0, 1))).toBe('2026-01');
  });

  it('writes a month out for a reader, and hands back anything it cannot read', () => {
    const label = monthLabelOf('2025-09');
    expect(label).not.toBe('2025-09');
    expect(label).toContain('2025');
    expect(monthLabelOf('not-a-month')).toBe('not-a-month');
  });
});

/*
 * The drill-down behind a figure.
 *
 * Three different numbers can disagree about how long the list behind a total really is — the
 * server's count of the whole tally, the handful of ids it ships, and the rows the sheet
 * actually got back — and only one of them is true on screen. These tests pin the one that is.
 */
describe('hiddenEntryCount', () => {
  it('counts what is missing from the rows on screen, not from the ids that were asked for', () => {
    // Eight entries in the tally, eight ids shipped, one deleted since: seven rows, one more.
    expect(hiddenEntryCount(8, 7)).toBe(1);
    expect(hiddenEntryCount(48, 8)).toBe(40);
  });

  it('says nothing is missing when the sheet has everything', () => {
    expect(hiddenEntryCount(4, 4)).toBe(0);
    expect(hiddenEntryCount(0, 0)).toBe(0);
  });

  it('claims nothing while the rows are still loading', () => {
    // A count of what is absent from a list that has not arrived is a figure about nothing.
    expect(hiddenEntryCount(40, null)).toBe(0);
  });

  it('never reports a negative remainder', () => {
    // More rows than the count would mean the server undercounted; "and -2 more" is worse.
    expect(hiddenEntryCount(2, 5)).toBe(0);
    expect(hiddenEntryCount(Number.NaN, 3)).toBe(0);
  });
});

describe('excludedReasonSheet', () => {
  const reasons: ExclusionReason[] = ['missingCurrency', 'otherCurrency', 'unreadable'];

  it('gives each reason its own heading and its own sentence', () => {
    const copy = reasons.map((reason) => excludedReasonSheet(reason, 3));
    expect(new Set(copy.map((entry) => entry.title)).size).toBe(3);
    expect(new Set(copy.map((entry) => entry.reason)).size).toBe(3);
  });

  it('states how many entries are behind the reason, in the person’s own grammar', () => {
    expect(excludedReasonSheet('unreadable', 1).reason).toContain('1 entry.');
    expect(excludedReasonSheet('unreadable', 4).reason).toContain('4 entries.');
  });

  it('tells the person what to do about a missing currency, because it is theirs to fix', () => {
    const copy = excludedReasonSheet('missingCurrency', 2);
    expect(copy.reason).toMatch(/set the currency/i);
  });

  it('tells the person a second currency needs no fixing, and does not send them to edit it', () => {
    // The record is right. A sheet that implies otherwise sends somebody to "correct" a
    // receipt that was read correctly, and the edit they make is the thing that breaks it.
    const copy = excludedReasonSheet('otherCurrency', 2);
    expect(copy.reason).toMatch(/nothing needs fixing/i);
    expect(copy.reason).not.toMatch(/open|set the currency|try again|edit/i);
  });

  it('offers a re-read for an unreadable record, never another photograph', () => {
    // POST /api/daybook/records/:id/retry re-reads bytes the server already holds, so asking
    // for the receipt again is asking for something that is not needed and may be gone.
    const copy = excludedReasonSheet('unreadable', 1);
    expect(copy.reason).toMatch(/read again/i);
    expect(copy.reason).not.toMatch(/upload|photo|take it again|scan it again/i);
  });

  it('puts no amount in any of the three sentences', () => {
    /*
     * Several of these records have an amount with no currency attached, so a total over them
     * would be a figure in no currency — a number the product invented. There is no sum here
     * to print, and the test exists so that nobody adds one back as a convenience.
     */
    for (const reason of reasons) {
      for (const count of [1, 7]) {
        const copy = excludedReasonSheet(reason, count);
        const withoutCount = copy.reason.replace(`${count} entr`, 'entr');
        expect(withoutCount).not.toMatch(/\d/);
        expect(copy.reason).not.toMatch(/[₹$€£]/);
      }
    }
  });
});

describe('drillDownLoadProblem', () => {
  it('says nothing when every entry arrived', () => {
    expect(drillDownLoadProblem(8, 0)).toBeNull();
    expect(drillDownLoadProblem(0, 0)).toBeNull();
  });

  it('calls a total failure a connection problem, not an empty month', () => {
    // Without this the sheet renders an empty list, which reads as "these entries are gone".
    const text = drillDownLoadProblem(6, 6);
    expect(text).not.toBeNull();
    expect(text).toMatch(/could not be opened/i);
  });

  it('says how big the hole is when only some arrived', () => {
    // The rows that did load would otherwise become the whole story, and the person checking
    // the total would conclude the total is wrong.
    expect(drillDownLoadProblem(10, 3)).toBe(
      '3 of these 10 entries could not be opened just now, so this list is not all of them.',
    );
  });

  it('distinguishes a partial failure from a total one', () => {
    expect(drillDownLoadProblem(4, 1)).not.toBe(drillDownLoadProblem(4, 4));
  });
});

// ---------------------------------------------------------------------------
// Spending alerts
// ---------------------------------------------------------------------------

describe('the spending alerts panel', () => {
  const alert = (over: Partial<SpendingAlert> = {}): SpendingAlert => ({
    kind: 'possible-duplicate',
    text: 'Two payments of ₹1,200 to Jain Hardware within a day of each other.',
    recordIds: ['rec_a', 'rec_b'],
    at: 1_700_000_000_000,
    ...over,
  });

  it('shows nothing at all when there is nothing wrong', () => {
    // `null`, not `[]`. A month with nothing wrong in it gets a screen with nothing extra on
    // it — an empty panel saying "no alerts" would be a section that exists only to announce
    // that a feature exists, which is the kind of thing this product is meant not to do.
    expect(showableAlerts([])).toBeNull();
    expect(showableAlerts(undefined)).toBeNull();
    expect(showableAlerts(null)).toBeNull();
  });

  it('survives a server that sends something unusable', () => {
    // Not defensive programming for its own sake: `alerts` is a new field, and an old client
    // against a new server — or the reverse — is the normal state of a shipped app. A
    // non-array must not throw inside a screen that is otherwise fine.
    expect(showableAlerts({ kind: 'oops' } as unknown as SpendingAlert[])).toBeNull();
  });

  it('refuses an alert with nothing to open', () => {
    /*
     * This is the rule the whole feature rests on. Each of these sentences is the product
     * making a claim about somebody's money, and the only thing that makes such a claim
     * acceptable is that they can reach the records behind it in one tap and decide it is
     * wrong. An alert with no records is a claim with no evidence, so it is dropped rather
     * than rendered as a row whose button does nothing.
     */
    expect(showableAlerts([alert({ recordIds: [] })])).toBeNull();
    expect(showableAlerts([alert({ recordIds: undefined as unknown as string[] })])).toBeNull();
    expect(showableAlerts([alert({ text: '   ' })])).toBeNull();

    // And a bad one does not take a good one with it.
    const kept = showableAlerts([alert({ recordIds: [] }), alert({ recordIds: ['rec_c'] })]);
    expect(kept).toHaveLength(1);
    expect(kept?.[0]?.recordIds).toEqual(['rec_c']);
  });

  it('keeps the order the server sent, and does not re-cap the list', () => {
    // The server caps at four and orders by what happened most recently. A client that sorted
    // again would be inventing a priority, and a priority is a figure in disguise.
    const given = [alert({ at: 3 }), alert({ at: 1 }), alert({ at: 2 })];
    expect(showableAlerts(given)?.map((item) => item.at)).toEqual([3, 1, 2]);
  });

  it('never claims more than the detectors support', () => {
    // "4 problems" would be wrong: a new payee is usually nothing and a bill that has not
    // come may have been cancelled. The heading says how much reading is ahead, not how bad
    // things are.
    expect(alertsHeading(1)).toBe('One thing worth a look');
    expect(alertsHeading(4)).toBe('4 things worth a look');
    for (const count of [1, 2, 3, 4]) {
      expect(alertsHeading(count)).not.toMatch(/\b(problem|wrong|error|warning|alert|issue)/i);
    }
  });

  it('gives every kind an icon that exists in the font', async () => {
    /*
     * The icon name is typed `string` rather than `IconName`, because `src/api/insights.ts`
     * deliberately does not import from `@ui` — and a name that is merely a string is a name
     * that can be misspelled into a blank square on a real phone.
     *
     * So it is checked against the actual glyph map the app ships, which is stronger than the
     * type would have been: the type only proves the name is in `@expo/vector-icons`'s union,
     * while this proves the glyph is in the font file that gets bundled.
     */
    const glyphs = (
      await import(
        '@expo/vector-icons/build/vendor/react-native-vector-icons/glyphmaps/MaterialCommunityIcons.json'
      )
    ).default as Record<string, number>;

    const kinds: AlertKind[] = ['unusual-amount', 'bill-not-arrived', 'possible-duplicate', 'new-payee'];
    for (const kind of kinds) {
      const look = alertLook(kind);
      expect(glyphs[look.icon], `${kind} points at a glyph that is not in the font: ${look.icon}`).toBeDefined();
      // Every row is tappable, so every row's own word has to be something to do.
      expect(look.verb.length).toBeGreaterThan(2);
    }

    // And the fallback, which is what a kind this app has not been taught yet gets.
    expect(glyphs[alertLook('something-new-from-the-server').icon]).toBeDefined();
  });

  it('reserves the loudest tone for the one case that costs money', () => {
    /*
     * Four identical amber rows read as four copies of one problem, and they are not. A charge
     * paid twice is money that has probably gone and may be recoverable; a payee somebody has
     * not paid before is usually just a new shop. If every kind were `danger` the colour would
     * stop carrying any information, which is the same failure as having no colour at all.
     */
    expect(alertLook('possible-duplicate').tone).toBe('danger');
    expect(alertLook('new-payee').tone).toBe('neutral');
    expect(alertLook('unusual-amount').tone).not.toBe('danger');
    expect(alertLook('bill-not-arrived').tone).not.toBe('danger');
  });
});

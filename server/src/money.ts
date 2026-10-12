const EXPONENTS: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  JOD: 3,
};

export function exponentFor(currency: string): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2;
}

const DIGIT_BLOCKS = [
  0x0660, 
  0x06f0, 
  0x0966, 
  0x09e6, 
  0x0a66, 
  0x0ae6, 
  0x0b66, 
  0x0be6, 
  0x0c66, 
  0x0ce6, 
  0x0d66, 
];

const NON_ASCII_DIGIT = /[٠-٩۰-۹०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/;

export function toAsciiDigits(value: string): string {
  if (!NON_ASCII_DIGIT.test(value)) return value;
  let folded = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const block = DIGIT_BLOCKS.find((start) => code >= start && code <= start + 9);
    folded += block === undefined ? character : String(code - block);
  }
  return folded;
}

const SYMBOLS: Record<string, string> = {
  '₹': 'INR',
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₩': 'KRW',
  '₽': 'RUB',
  '₪': 'ILS',
  '₦': 'NGN',
  '₱': 'PHP',
  '৳': 'BDT',
  '₨': 'INR',
};

const WORDS: Record<string, string> = {
  RUPEE: 'INR',
  RUPEES: 'INR',
  RUPAYE: 'INR',
  DOLLAR: 'USD',
  DOLLARS: 'USD',
  EURO: 'EUR',
  EUROS: 'EUR',
  POUND: 'GBP',
  POUNDS: 'GBP',
  YEN: 'JPY',
  TAKA: 'BDT',
  DIRHAM: 'AED',
  DIRHAMS: 'AED',
};

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

export function normalizeCurrency(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const symbol = SYMBOLS[trimmed];
  if (symbol) return symbol;
  const upper = trimmed.toUpperCase().replace(/\.$/, '');
  if (upper === 'RS' || upper === 'INR') return 'INR';
  const word = WORDS[upper];
  if (word) return word;
  if (CURRENCIES.has(upper)) return upper;
  return null;
}

const AMOUNT_DECORATION = /^(?:\/[-=]|-\/|\/|Dr\.?|Cr\.?|only)$/i;

function labelAllows(label: string | undefined, code: string): boolean {
  const trimmed = label?.trim();
  if (!trimmed) return true;
  if (AMOUNT_DECORATION.test(trimmed)) return true;
  return normalizeCurrency(trimmed) === code;
}

const SCALE_WORDS: Array<[RegExp, number]> = [
  [/^(?:thousand|हज़ार|हजार)$/i, 3],
  [/^(?:lakhs?|lacs?|लाख)$/i, 5],
  [/^(?:crores?|करोड़|करोड)$/i, 7],

  [/^millions?$/i, 6],
  [/^billions?$/i, 9],
];

function croreShorthand(number: string, fractionLength: number): boolean {
  return !/[,]/.test(number) && number.replace(/\..*$/, '').length <= 3 && fractionLength !== 2;
}

function scaleBeside(
  label: string,
  number: string,
  fractionLength: number,
): { exponent: number; rest: string } | null {
  const tokens = label.trim().split(/\s+/).filter(Boolean);
  let exponent: number | null = null;
  const rest: string[] = [];
  for (const token of tokens) {
    const bare = token.replace(/[.,]$/, '');
    const matched = SCALE_WORDS.find(([pattern]) => pattern.test(bare))?.[1] ??
      (/^cr$/i.test(bare) && croreShorthand(number, fractionLength) ? 7 : null);
    if (matched === null || matched === undefined) {
      rest.push(token);
      continue;
    }

    if (exponent !== null) return null;
    exponent = matched;
  }
  return exponent === null ? null : { exponent, rest: rest.join(' ') };
}

const WORD_VALUES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const WORD_SCALES: Record<string, number> = {
  hundred: 100, thousand: 1_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000,
  crore: 10_000_000, crores: 10_000_000, million: 1_000_000, billion: 1_000_000_000,
};

const WORD_FILLER = /^(?:and|only|rupees?|rupaye|rs|inr|of|the)$/i;

const WORD_JOIN = /^(?:of|the)$/i;

function amountFromWords(text: string): { whole: string; fraction: string; currency: string | null } | null {
  const tokens = text
    .toLowerCase()
    .replace(/[₹,.\-–—/]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;

  let currency: string | null = null;

  let boundary = -1;
  let boundaryIsScale = false;
  let paiseAt = -1;

  for (const [index, token] of tokens.entries()) {
    if (/^pais[ae]$/.test(token)) {
      paiseAt = index;
      break;
    }
    const isValue = token in WORD_VALUES;
    const isScale = token in WORD_SCALES;
    if (isScale) {
      boundary = index;
      boundaryIsScale = true;
      continue;
    }
    if (isValue) continue;

    if (WORD_FILLER.test(token)) {
      if (WORD_JOIN.test(token)) return null;
      continue;
    }
    const named = normalizeCurrency(token);
    if (!named) return null;
    if (currency && currency !== named) return null;
    currency = named;
    boundary = index;
    boundaryIsScale = false;
  }

  const values = (from: number, to: number): string[] =>
    tokens.slice(from, to).filter((token) => token in WORD_VALUES || token in WORD_SCALES);

  if (paiseAt === -1) {
    const whole = wordsToNumber(values(0, tokens.length));
    return whole === null ? null : { whole: String(whole), fraction: '', currency };
  }

  const rupeeEnd = boundary === -1 ? 0 : boundaryIsScale ? boundary + 1 : boundary;
  const whole = rupeeEnd === 0 ? 0 : wordsToNumber(values(0, rupeeEnd));
  const fraction = wordsToNumber(values(rupeeEnd, paiseAt));
  if (whole === null || fraction === null || fraction > 99) return null;
  return { whole: String(whole), fraction: String(fraction).padStart(2, '0'), currency };
}

function wordsToNumber(tokens: string[]): number | null {
  let total = 0;
  let group = 0;
  let sawValue = false;
  for (const token of tokens) {
    const value = WORD_VALUES[token];
    if (value !== undefined) {
      group += value;
      sawValue = true;
      continue;
    }
    const scale = WORD_SCALES[token];
    if (scale === undefined) return null;
    if (!sawValue) return null;
    if (scale === 100) {
      group *= 100;
    } else {
      total += group * scale;
      group = 0;
    }
  }
  if (!sawValue) return null;
  return total + group;
}

function minorFrom(whole: string, fraction: string, scaleExponent: number, exponent: number): number | null {
  const digits = BigInt(whole + fraction);
  const shift = exponent + scaleExponent - fraction.length;
  let minor: bigint;
  if (shift >= 0) {
    minor = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    if (digits % divisor !== 0n) return null;
    minor = digits / divisor;
  }
  return minor > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(minor);
}

export function toMinorUnits(raw: string | null, currency: string | null): number | null {
  if (!raw || !currency) return null;

  const code = normalizeCurrency(currency);
  if (!code) return null;
  const exponent = exponentFor(code);
  let body = toAsciiDigits(raw).trim();

  let bracketed = false;
  const brackets = /^\((.*)\)$/.exec(body);
  if (brackets?.[1] && !brackets[1].includes('(')) {
    bracketed = true;
    body = brackets[1].trim();
  }

  if (!/\d/.test(body)) {
    const spelled = amountFromWords(body);
    if (!spelled || (spelled.currency !== null && spelled.currency !== code)) return null;
    const minor = minorFrom(spelled.whole, spelled.fraction, 0, exponent);
    if (minor === null) return null;
    return bracketed && minor !== 0 ? -minor : minor;
  }

  const match = /^([^\d+-]*)([+-]?\d[\d.,]*)([^\d]*)$/.exec(body);
  if (!match) return null;
  let text = match[2]!;

  let negative = bracketed;
  if (text.startsWith('-')) negative = !negative;
  if (text.startsWith('-') || text.startsWith('+')) text = text.slice(1);

  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');

  let decimalMark: '.' | ',' | null = null;
  if (lastComma !== -1 && lastDot !== -1) {
    decimalMark = lastComma > lastDot ? ',' : '.';
  } else if (lastDot !== -1) {

    decimalMark = '.';
  } else if (lastComma !== -1) {
    const tail = text.length - lastComma - 1;
    decimalMark = tail === 3 ? null : ',';
  }

  let whole = text;
  let fraction = '';
  if (decimalMark) {
    const index = decimalMark === ',' ? lastComma : lastDot;
    whole = text.slice(0, index);
    fraction = text.slice(index + 1);
  }

  let scaleExponent = 0;
  let before = match[1] ?? '';
  let after = match[3] ?? '';
  for (const side of ['after', 'before'] as const) {
    const label = side === 'after' ? after : before;
    if (!label.trim() || scaleExponent !== 0) continue;
    const scale = scaleBeside(label, text, fraction.length);
    if (!scale) continue;

    scaleExponent = scale.exponent;
    if (side === 'after') after = scale.rest;
    else before = scale.rest;
  }

  if (!labelAllows(before, code) || !labelAllows(after, code)) return null;

  if (/[.,]/.test(whole)) {
    const grouping = decimalMark === ',' ? '.' : ',';
    const parts = whole.split(grouping);
    const western = /^[0-9]{1,3}$/.test(parts[0] ?? '') && parts.slice(1).every((part) => /^\d{3}$/.test(part));
    const indian = /^[0-9]{1,2}$/.test(parts[0] ?? '') && /^\d{3}$/.test(parts.at(-1) ?? '') &&
      parts.slice(1, -1).every((part) => /^\d{2}$/.test(part));
    if (!western && !indian) return null;
    whole = parts.join('');
  }

  if (!/^\d+$/.test(whole) || (fraction && !/^\d+$/.test(fraction))) return null;

  const minor = minorFrom(whole, fraction, scaleExponent, exponent);
  if (minor === null) return null;
  return negative && minor !== 0 ? -minor : minor;
}

const MONEY_OUT = [
  /\bdebit(?:ed)?\b/i,
  /\bpaid\s+to\b/i,
  /\b(?:you\s+)?paid\b/i,
  /\bpayment\s+(?:of|to)\b/i,
  /\bsent\s+to\b/i,
  /\bsent\b/i,
  /\btransferred\s+to\b/i,
  /\bwithdrawn\b/i,
  /\bspent\b/i,
  /\d[\d,.]*\s*dr\b|^\s*dr\.?\s*\d/i,
  /भुगतान|डेबिट|भेजे|नामे/,
];

const MONEY_IN = [
  /\bcredit(?:ed)?\b/i,
  /\breceived\s+from\b/i,
  /\breceived\b/i,
  /\bdeposited\b/i,
  /\bcollected\b/i,
  /\brefund(?:ed)?\b/i,
  /\badded\s+to\b/i,
  /\d[\d,.]*\s*cr\b|^\s*cr\.?\s*\d/i,
  /जमा|क्रेडिट|प्राप्त/,
];

export function directionOf(text: string | null): 'in' | 'out' | null {
  if (!text) return null;
  const out = MONEY_OUT.some((pattern) => pattern.test(text));
  const into = MONEY_IN.some((pattern) => pattern.test(text));
  if (out === into) return null;
  return out ? 'out' : 'in';
}

const LOCALES: Record<string, string> = {
  INR: 'en-IN',
  PKR: 'en-PK',
  BDT: 'bn-BD',
  LKR: 'si-LK',
  NPR: 'ne-NP',
};

export function formatMinorUnits(minor: number, currency: string, locale?: string): string {
  const code = currency.toUpperCase();
  const exponent = exponentFor(code);
  try {
    return new Intl.NumberFormat(locale ?? LOCALES[code] ?? 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(minor / 10 ** exponent);
  } catch {
    return `${currency} ${(minor / 10 ** exponent).toFixed(exponent)}`;
  }
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  'जनवरी': 1, 'जनवरि': 1, 'फरवरी': 2, 'फ़रवरी': 2, 'मार्च': 3, 'अप्रैल': 4, 'अप्रिल': 4,
  'मई': 5, 'जून': 6, 'जुलाई': 7, 'अगस्त': 8, 'सितंबर': 9, 'सितम्बर': 9, 'सप्टेंबर': 9,
  'अक्टूबर': 10, 'अक्तूबर': 10, 'ऑक्टोबर': 10, 'नवंबर': 11, 'नवम्बर': 11,
  'दिसंबर': 12, 'दिसम्बर': 12, 'डिसेंबर': 12,
};

function monthNumber(name: string): number {
  const key = name.toLowerCase().replace(/\.$/, '');
  return MONTH_NAMES[key] ?? MONTH_NAMES[key.slice(0, 3)] ?? 0;
}

function fullYear(raw: string): number {
  const value = Number(raw);
  if (raw.length === 4) return value;
  return value <= 69 ? 2000 + value : 1900 + value;
}

const MONTH_WORD = String.raw`[A-Za-zऀ-ॿ]{3,12}`;
const TIME = String.raw`(\d{1,2})[:.](\d{2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`;

type Printed = { year: number; month: number; day: number; precision: 'day' | 'month' | 'year' };

const CALENDAR_FORMS: Array<{ pattern: RegExp; read: (parts: string[]) => Printed | null }> = [
  {

    pattern: new RegExp(String.raw`^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})$`),
    read: (parts) => ({ year: fullYear(parts[1]!), month: Number(parts[2]), day: Number(parts[3]), precision: 'day' }),
  },
  {

    pattern: new RegExp(String.raw`^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$`),
    read: (parts) => {
      const first = Number(parts[1]);
      const second = Number(parts[2]);
      const year = fullYear(parts[3]!);
      const day = { year, month: second, day: first, precision: 'day' as const };

      if (first <= 31 && second <= 12) return day;

      if (second <= 31 && first <= 12) return { year, month: first, day: second, precision: 'day' };
      return null;
    },
  },
  {
    pattern: new RegExp(String.raw`^(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_WORD})\.?,?\s+(\d{2}|\d{4})$`, 'i'),
    read: (parts) => ({ year: fullYear(parts[3]!), month: monthNumber(parts[2]!), day: Number(parts[1]), precision: 'day' }),
  },
  {
    pattern: new RegExp(String.raw`^(${MONTH_WORD})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2}|\d{4})$`, 'i'),
    read: (parts) => ({ year: fullYear(parts[3]!), month: monthNumber(parts[1]!), day: Number(parts[2]), precision: 'day' }),
  },
  {

    pattern: new RegExp(String.raw`^(${MONTH_WORD})\.?,?\s+(\d{4})$`, 'i'),
    read: (parts) => ({ year: Number(parts[2]), month: monthNumber(parts[1]!), day: 1, precision: 'month' }),
  },
  {

    pattern: new RegExp(String.raw`^(\d{1,2})[/.\-](\d{4})$`),
    read: (parts) => ({ year: Number(parts[2]), month: Number(parts[1]), day: 1, precision: 'month' }),
  },
];

function midnight(offsetDays = 0): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays).getTime();
}

export function toEpoch(
  iso: string | null,
  precision: 'minute' | 'day' | 'month' | 'year' | null,
): { at: number | null; precision: string | null } {
  const empty = { at: null, precision: null };
  if (!iso) return empty;
  const trimmed = toAsciiDigits(iso).trim().replace(/\s+/g, ' ');
  if (!trimmed) return empty;

  const lower = trimmed.toLowerCase();
  if (lower === 'today' || lower === 'aaj' || lower === 'आज') return { at: midnight(), precision: 'day' };
  if (lower === 'yesterday' || lower === 'kal' || lower === 'कल') return { at: midnight(-1), precision: 'day' };

  const isoParts =
    /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      trimmed,
    );

  let year: number;
  let month: number;
  let day: number;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let hasTime = false;
  let absolute: number | null = null;

  let inferred: 'minute' | 'day' | 'month' | 'year';

  if (isoParts) {
    year = Number(isoParts[1]);
    month = Number(isoParts[2] ?? 1);
    day = Number(isoParts[3] ?? 1);

    if (isoParts[4] !== undefined && !isoParts[3]) return empty;
    hasTime = isoParts[4] !== undefined;
    hour = Number(isoParts[4] ?? 0);
    minute = Number(isoParts[5] ?? 0);
    second = Number(isoParts[6] ?? 0);
    inferred = hasTime ? 'minute' : isoParts[2] === undefined ? 'year' : isoParts[3] === undefined ? 'month' : 'day';

    if (hasTime) absolute = Date.parse(trimmed);
  } else {

    const split = new RegExp(String.raw`^(.*?)(?:[,]?\s+(?:at\s+)?${TIME})?$`, 'i').exec(trimmed);
    if (!split) return empty;
    const datePart = (split[1] ?? '').trim().replace(/[,]$/, '');

    let read: Printed | null = null;
    for (const form of CALENDAR_FORMS) {
      const parts = form.pattern.exec(datePart);
      if (parts) {
        read = form.read(parts as unknown as string[]);
        break;
      }
    }
    if (!read) return empty;
    ({ year, month, day } = read);
    inferred = read.precision;

    if (split[2] !== undefined) {
      hasTime = true;
      hour = Number(split[2]);
      minute = Number(split[3]);
      second = Number(split[4] ?? 0);
      inferred = 'minute';
      const half = split[5]?.toLowerCase().replace(/\./g, '');

      if (half === 'pm' && hour < 12) hour += 12;
      if (half === 'am' && hour === 12) hour = 0;
      if (half !== undefined && (hour > 23 || Number(split[2]) > 12 || Number(split[2]) < 1)) return empty;
    }
  }

  if (
    year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  ) {
    return empty;
  }
  if (hour > 23 || minute > 59 || second > 59) return empty;

  const parsed = absolute ?? new Date(year, month - 1, day, hour, minute, second).getTime();
  if (!Number.isFinite(parsed)) return empty;
  const rank = { year: 0, month: 1, day: 2, minute: 3 };
  const actualPrecision = precision && rank[precision] < rank[inferred] ? precision : inferred;
  return { at: parsed, precision: actualPrecision };
}

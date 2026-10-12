const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  AED: 'AED ',
  SGD: 'S$',
  AUD: 'A$',
  CAD: 'C$',
};

const CURRENCY_EXPONENT: Record<string, number> = {
  INR: 2, USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, SGD: 2, AED: 2, CHF: 2, CNY: 2, NZD: 2, ZAR: 2,
  JPY: 0, KRW: 0,
  BHD: 3, KWD: 3, OMR: 3,
};

function currencyExponent(currency: string): number {
  return CURRENCY_EXPONENT[currency.toUpperCase()] ?? 2;
}

const LAKH_CURRENCIES = new Set(['INR', 'PKR', 'LKR', 'NPR', 'BDT']);

function groupDigits(digits: string, lakh: boolean): string {
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3);

  return `${head.replace(lakh ? /\B(?=(\d{2})+$)/g : /\B(?=(\d{3})+$)/g, ',')},${digits.slice(-3)}`;
}

export function formatMoneyCompact(minorUnits: number, currency: string): string {
  if (!Number.isFinite(minorUnits)) return '';
  const code = currency.trim().toUpperCase();
  const exponent = currencyExponent(code);
  const negative = minorUnits < 0;
  const absolute = Math.abs(Math.trunc(minorUnits));
  const whole = Math.floor(absolute / 10 ** exponent);
  const fraction = absolute % 10 ** exponent;
  const grouped = groupDigits(String(whole), LAKH_CURRENCIES.has(code));
  const symbol = CURRENCY_SYMBOLS[code] ?? `${code} `;
  const body = exponent === 0 || fraction === 0
    ? grouped
    : `${grouped}.${String(fraction).padStart(exponent, '0')}`;
  return `${negative ? '-' : ''}${symbol}${body}`;
}

export function currencySymbol(currency: string): string {
  const code = currency.trim().toUpperCase();
  return CURRENCY_SYMBOLS[code]?.trim() || code;
}

export function normalizeUserAmount(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  let cleaned = trimmed.replace(/^(?:[₹$€£¥₩₽₪₦₱৳₨]|(?:rs\.?|inr|usd|eur|gbp)\s*)/i, '').trim();

  cleaned = cleaned.replace(/(?:\s*(?:\/[-=]|rs\.?|inr|usd|eur|gbp))$/i, '').trim();

  cleaned = cleaned.replace(/[\s,]/g, '');
  if (!/^\d+(?:\.\d{1,3})?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num <= 0) return null;
  return cleaned;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function shortMonth(monthIndex: number): string {
  return (MONTH_NAMES[monthIndex] ?? '').slice(0, 3);
}

export function formatRelativeTime(timestamp: number, now: number): string {
  const delta = now - timestamp;
  if (delta < 0) return 'Just now';
  if (delta < MINUTE) return 'Just now';
  if (delta < HOUR) {
    const minutes = Math.floor(delta / MINUTE);
    return `${minutes} min ago`;
  }
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }
  const days = Math.floor(delta / DAY);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
  }
  return formatAbsoluteDate(timestamp);
}

export function formatAbsoluteDate(timestamp: number, now: number = Date.now()): string {
  const date = new Date(timestamp);
  const month = shortMonth(date.getMonth());
  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  return sameYear
    ? `${date.getDate()} ${month}`
    : `${date.getDate()} ${month} ${date.getFullYear()}`;
}

export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const day = date.getDate();
  const month = shortMonth(date.getMonth());
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${day} ${month} ${date.getFullYear()}, ${time}`;
}

export function formatOccurredOn(timestamp: number, precision?: string | null): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = MONTH_NAMES[date.getMonth()] ?? '';
  if (precision === 'year') return String(year);
  if (precision === 'month') return `${month} ${year}`;
  const day = `${date.getDate()} ${month} ${year}`;
  return precision === 'minute' ? `${day}, ${formatClockTime(timestamp)}` : day;
}

export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours();
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`;
}

export function isoDateOf(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function realDate(day: number, month: number, year: number): boolean {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const shortFebruary = month === 2 && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
  return day <= (DAYS_IN_MONTH[month - 1] ?? 31) - (shortFebruary ? 1 : 0);
}

export function normalizeTypedDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = /^(\d{1,2})\s*[/.\s-]\s*(\d{1,2})\s*[/.\s-]\s*(\d{2}|\d{4})$/.exec(input.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const written = match[3] ?? '';
  const year = written.length === 2 ? Number(written) + (Number(written) >= 70 ? 1900 : 2000) : Number(written);
  if (!realDate(day, month, year)) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

const WRITTEN_CURRENCIES: Record<string, string> = {
  '₹': 'INR', '₨': 'INR', rs: 'INR', inr: 'INR',
  $: 'USD', usd: 'USD',
  '€': 'EUR', eur: 'EUR',
  '£': 'GBP', gbp: 'GBP',
  '¥': 'JPY',
  '₩': 'KRW',
  '₽': 'RUB',
  '₪': 'ILS',
  '₦': 'NGN',
  '₱': 'PHP',
  '৳': 'BDT',
};

export function currencyInUserAmount(input: string | null | undefined): string | null {
  if (!input) return null;

  const token = input
    .toLowerCase()
    .replace(/[\d\s,]/g, '')
    .replace(/\/[-=]$/, '')
    .replace(/\.+$/, '');
  return WRITTEN_CURRENCIES[token] ?? null;
}

const TEXT_MARKER = '[TEXT]';
const SCENE_MARKER = '[SCENE]';

function splitRead(sourceText: string): { words: string; scene: string } {
  const upper = sourceText.toUpperCase();
  const textAt = upper.indexOf(TEXT_MARKER);
  const sceneAt = upper.indexOf(SCENE_MARKER);
  if (sceneAt === -1) {
    const words = textAt === -1 ? sourceText : sourceText.slice(textAt + TEXT_MARKER.length);
    return { words: words.trim(), scene: '' };
  }
  return {
    words:
      textAt === -1 || textAt > sceneAt
        ? ''
        : sourceText.slice(textAt + TEXT_MARKER.length, sceneAt).trim(),
    scene: sourceText.slice(sceneAt + SCENE_MARKER.length).trim(),
  };
}

export function documentWords(sourceText: string | null | undefined): string | null {
  if (!sourceText) return null;
  return splitRead(sourceText).words || null;
}

export function pictureDescription(sourceText: string | null | undefined): string | null {
  if (!sourceText) return null;
  return splitRead(sourceText).scene || null;
}

export type RecordRead = {

  isDocument: boolean;

  note: string | null;

  reference: string | null;

  marked: string | null;

  summary: string | null;

  words: string | null;

  scene: string | null;

  unread: boolean;
};

export const NOTHING_READ: RecordRead = {
  isDocument: false,
  note: null,
  reference: null,
  marked: null,
  summary: null,
  words: null,
  scene: null,
  unread: false,
};

const DOCUMENT_READS = new Set(['pdf', 'docx', 'text']);

function readString(source: Record<string, unknown>, key: string, limit: number): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const text = value.trim();

  return text && text.length <= limit ? text : null;
}

const REFERENCE_LIMIT = 80;

const MARKED_LIMIT = 40;

const PROSE_LIMIT = 1_000;

export function readRecordDetails(extraction: unknown): RecordRead {
  if (!extraction || typeof extraction !== 'object' || Array.isArray(extraction)) return NOTHING_READ;
  const source = extraction as Record<string, unknown>;
  const sourceText = typeof source.sourceText === 'string' ? source.sourceText : null;
  const readBy = readString(source, 'readBy', MARKED_LIMIT);
  const marked = readString(source, 'status', MARKED_LIMIT);
  return {
    isDocument: readBy !== null && DOCUMENT_READS.has(readBy.toLowerCase()),
    note: readString(source, 'readNote', PROSE_LIMIT),
    reference: readString(source, 'reference', REFERENCE_LIMIT),

    marked: marked ? marked.charAt(0).toUpperCase() + marked.slice(1) : null,
    summary: readString(source, 'summary', PROSE_LIMIT),
    words: documentWords(sourceText),
    scene: pictureDescription(sourceText),
    unread: source.unread === true,
  };
}

export function readHasContent(read: RecordRead): boolean {
  return Boolean(read.summary || read.reference || read.marked || read.words || read.scene);
}

export type RecordStatusWords = {

  label: string;

  meaning: string;
};

export function recordStatusWords(status: string | null | undefined): RecordStatusWords {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'processing':
      return {
        label: 'Reading it now',
        meaning: 'This is still being read. You can leave the page — it carries on without you.',
      };
    case 'needs_context':
      return {
        label: 'One thing to check',
        meaning: 'It has been read. There is one thing only you can answer.',
      };
    case 'complete':
      return {
        label: 'All set',
        meaning: 'This one is finished. Anything that looks wrong can be corrected below.',
      };
    case 'unreadable':
      return {
        label: 'Couldn’t read this',
        meaning: 'Nothing could be read from the file. It is still saved, and you can fill in what matters.',
      };
    case 'failed':
      return {
        label: 'Stopped partway',
        meaning: 'Reading this stopped before it finished. The file is safe — have another go, or type it in.',
      };
    default:
      return {
        label: 'Saved',
        meaning: 'This is saved. Anything below can be changed.',
      };
  }
}

export type RecordKindFamily =
  | 'payment' | 'purchase' | 'bill' | 'receipt' | 'ticket'
  | 'travel' | 'document' | 'message' | 'note' | 'other';

const RECORD_KINDS: Record<string, { label: string; family: RecordKindFamily }> = {

  payment: { label: 'Payment', family: 'payment' },
  purchase: { label: 'Purchase', family: 'purchase' },
  bill: { label: 'Bill', family: 'bill' },
  receipt: { label: 'Receipt', family: 'receipt' },
  ticket: { label: 'Ticket', family: 'ticket' },
  travel: { label: 'Travel', family: 'travel' },
  document: { label: 'Document', family: 'document' },
  message: { label: 'Message', family: 'message' },
  note: { label: 'Note', family: 'note' },

  other: { label: 'Something you saved', family: 'other' },

  invoice: { label: 'Bill', family: 'bill' },
  statement: { label: 'Statement', family: 'bill' },
  bank_statement: { label: 'Bank statement', family: 'bill' },
  tax: { label: 'Tax paper', family: 'bill' },
  transfer: { label: 'Transfer', family: 'payment' },
  refund: { label: 'Refund', family: 'payment' },
  salary: { label: 'Salary', family: 'payment' },
  payslip: { label: 'Payslip', family: 'payment' },
  rent: { label: 'Rent', family: 'payment' },
  cheque: { label: 'Cheque', family: 'payment' },
  check: { label: 'Cheque', family: 'payment' },
  order: { label: 'Order', family: 'purchase' },
  subscription: { label: 'Subscription', family: 'purchase' },
  slip: { label: 'Slip', family: 'receipt' },
  voucher: { label: 'Voucher', family: 'receipt' },
  coupon: { label: 'Voucher', family: 'receipt' },
  boarding_pass: { label: 'Boarding pass', family: 'ticket' },
  booking: { label: 'Booking', family: 'travel' },
  reservation: { label: 'Booking', family: 'travel' },
  insurance: { label: 'Insurance paper', family: 'document' },
  policy: { label: 'Policy', family: 'document' },
  warranty: { label: 'Warranty', family: 'document' },
  prescription: { label: 'Prescription', family: 'document' },
  contract: { label: 'Agreement', family: 'document' },
  agreement: { label: 'Agreement', family: 'document' },
  letter: { label: 'Letter', family: 'document' },
  certificate: { label: 'Certificate', family: 'document' },
  form: { label: 'Form', family: 'document' },
  email: { label: 'Message', family: 'message' },
  chat: { label: 'Message', family: 'message' },
  sms: { label: 'Message', family: 'message' },
  photo: { label: 'Picture', family: 'other' },
  picture: { label: 'Picture', family: 'other' },
  image: { label: 'Picture', family: 'other' },
  screenshot: { label: 'Picture', family: 'other' },
};

const UNNAMED_KIND = 'Something you saved';

function kindInWords(token: string): string | null {
  const words = token.split(/[^a-z]+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;
  if (words.join('').length > 24) return null;
  if (!words.every((word) => word.length >= 3 && /[aeiou]/.test(word))) return null;
  const [first = '', ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

export function recordKindLabel(kind: string | null | undefined): string {
  const token = (kind ?? '').trim().toLowerCase();
  if (!token) return UNNAMED_KIND;
  return RECORD_KINDS[token]?.label ?? kindInWords(token) ?? UNNAMED_KIND;
}

export function recordKindFamily(kind: string | null | undefined): RecordKindFamily {
  const token = (kind ?? '').trim().toLowerCase();
  return RECORD_KINDS[token]?.family ?? 'other';
}

export type ShareableRecord = {
  kind: string;
  title: string;
  amountLabel: string | null;
  direction: 'in' | 'out' | null;
  counterparty: string | null;
  occurredAt: number | null;
  occurredPrecision: string | null;
};

export function recordShareText(record: ShareableRecord, reference: string | null): string {
  const title = record.title?.trim() || recordKindLabel(record.kind);
  const lines: string[] = [title];
  if (record.amountLabel) {
    const verb = record.direction === 'in' ? 'Received' : record.direction === 'out' ? 'Paid' : 'Amount';
    lines.push(`${verb} ${record.amountLabel}`);
  }
  if (record.counterparty?.trim()) {
    const with_ = record.direction === 'in' ? 'From' : record.direction === 'out' ? 'To' : 'With';
    lines.push(`${with_} ${record.counterparty.trim()}`);
  }
  if (record.occurredAt !== null) {
    lines.push(`On ${formatOccurredOn(record.occurredAt, record.occurredPrecision)}`);
  }
  if (reference?.trim()) lines.push(`Reference ${reference.trim()}`);
  return lines.join('\n');
}

export function exportFileName(title: string | null | undefined, fallback = 'The original'): string {
  const cleaned = (title ?? '').replace(/[^\p{L}\p{N}\p{M} ._-]/gu, '').trim();

  const named = cleaned.replace(/^[.\s]+/, '').slice(0, 80).trim();
  return named || fallback;
}

export type RelatedLink = { by: 'counterparty'; value: string } | { by: 'category'; value: string };

export function relatedLink(record: {
  counterparty?: string | null;
  category?: string | null;
}): RelatedLink | null {
  const name = (record.counterparty ?? '').trim();
  if (name) return { by: 'counterparty', value: name };
  const category = (record.category ?? '').trim();
  if (category) return { by: 'category', value: category };
  return null;
}

export function relatedLinkTitle(link: RelatedLink): string {
  return link.by === 'counterparty' ? `More with ${link.value}` : `More under ${link.value}`;
}

export function relatedLinkHint(link: RelatedLink): string {
  return link.by === 'counterparty'
    ? 'Other things you’ve saved with the same name on them.'
    : 'Other things you’ve filed the same way.';
}

export function relatedRecords<
  T extends { id: string; counterparty?: string | null; category?: string | null },
>(self: string, link: RelatedLink, page: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];
  const wanted = link.value.trim().toLowerCase();
  const field = link.by;
  return page
    .filter((entry) => {
      if (entry.id === self) return false;
      const value = (field === 'counterparty' ? entry.counterparty : entry.category) ?? '';
      return value.trim().toLowerCase() === wanted;
    })
    .slice(0, limit);
}

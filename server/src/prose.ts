const ID = /\b[a-z][a-z0-9]{1,9}_[0-9a-f]{16,}\b/g;

const ID_ONLY_PARENTHETICAL =
  /\s*[([](?:\s*(?:entry|entries|record|records|id|ids|ref|refs|reference|see|source|sources|from)\b[:\s]*)?(?:[a-z][a-z0-9]{1,9}_[0-9a-f]{16,}(?:\s*[,;/]\s*|\s+and\s+|\s*)?)+[)\]]/gi;

export function withoutIds(text: string): string {
  if (!ID.test(text)) {
    ID.lastIndex = 0;
    return text;
  }
  ID.lastIndex = 0;

  return (
    text
      .replace(ID_ONLY_PARENTHETICAL, '')
      .replace(ID, '')

      .replace(/[ \t]*[-–—:][ \t]*(?=[.,;!?)\]]|$)/gm, '')

      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([.,;:!?)\]])/g, '$1')

      .replace(/\(\s*\)|\[\s*\]/g, '')
      .replace(/[ \t]+$/gm, '')
      .trim()
  );
}

export function withoutIdsOrNull(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = withoutIds(text).trim();
  return cleaned.length > 0 ? cleaned : null;
}

const NOTHING =
  /^(?:unknown|unspecified|not\s+(?:specified|stated|available|applicable|given|mentioned|provided|found|readable|legible)|no(?:ne|t\s+sure)?|n\s*\/?\s*a|na|nil|null|undefined|missing|blank|empty|untitled|no\s+(?:title|text|data|value|amount|date|name|information|info)|tbd|todo|\?+|-+|–+|—+|\.+|_+)$/i;

export function withoutPlaceholders(value: string | null | undefined): string | null {
  const cleaned = withoutIdsOrNull(value);
  if (cleaned === null) return null;
  const bare = cleaned.replace(/^["'`([]+|["'`)\]]+$/g, '').trim();
  if (!bare || NOTHING.test(bare)) return null;
  return cleaned;
}

/**
 * Words that belong to the inside of this server and must never reach a screen.
 *
 * The product owner's line is that nothing developer-facing reaches a person, and the
 * riskiest place for that is a sentence a model wrote about its own work: "could not parse
 * the JSON field", "OCR returned null", "see the extraction payload". Each of those is a
 * real sentence a model has produced when a document defeated it.
 *
 * Deliberately a detector rather than a filter. Half-deleting a sentence leaves worse
 * prose than the sentence had; what the callers do with a positive answer is throw the
 * string away and use their own plain words instead.
 */
const TECHNICAL =
  /\b(?:json|schema|parse[drs]?|parsing|null|undefined|nan|api|ocr|regex|payload|field\s+(?:value|name)|string|boolean|integer|array|object|token|endpoint|request|response|error\s+code|stack\s*trace|timeout|exception|debug|backend|server\s+(?:error|side)|database|sql|query|extraction|metadata|base64|utf-?8|mime|http[s]?|status\s+code|\d{3}\s+error)\b/i;

const MACHINERY = new RegExp(
  [

    /\b(?:groq|openai|anthropic|tesseract|llm|gpt)\b/.source,
    /\b(?:gpt-oss|whisper[-\s]?large|llama-?\d|claude-\d|gemini[-\s]?(?:\d|pro|flash|nano))\b/.source,
    /\b(?:language|ai|vision|ml)\s+model\b/.source,
    /\bmodel\s+(?:name|id|version|output|reply|answer)\b/.source,
    /\b(?:ai|model|text|vision|audio)\s+provider\b/.source,
    /\b(?:computer|machine)\s+vision\b/.source,
    /\bvision\s+(?:model|call|request|pass|read)\b/.source,
    /\bwhisper\s+model\b/.source,
    /\bsystem\s+prompt\b/.source,

    /\bconfidence\b/.source,

    /\berrno\b|\bexit\s+code\b|\bstd(?:out|err)\b/.source,
    /\bE(?:NOENT|ACCES|PERM|EXIST|ISDIR|NOTDIR|MFILE|BUSY|AGAIN|PIPE|NOSPC|ROFS|CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE|HOSTUNREACH|NETUNREACH|NOTFOUND)\b/.source,

    /\b[a-z]:[\\/](?:users|windows|program|temp|tmp)\b/.source,
    /(?:^|[\s"'(])\/(?:users|home|var|tmp|etc|opt|mnt|proc|private)\//.source,
    /\bnode_modules\b|\blocalhost\b|\b127\.0\.0\.1\b|\bport\s+\d{2,5}\b/.source,
    // A digest or a checksum, which is only ever shown by accident.
    /\b(?:sha-?(?:1|256|512)|md5|checksum|digest)\b/.source,
    /\b(?=[0-9a-f]*[a-f])[0-9a-f]{32,}\b/.source,
    // Moving and measuring the bytes themselves.
    /\b(?:en|de)cod(?:e|ed|ing)\b|\bbytes\b|\bbuffer\b/.source,
  ].join('|'),
  'i',
);

export function looksTechnical(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false;
  return TECHNICAL.test(text) || MACHINERY.test(text);
}

/**
 * One line of prose, tidied: collapsed whitespace, a capital at the front, and a full stop
 * at the end if it needs one.
 *
 * Used for the sentences this server writes itself. A model's own prose is left as it is —
 * capitalising the first letter of a Hindi or Tamil sentence does nothing, and inserting a
 * full stop into a language that ends a sentence differently is worse than leaving it.
 */
export function asSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const capitalised = /^[a-z]/.test(flat) ? flat[0]!.toUpperCase() + flat.slice(1) : flat;
  return /[.!?।]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

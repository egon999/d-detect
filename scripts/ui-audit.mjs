import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ?? 'app';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const LITERAL = /'([^'\n]{20,}?)'|"([^"\n]{20,}?)"|`([^`]{20,}?)`/g;

/** Things that are 20+ characters but are not sentences a user reads. */
function isProse(text) {
  if (/^[a-z][a-z0-9-]*$/.test(text)) return false; // token / slug
  if (/^[#@/.]|^\d|^https?:/.test(text)) return false; // colour, path, url, number
  if (/^[A-Z0-9_]+$/.test(text)) return false; // constant
  if (!/\s/.test(text)) return false; // single token
  if (/[{}<>]|=>/.test(text)) return false; // embedded code
  return text.split(/\s+/).filter(Boolean).length >= 5;
}

const rows = [];
for (const file of walk(ROOT)) {
  const source = fs.readFileSync(file, 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  let words = 0;
  let strings = 0;
  let longest = 0;
  for (const match of code.matchAll(LITERAL)) {
    const text = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!isProse(text)) continue;
    const count = text.split(/\s+/).filter(Boolean).length;
    words += count;
    strings += 1;
    longest = Math.max(longest, count);
  }

  const count = (pattern) => (code.match(pattern) ?? []).length;
  rows.push({
    file: file.replace(/\\/g, '/'),
    lines: source.split('\n').length,
    words,
    strings,
    longest,
    inputs: count(/<TextInput|<Field\b|<Input\b/g),
    chips: count(/<Chip\b/g),
    toggles: count(/<Switch\b/g),
    pressables: count(/<Button\b|<Pressable\b|<TouchableOpacity\b/g),
  });
}

rows.sort((a, b) => b.words - a.words);

const pad = (value, width) => String(value).padEnd(width);
const rpad = (value, width) => String(value).padStart(width);
console.log(
  pad('screen', 46),
  rpad('lines', 5),
  rpad('words', 6),
  rpad('strs', 5),
  rpad('max', 4),
  rpad('inp', 4),
  rpad('chip', 5),
  rpad('tog', 4),
  rpad('press', 6),
);
for (const row of rows) {
  console.log(
    pad(row.file, 46),
    rpad(row.lines, 5),
    rpad(row.words, 6),
    rpad(row.strings, 5),
    rpad(row.longest, 4),
    rpad(row.inputs, 4),
    rpad(row.chips, 5),
    rpad(row.toggles, 4),
    rpad(row.pressables, 6),
  );
}

const total = rows.reduce(
  (acc, row) => ({
    words: acc.words + row.words,
    strings: acc.strings + row.strings,
    inputs: acc.inputs + row.inputs,
    chips: acc.chips + row.chips,
    pressables: acc.pressables + row.pressables,
  }),
  { words: 0, strings: 0, inputs: 0, chips: 0, pressables: 0 },
);
console.log(
  `\nTOTAL  prose words ${total.words} in ${total.strings} strings | inputs ${total.inputs} | chips ${total.chips} | pressables ${total.pressables}`,
);

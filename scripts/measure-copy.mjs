// Throwaway audit script: measures genuinely user-visible copy.
// Counts only strings in JSX text position or passed to known copy props,
// after stripping comments and template literals (which pair badly across code).
import fs from 'node:fs';
import path from 'node:path';

const COPY_PROPS = [
  'title', 'message', 'label', 'description', 'caption', 'subtitle', 'placeholder',
  'helperText', 'hint', 'emptyMessage', 'confirmLabel', 'body', 'text', 'summary',
];

const rows = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full);
      continue;
    }
    if (!entry.name.endsWith('.tsx')) continue;

    let src = fs.readFileSync(full, 'utf8');
    src = src.replace(/\/\*[\s\S]*?\*\//g, '');
    src = src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    const found = [];

    // 1. Copy props with a plain quoted string: title="..." / message={'...'}
    const propRe = new RegExp(`\\b(${COPY_PROPS.join('|')})=\\{?\\s*(['"])((?:(?!\\2)[^\\n])*)\\2`, 'g');
    for (const m of src.matchAll(propRe)) if (m[3].length >= 40) found.push(m[3]);

    // 2. Bare JSX text nodes: >Some sentence here<
    for (const m of src.matchAll(/>\s*([A-Z][^<>{}\n]{39,})\s*</g)) found.push(m[1].trim());

    if (found.length) {
      rows.push([full, found.length, found.reduce((a, s) => a + s.length, 0), found]);
    }
  }
}

walk('src');
walk('app');
rows.sort((a, b) => b[2] - a[2]);

const totalChars = rows.reduce((a, r) => a + r[2], 0);
const totalCount = rows.reduce((a, r) => a + r[1], 0);
console.log(`User-visible sentences (>=40 chars): ${totalCount} across ${rows.length} files`);
console.log(`${totalChars} chars ~= ${Math.round(totalChars / 5.5)} words of on-screen copy\n`);
console.log('Worst offenders:');
for (const [file, n, chars] of rows.slice(0, 15)) {
  console.log(`${String(chars).padStart(5)} chars ${String(n).padStart(3)} sentences  ${file}`);
}
console.log('\n--- longest individual sentences ---');
const all = rows.flatMap(([f, , , s]) => s.map((t) => [f, t]));
all.sort((a, b) => b[1].length - a[1].length);
for (const [f, t] of all.slice(0, 10)) console.log(`[${t.length}] ${f}\n    ${t}\n`);

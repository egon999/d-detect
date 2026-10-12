import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['src', 'app'];

const MIN_LENGTH = 24;

const PROSE = /[A-Za-z]{2,}\s+[A-Za-z]/;

const EXEMPT = [

  'src/ui/claims.ts',
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function literalsOf(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\
    .replace(/^\s*\/\/.*$/gm, '');

  const found = [];
  for (const match of withoutComments.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const value = match[2];
    if (value.length < MIN_LENGTH) continue;
    if (!PROSE.test(value)) continue;
    if (value.includes(':
    found.push(value.replace(/\\n/g, ' ').trim());
  }
  return found;
}

const words = (s) => s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;

const rows = [];
const everything = [];

for (const root of ROOTS) {
  for (const file of walk(join(ROOT, root))) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (EXEMPT.includes(rel)) continue;
    const strings = literalsOf(readFileSync(file, 'utf8'));
    if (strings.length === 0) continue;
    const total = strings.reduce((sum, s) => sum + words(s), 0);
    rows.push({ rel, count: strings.length, total, longest: Math.max(...strings.map((s) => s.length)) });
    for (const s of strings) everything.push({ rel, s });
  }
}

if (process.argv.includes('--strings')) {
  everything
    .sort((a, b) => b.s.length - a.s.length)
    .slice(0, 80)
    .forEach(({ rel, s }) => console.log(`${String(s.length).padStart(4)}  ${rel}\n      ${s}`));
} else {
  rows.sort((a, b) => b.total - a.total);
  console.log('words  strs  max  file');
  for (const r of rows.slice(0, 40)) {
    console.log(
      `${String(r.total).padStart(5)}  ${String(r.count).padStart(4)}  ${String(r.longest).padStart(3)}  ${r.rel}`,
    );
  }
  const totals = rows.reduce((a, r) => ({ w: a.w + r.total, s: a.s + r.count }), { w: 0, s: 0 });
  console.log(`\nTOTAL ${totals.w} words in ${totals.s} strings across ${rows.length} files`);
}

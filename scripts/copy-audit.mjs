/**
 * Copy audit — where the app's words actually live.
 *
 * `scripts/ui-audit.mjs` counts prose per *screen*, which is the right unit for judging how
 * loud a screen is but the wrong one for deciding what to cut. Most of this app's sentences
 * are not written in the screen that shows them: they come out of a label table in
 * `src/domain/enums.ts`, a helper in `src/ui/readable.ts`, or a copy block in a feature
 * component, and the screen only picks one. Cutting a screen string removes one sentence;
 * cutting a table entry removes it from every screen that reads the table.
 *
 * So this walks the whole of `src/` and `app/`, finds every string literal long enough to be
 * a sentence rather than a key, and reports by file — sorted by total words, which is the
 * number the brief is actually about ("overloaded with ... lengthy descriptions, and
 * excessive text").
 *
 * Deliberately crude in the same way the ui audit is: a regex over source, no parser. It
 * will count a long `import` path or a regex literal as prose now and then. That is fine —
 * it is a ranking tool, and the ranking is stable enough to decide what to open first.
 *
 *   node scripts/copy-audit.mjs            # top files
 *   node scripts/copy-audit.mjs --strings  # the actual sentences, longest first
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['src', 'app'];

/** Below this a literal is a key, an id, a class name or a route — not a sentence. */
const MIN_LENGTH = 24;

/** A literal with no space in it is an identifier however long it is. */
const PROSE = /[A-Za-z]{2,}\s+[A-Za-z]/;

/** Paths that hold words on purpose and must not be "reduced" by this audit. */
const EXEMPT = [
  // Every one of these is a sentence the product is legally or ethically careful about.
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

/**
 * Pulls string literals out of source, skipping comments.
 *
 * The comment skip matters more here than it would in most codebases: this one comments at
 * unusual length and those comments quote the strings they explain, so counting them would
 * double every sentence and rank the best-documented files as the noisiest.
 */
function literalsOf(source) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  const found = [];
  for (const match of withoutComments.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const value = match[2];
    if (value.length < MIN_LENGTH) continue;
    if (!PROSE.test(value)) continue;
    if (value.includes('://') || value.startsWith('@') || value.includes('  ')) continue;
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

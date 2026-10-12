import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FRESH_MS = Number(process.env.TEST_REPORT_FRESH_MINUTES ?? 5) * 60_000;

const SUITES = {
  app: {
    label: 'app (vitest)',
    cwd: REPO_ROOT,
    command: 'npx',
    args: ['vitest', 'run'],
  },
  server: {
    label: 'server (node --test)',
    cwd: join(REPO_ROOT, 'server'),
    command: 'npm',
    args: ['test'],
  },
};

const wanted = process.argv.includes('--server') ? 'server' : 'app';
const suite = SUITES[wanted];
const passthrough = process.argv.slice(2).filter((arg) => arg !== '--server');

const FAILURE_PATTERNS = [

  /(?:^|\s)FAIL\s+(\S+\.test\.[cm]?[jt]sx?)/,
  /❯\s+(\S+\.test\.[cm]?[jt]sx?)\s+\(/,

  /Error:\s+Failed to (?:load|parse|resolve).*?(\S+\.[cm]?[jt]sx?)/,

  /^not ok \d+ - (\S+\.test\.[cm]?[jt]sx?)$/,
];

function stackPaths(line) {
  const normalized = line.replace(/\\\\/g, '\\');
  const found = [];
  for (const root of [REPO_ROOT, REPO_ROOT.replace(/\\/g, '/')]) {
    for (let at = normalized.indexOf(root); at !== -1; at = normalized.indexOf(root, at + 1)) {
      const match = /^.*?\.test\.[cm]?[jt]sx?/.exec(normalized.slice(at));
      if (match !== null) found.push(match[0]);
    }
  }
  return found;
}

const DOES_NOT_PARSE = [
  'Failed to parse',
  'Failed to load',
  'Failed to resolve import',
  'Transform failed',
  'SyntaxError',
  'Unexpected token',
  'Cannot find module',
  'does not provide an export named',
  'No test suite found',
];

const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '/index.ts', '/index.tsx'];

const ALIASES = [
  [/^@domain\//, 'src/domain/'],
  [/^@data\//, 'src/data/'],
  [/^@ui\//, 'src/ui/'],
  [/^@features\//, 'src/features/'],
  [/^@services\//, 'src/services/'],
  [/^@api\//, 'src/api/'],
  [/^@\//, 'src/'],
  [/^@ui$/, 'src/ui/index.ts'],
  [/^@services$/, 'src/services/index.ts'],
  [/^@api$/, 'src/api/index.ts'],
];

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function resolveSpecifier(specifier, fromFile) {
  let candidate = null;
  if (specifier.startsWith('.')) {
    candidate = resolve(dirname(fromFile), specifier);
  } else {
    for (const [pattern, replacement] of ALIASES) {
      if (pattern.test(specifier)) {
        candidate = join(suite.cwd, specifier.replace(pattern, replacement));
        break;
      }
    }
  }
  if (candidate === null) return null;
  for (const extension of RESOLVE_EXTENSIONS) {
    const attempt = candidate.replace(/\.ts$/, '') + extension;
    if (existsSync(attempt) && statSync(attempt).isFile()) return attempt;
  }
  return existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
}

function newestImport(testFile) {
  let source;
  try {
    source = readFileSync(testFile, 'utf8');
  } catch {
    return null;
  }
  let newest = null;
  const specifiers = source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g);
  for (const [, specifier] of specifiers) {
    const path = resolveSpecifier(specifier, testFile);
    if (path === null) continue;
    const at = mtimeOf(path);
    if (at !== null && (newest === null || at > newest.at)) newest = { at, path };
  }
  return newest;
}

function ago(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function collectFailures(output) {
  const files = new Set();

  let inFailure = false;
  for (const line of output.split(/\r?\n/)) {
    for (const pattern of FAILURE_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1] !== undefined) files.add(match[1]);
    }
    if (/^\s*not ok \d+/.test(line)) {
      inFailure = true;
      continue;
    }
    if (/^\s*ok \d+/.test(line) || /^\s*\d+\.\.\d+/.test(line)) {
      inFailure = false;
      continue;
    }
    if (inFailure) {
      for (const path of stackPaths(line)) files.add(path);
    }
  }
  return [...files];
}

function report(output) {
  const failures = collectFailures(output);
  const parseFailure = DOES_NOT_PARSE.some((phrase) => output.includes(phrase));
  const now = Date.now();

  const line = '─'.repeat(72);
  console.log(`\n${line}`);
  if (failures.length === 0) {
    console.log(`is this red yours?  no failing files named by the ${suite.label} run.`);
    if (parseFailure) {
      console.log('  a file failed to parse or resolve, but the runner did not name it — read the');
      console.log('  output above. A file that does not parse is almost always mid-edit.');
    }
    console.log(line);
    return;
  }

  console.log(`is this red yours?  ${failures.length} file${failures.length === 1 ? '' : 's'} named by the ${suite.label} run`);
  console.log(line);

  const rows = failures.map((named) => {
    const path = isAbsolute(named) ? named : join(suite.cwd, named);
    const own = mtimeOf(path);
    const dependency = newestImport(path);
    const freshest = Math.max(own ?? 0, dependency?.at ?? 0);
    return { named, own, dependency, freshest };
  });
  rows.sort((a, b) => b.freshest - a.freshest);

  let settled = 0;
  for (const row of rows) {
    const shown = isAbsolute(row.named) ? relative(suite.cwd, row.named) : row.named;
    console.log(`\n  ${shown}`);
    if (row.own === null) {
      console.log('    the runner named a file that is not on disk — it was deleted or renamed');
      console.log('    while the run was going. Run again.');
      continue;
    }
    const ownAge = now - row.own;
    if (ownAge < FRESH_MS) {
      console.log(`    the test itself was saved ${ago(ownAge)} — somebody is editing it now, so this`);
      console.log('    failure is a snapshot of an unfinished thought. Run again before reading it.');
      continue;
    }
    const dependencyAge = row.dependency === null ? Infinity : now - row.dependency.at;
    if (dependencyAge < FRESH_MS) {
      const changed = relative(suite.cwd, row.dependency.path);
      console.log(`    the test is ${ago(ownAge)}, but ${changed}`);
      console.log(`    which it imports was saved ${ago(dependencyAge)}. The red is the code under`);
      console.log('    test moving, not the assertion. Run again before reading it.');
      continue;
    }
    settled += 1;
    console.log(`    nothing here has changed recently — the test is ${ago(ownAge)} and so is what it`);
    console.log('    imports. Read this one: it is a real failure.');
  }

  console.log(`\n${line}`);
  console.log(
    settled === 0
      ? '  none of this red is settled. Every failing file, or something it imports, was written in'
      : `  ${settled} of ${rows.length} failing file${rows.length === 1 ? '' : 's'} ${settled === 1 ? 'is' : 'are'} settled enough to believe.`,
  );
  if (settled === 0) {
    console.log(`  the last ${Math.round(FRESH_MS / 60_000)} minutes. Run again before changing anything.`);
  }
  console.log(`  nothing was hidden and nothing was excused: the exit code below is the runner's own.`);
  console.log(line);
}

const child = spawn(suite.command, [...suite.args, ...passthrough], {
  cwd: suite.cwd,
  shell: process.platform === 'win32',
  env: process.env,
});

let captured = '';
child.stdout.on('data', (chunk) => {
  captured += chunk;
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  captured += chunk;
  process.stderr.write(chunk);
});

child.on('error', (error) => {
  console.error(`could not start the ${suite.label} run: ${error.message}`);
  process.exit(1);
});

child.on('close', (code, signal) => {
  try {
    report(captured);
  } catch (error) {

    console.error(`\n(could not attribute the failures: ${error.message})`);
  }

  process.exit(code === null ? 1 : code === 0 && signal ? 1 : code);
});

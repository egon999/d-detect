#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const children = [
  spawn('npm', ['run', 'dev'], { cwd: join(root, 'server'), stdio: 'inherit', shell: true }),
  spawn('npx', ['expo', 'start', '--web'], { cwd: root, stdio: 'inherit', shell: true }),
];

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {

    }
  }
}

for (const child of children) {
  child.on('exit', () => {
    shutdown();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import { serve } from '@hono/node-server';
import { app } from './app.ts';
import { db } from './db.ts';
import { config, configGapsDetail } from './env.ts';
import { pruneFinishedJobs, recoverInterruptedWork } from './recovery.ts';
import { resumeInterruptedReads, staleReadSweep } from './routes/daybook.ts';
import { resumeInterruptedItems } from './routes/cases.ts';

for (const gap of configGapsDetail()) console.warn(`[detact] ${gap}`);
const recovered = recoverInterruptedWork();
if (recovered.jobs > 0) console.warn('[detact] recovered interrupted work', recovered);

const resumed = resumeInterruptedReads();
if (resumed > 0) console.warn('[detact] resumed interrupted reads', resumed);

const resumedItems = resumeInterruptedItems();
if (resumedItems > 0) console.warn('[detact] resumed interrupted evidence reads', resumedItems);
pruneFinishedJobs();

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[detact] server on http://${config.host}:${info.port}`);
});

function shutdown() {

  clearInterval(staleReadSweep);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
export { app };

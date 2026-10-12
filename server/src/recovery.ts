import { db } from './db.ts';
import type { Facts } from './facts.ts';

const EMPTY_FACTS: Facts = { amounts: [], dates: [], references: [], statuses: [] };

const INTERRUPTED = 'Reading this was interrupted when the server restarted. Try again.';

export type RecoverySummary = {
  records: number;
  caseItems: number;
  jobs: number;
};

export function recoverInterruptedWork(): RecoverySummary {
  const now = Date.now();

  const settle = db.transaction((): RecoverySummary => {
    const records = db
      .prepare(
        `UPDATE records SET status = 'failed', note = COALESCE(note, ?), updated_at = ?
         WHERE status = 'processing'`,
      )
      .run(INTERRUPTED, now).changes;

    const caseItems = db
      .prepare(
        `UPDATE case_items SET status = 'failed', extraction = ?
         WHERE status IN ('pending', 'reading')`,
      )
      .run(JSON.stringify({ readNote: INTERRUPTED, sourceText: '', facts: EMPTY_FACTS })).changes;

    const jobs = db
      .prepare(
        `UPDATE jobs SET status = 'failed', detail = COALESCE(detail, ?), updated_at = ?
         WHERE status NOT IN ('done', 'failed', 'cancelled')`,
      )
      .run(INTERRUPTED, now).changes;

    return { records, caseItems, jobs };
  });

  return settle();
}

export function pruneFinishedJobs(olderThanMs = 7 * 24 * 60 * 60_000): number {
  return db
    .prepare(`DELETE FROM jobs WHERE status IN ('done', 'failed', 'cancelled') AND updated_at < ?`)
    .run(Date.now() - olderThanMs).changes;
}

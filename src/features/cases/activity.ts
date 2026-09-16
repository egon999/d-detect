import type { ProcessingJob, Workspace } from '@domain/models';

export interface CaseActivity {
  id: string;
  caseId: string;
  caseTitle: string;
  evidenceId: string | null;
  title: string;
  detail: string;
  time: number;
  failed: boolean;
}

function jobTitle(job: ProcessingJob): string {
  const subject = job.evidenceId ? 'Evidence processing' : 'Case analysis';
  const states: Partial<Record<ProcessingJob['state'], string>> = {
    QUEUED: 'queued', PROCESSING: 'in progress', EXTRACTED: 'completed', ANALYZED: 'completed', FAILED: 'failed', REVIEW_REQUIRED: 'needs review',
  };
  return `${subject} ${states[job.state] ?? job.state.toLowerCase().replaceAll('_', ' ')}`;
}

/** Activity records show persisted actions and jobs, not inferred unread notifications. */
export function caseActivity(ownerId: string, workspace: Workspace): CaseActivity[] {
  const cases = new Map(workspace.cases.filter((item) => item.ownerId === ownerId && !item.deletedAt).map((item) => [item.id, item]));
  const evidence = new Map(workspace.evidence.filter((item) => item.ownerId === ownerId && !item.deletedAt).map((item) => [item.id, item]));
  const jobs = workspace.processingJobs.filter((item) => item.ownerId === ownerId && cases.has(item.caseId) && (!item.evidenceId || evidence.has(item.evidenceId)));
  const jobIds = new Set(jobs.map((item) => item.id));
  const activity: CaseActivity[] = jobs.map((job) => ({
    id: `job:${job.id}`, caseId: job.caseId, caseTitle: cases.get(job.caseId)!.title, evidenceId: job.evidenceId,
    title: jobTitle(job), detail: job.lastError ?? (job.evidenceId ? evidence.get(job.evidenceId)?.title ?? '' : 'Open the case to inspect its saved review.'),
    time: job.finishedAt ?? job.updatedAt, failed: job.state === 'FAILED',
  }));
  for (const entry of workspace.auditLogs) {
    if (entry.ownerId !== ownerId || !cases.has(entry.caseId) || (entry.metadata.jobId && jobIds.has(entry.metadata.jobId))) continue;
    const source = entry.entityRefs.find((item) => item.kind === 'evidence' && evidence.has(item.id));
    activity.push({ id: `audit:${entry.id}`, caseId: entry.caseId, caseTitle: cases.get(entry.caseId)!.title, evidenceId: source?.id ?? null, title: entry.summary, detail: '', time: entry.createdAt, failed: false });
  }
  return activity.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
}

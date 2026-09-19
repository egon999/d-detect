/**
 * The Event Nexus: Multi-Modal Chronological Replay.
 *
 * Unifies diverse evidentiary artifacts along a continuous, scrubbable temporal axis:
 * - Documents, scanned invoices, audio recordings with transcript timing, and manual events.
 * - Synchronizes multi-source facts to replay what happened when, with conflict markers.
 */

import type { CaseEvent, Evidence, Workspace } from '@domain/models';
import { daysBetween, normalizeDate, type NormalizedDate } from '@domain/normalize/dates';

export type NexusArtifactKind = 'EVENT' | 'DOCUMENT' | 'AUDIO' | 'IMAGE' | 'PAYMENT' | 'COMMUNICATION';

export interface NexusArtifact {
  id: string;
  kind: NexusArtifactKind;
  title: string;
  subtitle?: string;
  timestampMs: number;
  dateStr: string;
  sourceId: string;
  sourceTitle: string;
  previewText?: string;
  hasConflict: boolean;
  conflictDetails?: string;
  mediaUri?: string;
  playbackStartMs?: number;
  playbackEndMs?: number;
}

export interface NexusTemporalCluster {
  dateIso: string;
  displayDate: string;
  artifacts: NexusArtifact[];
  hasConflict: boolean;
}

export interface EventNexusReplay {
  caseId: string;
  totalArtifacts: number;
  earliestDate: string | null;
  latestDate: string | null;
  spanDays: number;
  clusters: NexusTemporalCluster[];
  allArtifacts: NexusArtifact[];
  conflictingTimestamps: number[];
}

function parseIsoToTimestamp(iso: string): number {
  try {
    const parts = iso.split('-');
    const year = parseInt(parts[0] ?? '2026', 10);
    const month = parseInt(parts[1] ?? '1', 10) - 1;
    const day = parseInt(parts[2] ?? '1', 10);
    return new Date(Date.UTC(year, month, day)).getTime();
  } catch {
    return 0;
  }
}

export function buildEventNexus(workspace: Workspace, caseId: string): EventNexusReplay {
  const cId = caseId;
  const events = workspace.events.filter((e) => e.caseId === cId && !e.deletedAt);
  const evidenceList = workspace.evidence.filter((e) => e.caseId === cId && !e.deletedAt);
  const analysisResults = workspace.analysisResults.filter((a) => a.caseId === cId);

  const artifacts: NexusArtifact[] = [];

  // 1. Ingest Case Events
  for (const ev of events) {
    const rawDate = ev.occurredAt?.iso ?? (ev as any).date;
    if (!rawDate || typeof rawDate !== 'string') continue;
    const norm = normalizeDate(rawDate);
    if (!norm.iso) continue;
    const ts = parseIsoToTimestamp(norm.iso);
    const conflict = analysisResults.find(
      (a) => a.resultType === 'POSSIBLE_CONFLICT' && a.relatedEventIds.includes(ev.id)
    );

    artifacts.push({
      id: `nexus_ev_${ev.id}`,
      kind: 'EVENT',
      title: ev.title,
      subtitle: ev.description || undefined,
      timestampMs: ts,
      dateStr: norm.iso,
      sourceId: ev.id,
      sourceTitle: ev.title,
      previewText: ev.description,
      hasConflict: Boolean(conflict),
      conflictDetails: conflict?.explanation,
    });
  }

  // 2. Ingest Evidence Documents & Audio with Extracted Dates
  for (const evd of evidenceList) {
    const extraction = evd.extraction;
    let artifactKind: NexusArtifactKind = 'DOCUMENT';
    if (evd.kind === 'AUDIO') artifactKind = 'AUDIO';
    else if (evd.kind === 'IMAGE') artifactKind = 'IMAGE';
    else if (evd.kind === 'EMAIL') artifactKind = 'COMMUNICATION';

    const conflict = analysisResults.find(
      (a) => a.resultType === 'POSSIBLE_CONFLICT' && a.supportingEvidenceIds.includes(evd.id)
    );

    if (extraction && extraction.dates.length > 0) {
      for (const d of extraction.dates) {
        if (!d.iso) continue;
        const ts = parseIsoToTimestamp(d.iso);
        artifacts.push({
          id: `nexus_evd_${evd.id}_${d.iso}`,
          kind: artifactKind,
          title: evd.title,
          subtitle: `Mentioned date: ${d.original}`,
          timestampMs: ts,
          dateStr: d.iso,
          sourceId: evd.id,
          sourceTitle: evd.title,
          previewText: extraction.segments[0]?.text?.slice(0, 150),
          hasConflict: Boolean(conflict),
          conflictDetails: conflict?.explanation,
          mediaUri: evd.storagePath || undefined,
        });
      }
    } else {
      // Use record creation date if no explicit date extracted
      const fallbackIso = new Date(evd.createdAt).toISOString().slice(0, 10);
      artifacts.push({
        id: `nexus_evd_created_${evd.id}`,
        kind: artifactKind,
        title: evd.title,
        subtitle: 'Recorded into workspace',
        timestampMs: evd.createdAt,
        dateStr: fallbackIso,
        sourceId: evd.id,
        sourceTitle: evd.title,
        previewText: extraction?.segments[0]?.text?.slice(0, 150),
        hasConflict: Boolean(conflict),
        conflictDetails: conflict?.explanation,
        mediaUri: evd.storagePath || undefined,
      });
    }
  }

  // 3. Sort chronologically
  artifacts.sort((a, b) => a.timestampMs - b.timestampMs);

  // 4. Cluster by Date
  const clusterMap = new Map<string, NexusArtifact[]>();
  for (const item of artifacts) {
    const existing = clusterMap.get(item.dateStr) ?? [];
    existing.push(item);
    clusterMap.set(item.dateStr, existing);
  }

  const clusters: NexusTemporalCluster[] = Array.from(clusterMap.entries()).map(([dateIso, clusterArtifacts]) => ({
    dateIso,
    displayDate: dateIso,
    artifacts: clusterArtifacts,
    hasConflict: clusterArtifacts.some((a) => a.hasConflict),
  }));

  const earliestDate = clusters[0]?.dateIso ?? null;
  const latestDate = clusters[clusters.length - 1]?.dateIso ?? null;
  let spanDays = 0;
  if (earliestDate && latestDate) {
    spanDays = daysBetween(normalizeDate(earliestDate), normalizeDate(latestDate)) ?? 0;
  }

  const conflictingTimestamps = artifacts.filter((a) => a.hasConflict).map((a) => a.timestampMs);

  return {
    caseId,
    totalArtifacts: artifacts.length,
    earliestDate,
    latestDate,
    spanDays,
    clusters,
    allArtifacts: artifacts,
    conflictingTimestamps,
  };
}

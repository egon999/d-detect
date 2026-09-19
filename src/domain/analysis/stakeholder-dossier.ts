/**
 * Stakeholder Directory & Communication Dossier Engine.
 *
 * Consolidates all counterparties, witnesses, organizations, and authorities
 * across case evidence, calculating consistency ratings, communication frequency,
 * and adversarial postures.
 */

import type { CaseParticipant, Workspace } from '../models';

export type StakeholderSentiment = 'COOPERATIVE' | 'NEUTRAL' | 'ADVERSARIAL' | 'EVASIVE';

export interface StakeholderProfile {
  id: string;
  name: string;
  role: string;
  entityType: 'PERSON' | 'ORGANIZATION' | 'AUTHORITY';
  email?: string;
  phone?: string;
  totalMentionsCount: number;
  contradictionsInvolved: number;
  corroborationsInvolved: number;
  credibilityScorePercent: number;
  communicationCount: number;
  sentiment: StakeholderSentiment;
  evidenceSourceTitles: string[];
}

export interface StakeholderDossierSummary {
  caseId: string;
  stakeholders: StakeholderProfile[];
  primaryCounterparty: StakeholderProfile | null;
  adversarialCount: number;
}

/**
 * Builds the Stakeholder Dossier for a case in the workspace.
 */
export function buildStakeholderDossier(workspace: Workspace, caseId: string): StakeholderDossierSummary {
  const caseRecord = workspace.cases.find((c) => c.id === caseId);
  const evidenceList = workspace.evidence.filter((e) => e.caseId === caseId && !e.deletedAt);
  const analysis = workspace.caseAnalyses
    .filter((a) => a.caseId === caseId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  const profilesMap = new Map<string, StakeholderProfile>();

  // 1. Ingest explicit case participants
  for (const p of caseRecord?.participants ?? []) {
    const key = p.name.trim().toLowerCase();
    if (!key) continue;

    const roleLower = (p.role ?? '').toLowerCase();
    const nameLower = p.name.toLowerCase();
    const isOrg =
      roleLower.includes('company') ||
      roleLower.includes('llc') ||
      roleLower.includes('corp') ||
      roleLower.includes('inc') ||
      roleLower.includes('management') ||
      roleLower.includes('agency') ||
      nameLower.includes('llc') ||
      nameLower.includes('inc') ||
      nameLower.includes('corp') ||
      nameLower.includes('company') ||
      nameLower.includes('management');

    profilesMap.set(key, {
      id: p.id,
      name: p.name.trim(),
      role: p.role?.trim() || 'Participant',
      entityType: isOrg ? 'ORGANIZATION' : 'PERSON',
      totalMentionsCount: 1,
      contradictionsInvolved: 0,
      corroborationsInvolved: 0,
      credibilityScorePercent: 85,
      communicationCount: 0,
      sentiment: 'NEUTRAL',
      evidenceSourceTitles: [],
    });
  }

  // 2. Scan extracted entities across all evidence
  for (const evd of evidenceList) {
    const ext = evd.extraction;
    if (!ext) continue;

    // Scan organizations
    for (const org of ext.organizations ?? []) {
      const key = (org.normalized || org.original).trim().toLowerCase();
      if (!key) continue;

      if (!profilesMap.has(key)) {
        profilesMap.set(key, {
          id: `party_org_${org.evidenceId}_${key.slice(0, 10)}`,
          name: org.normalized || org.original,
          role: 'Organization / Counterparty',
          entityType: 'ORGANIZATION',
          totalMentionsCount: 0,
          contradictionsInvolved: 0,
          corroborationsInvolved: 0,
          credibilityScorePercent: 80,
          communicationCount: 0,
          sentiment: 'NEUTRAL',
          evidenceSourceTitles: [],
        });
      }
      const existing = profilesMap.get(key)!;
      existing.totalMentionsCount += 1;
      if (!existing.evidenceSourceTitles.includes(evd.title)) {
        existing.evidenceSourceTitles.push(evd.title);
      }
    }

    // Scan people
    for (const person of ext.people ?? []) {
      const key = (person.normalized || person.original).trim().toLowerCase();
      if (!key) continue;

      if (!profilesMap.has(key)) {
        profilesMap.set(key, {
          id: `party_person_${person.evidenceId}_${key.slice(0, 10)}`,
          name: person.normalized || person.original,
          role: 'Named Individual',
          entityType: 'PERSON',
          totalMentionsCount: 0,
          contradictionsInvolved: 0,
          corroborationsInvolved: 0,
          credibilityScorePercent: 85,
          communicationCount: 0,
          sentiment: 'NEUTRAL',
          evidenceSourceTitles: [],
        });
      }
      const existing = profilesMap.get(key)!;
      existing.totalMentionsCount += 1;
      if (!existing.evidenceSourceTitles.includes(evd.title)) {
        existing.evidenceSourceTitles.push(evd.title);
      }
    }

    // Scan emails / phones
    if (ext.emails?.length) {
      for (const email of ext.emails) {
        const emailLower = email.original.toLowerCase();
        let matched = false;
        for (const p of profilesMap.values()) {
          const words = p.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
          if (words.some((w) => emailLower.includes(w))) {
            p.email = email.original;
            matched = true;
            break;
          }
        }
        if (!matched) {
          for (const p of profilesMap.values()) {
            if (p.evidenceSourceTitles.includes(evd.title) && !p.email) {
              p.email = email.original;
              break;
            }
          }
        }
      }
    }
    if (ext.phones?.length) {
      for (const phone of ext.phones) {
        const orgProfile = Array.from(profilesMap.values()).find(
          (p) => p.evidenceSourceTitles.includes(evd.title) && p.entityType === 'ORGANIZATION' && !p.phone,
        );
        if (orgProfile) {
          orgProfile.phone = phone.original;
        } else {
          for (const p of profilesMap.values()) {
            if (p.evidenceSourceTitles.includes(evd.title) && !p.phone) {
              p.phone = phone.original;
              break;
            }
          }
        }
      }
    }
  }

  // 3. Correlate with contradictions & claims
  const contradictions = analysis?.contradictions ?? [];
  for (const item of contradictions) {
    const text = item.statement.toLowerCase();
    for (const [key, profile] of profilesMap.entries()) {
      if (text.includes(key)) {
        profile.contradictionsInvolved += 1;
        profile.credibilityScorePercent = Math.max(30, profile.credibilityScorePercent - 20);
        profile.sentiment = 'ADVERSARIAL';
      }
    }
  }

  // Sort profiles by mentions and contradictions
  const stakeholders = Array.from(profilesMap.values()).sort(
    (a, b) => b.totalMentionsCount - a.totalMentionsCount || b.contradictionsInvolved - a.contradictionsInvolved,
  );

  // Identify primary counterparty
  const primaryCounterparty =
    stakeholders.find((s) => s.sentiment === 'ADVERSARIAL') ??
    stakeholders.find((s) => s.role.toLowerCase().includes('counterparty') || s.role.toLowerCase().includes('respondent')) ??
    stakeholders[0] ??
    null;

  const adversarialCount = stakeholders.filter((s) => s.sentiment === 'ADVERSARIAL' || s.sentiment === 'EVASIVE').length;

  return {
    caseId,
    stakeholders,
    primaryCounterparty,
    adversarialCount,
  };
}

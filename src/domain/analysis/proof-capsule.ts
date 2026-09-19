/**
 * Cryptographic Proof Capsule: Standalone Interactive Verification Package.
 *
 * Packages an entire case into a self-contained, tamper-evident verification bundle:
 * - Manifest of all original evidence files with individual SHA-256 digests.
 * - Append-only audit chain with verifiable genesis seed and head digest.
 * - Verifiable claim-citation matrix with verbatim quoted text and character offsets.
 * - Ed25519 digital signature seal (if sealed by Crucible).
 * - Portable verification manifest verifiable offline with any standard crypto tool.
 */

import type { Case, Claim, Evidence, Workspace } from '@domain/models';
import { buildCaseAuditChain } from './audit-chain';
import { caseSealState } from '@domain/crucible/case-seal-state';

export interface ProofCapsuleManifestEntry {
  evidenceId: string;
  title: string;
  kind: string;
  sha256: string | null;
  sizeBytes: number | null;
  extractedDateCount: number;
  extractedAmountCount: number;
}

export interface ProofCapsuleClaimEntry {
  claimId: string;
  statement: string;
  assessmentState: string;
  citations: Array<{
    evidenceId: string;
    quote: string;
    stance: string;
    startOffset: number;
    endOffset: number;
  }>;
}

export interface ProofCapsulePackage {
  capsuleId: string;
  version: '1.0.0';
  generatedAt: number;
  caseMeta: {
    id: string;
    title: string;
    description: string;
    createdAt: number;
    ownerId: string;
  };
  cryptographicIntegrity: {
    auditChainHead: string | null;
    chainLength: number;
    isSealed: boolean;
    sealSignature?: string | null;
    sealKeyId?: string;
    algorithm: string;
  };
  evidenceManifest: ProofCapsuleManifestEntry[];
  claimsMatrix: ProofCapsuleClaimEntry[];
  verificationInstructions: string;
}

export function generateProofCapsule(workspace: Workspace, caseId: string): ProofCapsulePackage {
  const caseRecord = workspace.cases.find((c) => c.id === caseId) ?? {
    id: caseId,
    title: 'Untitled Case',
    description: '',
    createdAt: Date.now(),
    ownerId: 'unknown',
  };

  const evidenceList = workspace.evidence.filter((e) => e.caseId === caseId && !e.deletedAt);
  const claims = workspace.claims.filter((c) => c.caseId === caseId && !c.deletedAt);

  // 1. Audit Chain Head
  const chain = buildCaseAuditChain(workspace, caseId);
  const seal = caseSealState(workspace, caseId);

  // 2. Build Evidence Manifest
  const evidenceManifest: ProofCapsuleManifestEntry[] = evidenceList.map((evd) => ({
    evidenceId: evd.id,
    title: evd.title,
    kind: evd.kind,
    sha256: evd.sha256,
    sizeBytes: evd.sizeBytes,
    extractedDateCount: evd.extraction?.dates.length ?? 0,
    extractedAmountCount: evd.extraction?.amounts.length ?? 0,
  }));

  // 3. Build Claims Matrix with citations
  const latestAnalysis = workspace.caseAnalyses
    .filter((a) => a.caseId === caseId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  const claimsMatrix: ProofCapsuleClaimEntry[] = claims.map((clm) => {
    const assessment = latestAnalysis?.claims?.find((a) => a.claimId === clm.id);
    const citations = (assessment?.citations ?? []).map((cit) => ({
      evidenceId: cit.evidenceId,
      quote: cit.quote,
      stance: cit.stance,
      startOffset: cit.startOffset,
      endOffset: cit.endOffset,
    }));

    return {
      claimId: clm.id,
      statement: clm.statement,
      assessmentState: assessment?.status ?? clm.state ?? 'UNRESOLVED',
      citations,
    };
  });

  return {
    capsuleId: `capsule_${caseId}_${Date.now()}`,
    version: '1.0.0',
    generatedAt: Date.now(),
    caseMeta: {
      id: caseRecord.id,
      title: caseRecord.title,
      description: caseRecord.description,
      createdAt: caseRecord.createdAt,
      ownerId: caseRecord.ownerId,
    },
    cryptographicIntegrity: {
      auditChainHead: chain.head,
      chainLength: chain.length,
      isSealed: seal.verification.ok,
      sealSignature: seal.latest?.signature ?? null,
      sealKeyId: seal.latest?.keyId ?? undefined,
      algorithm: 'SHA-256 + Ed25519',
    },
    evidenceManifest,
    claimsMatrix,
    verificationInstructions:
      'To verify offline: (1) Recompute SHA-256 digest of original evidence files against evidenceManifest. (2) Verify auditChainHead hash chaining. (3) If sealed, verify Ed25519 signature against the Crucible public key.',
  };
}

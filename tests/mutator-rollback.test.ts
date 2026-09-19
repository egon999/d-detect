import { describe, expect, it, vi } from 'vitest';
import { userProfileSchema, emptyWorkspace, type Workspace, type AIExtractionSuggestion } from '../src/domain/models';
import { reviewAiSuggestion, createClaim, type MutationContext } from '../src/data/mutations';

describe('UserProfile claimant identity schema', () => {
  it('validates a complete claimant profile with name, phone, and address', () => {
    const profile = userProfileSchema.parse({
      id: 'usr_claimant_1',
      ownerId: 'usr_claimant_1',
      email: 'claimant@example.test',
      displayName: 'Aditi Verma',
      phone: '+91 98765 43210',
      address: '42 MG Road, Bengaluru, Karnataka, 560001',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });

    expect(profile.displayName).toBe('Aditi Verma');
    expect(profile.phone).toBe('+91 98765 43210');
    expect(profile.address).toBe('42 MG Road, Bengaluru, Karnataka, 560001');
  });

  it('allows optional phone and address to be omitted', () => {
    const profile = userProfileSchema.parse({
      id: 'usr_claimant_2',
      ownerId: 'usr_claimant_2',
      email: 'minimal@example.test',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });

    expect(profile.displayName).toBe('');
    expect(profile.phone).toBeUndefined();
    expect(profile.address).toBeUndefined();
  });
});

describe('AI suggestion review and relationship creation', () => {
  const context: MutationContext = {
    ownerId: 'usr_1',
    now: 1700000000000,
  };

  it('creates concrete relationship when RELATIONSHIP suggestion is accepted', () => {
    const ws: Workspace = {
      ...emptyWorkspace(),
      cases: [
        {
          id: 'case_1',
          ownerId: 'usr_1',
          title: 'Dispute',
          description: '',
          category: '',
          status: 'OPEN',
          priority: 'NORMAL',
          participants: [],
          tags: [],
          incidentDate: null,
          lastAnalyzedAt: null,
          deletedAt: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      ],
      claims: [
        {
          id: 'claim_1',
          ownerId: 'usr_1',
          caseId: 'case_1',
          statement: 'Invoice is unpaid',
          detail: '',
          state: 'SUPPORTED',
          requiredEventIds: [],
          deletedAt: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      ],
      evidence: [
        {
          id: 'ev_1',
          ownerId: 'usr_1',
          caseId: 'case_1',
          title: 'Bank Statement',
          kind: 'DOCUMENT',
          state: 'CONFIRMED',
          storagePath: 'paths/statement.pdf',
          fileName: 'statement.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          sha256: 'a'.repeat(64),
          note: '',
          extraction: null,
          confirmedFields: {},
          confirmedAt: null,
          failureReason: null,
          deletedAt: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      ],
      aiSuggestions: [
        {
          id: 'sug_rel_1',
          ownerId: 'usr_1',
          caseId: 'case_1',
          evidenceId: 'ev_1',
          kind: 'RELATIONSHIP',
          status: 'SUGGESTED',
          confidence: 0.88,
          model: 'groq/llama',
          promptVersion: 'v1',
          summary: 'Connects statement to unpaid invoice claim',
          payload: {
            targetKind: 'claim',
            targetId: 'claim_1',
            relationshipType: 'SUPPORTS',
          },
          sourceEvidenceIds: ['ev_1'],
          reviewedAt: null,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
      ],
    };

    const result = reviewAiSuggestion(ws, context, 'sug_rel_1', 'ACCEPTED');
    expect(result.workspace.relationships).toHaveLength(1);
    expect(result.workspace.relationships[0]?.from.id).toBe('ev_1');
    expect(result.workspace.relationships[0]?.to.id).toBe('claim_1');
    expect(result.workspace.relationships[0]?.type).toBe('SUPPORTS');

    // Accepting again does not create duplicate relationship
    const secondPass = reviewAiSuggestion(result.workspace, context, 'sug_rel_1', 'ACCEPTED');
    expect(secondPass.workspace.relationships).toHaveLength(1);
  });
});

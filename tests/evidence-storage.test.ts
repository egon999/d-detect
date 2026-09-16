import { describe, expect, it } from 'vitest';
import { evidenceStoragePath, isEvidenceFileError, readStoredEvidenceFile, validatePrivateEvidencePath } from '../src/services/storage/evidence-storage';
describe('private evidence object paths', () => {
  it('does not disclose the original sensitive filename in a storage path', () => {
    expect(evidenceStoragePath('user_test', 'case_test', 'evd_test', 'Private report.PDF')).toBe('users/user_test/cases/case_test/evd_test/original.pdf');
  });
  it('rejects owners, cases or evidence identifiers containing path traversal', () => {
    expect(() => evidenceStoragePath('../other', 'case_test', 'evd_test', 'a.pdf')).toThrow();
    expect(() => evidenceStoragePath('user_test', '../other', 'evd_test', 'a.pdf')).toThrow();
  });
  it('rejects public URLs and another account before any file download', () => {
    expect(() => validatePrivateEvidencePath('https://public.example/private.pdf', 'user_test')).toThrow();
    expect(() => validatePrivateEvidencePath('users/user_other/cases/case_test/evd_test/original.pdf', 'user_test')).toThrow();
  });
  it('validates every segment of an owned private path', () => {
    const path = 'users/user_test/cases/case_test/evd_test/original.pdf';
    expect(validatePrivateEvidencePath(path, 'user_test')).toBe(path);
    expect(() => validatePrivateEvidencePath('users/user_test/cases/../evd_test/original.pdf', 'user_test')).toThrow();
    expect(() => validatePrivateEvidencePath('users/user_test/cases/case_test/evd_test/../../secret', 'user_test')).toThrow();
  });
});

describe('readStoredEvidenceFile', () => {
  it('rejects another account before touching any store', async () => {
    // The ownership check is what a corrupted or tampered database row meets first —
    // before any filesystem or IndexedDB access — so it must hold in plain Node too.
    await expect(
      readStoredEvidenceFile('user_test', 'users/user_other/cases/case_test/evd_test/original.pdf'),
    ).rejects.toThrow(/does not belong to the signed-in account/);
  });

  it('rejects a malformed path for the right owner', async () => {
    await expect(readStoredEvidenceFile('user_test', 'not-a-private-path')).rejects.toThrow(/does not belong/);
    await expect(
      readStoredEvidenceFile('user_test', 'users/user_test/cases/case_test/evd_test/../../secret'),
    ).rejects.toThrow(/does not belong/);
  });
});

/**
 * Which failures carry a message a person can be shown.
 *
 * `case-analysis.ts` persists this module's message into the evidence row's `failureReason`,
 * which is stored in the workspace and rendered on the analysis panel. That is only safe for
 * the sentences written here; the rest of what can escape — IndexedDB's `DOMException`, an
 * `expo-file-system` error quoting the absolute URI, zod's JSON dump of the rejected id —
 * would put an identifier on a reader's screen. The tag is what separates the two.
 */
describe('failures that are safe to show', () => {
  const identifierShaped = /\{|\[|"code"|file:\/\/|users\/user_/;

  it('tags the ownership refusal, so a caller can tell it apart from a foreign error', () => {
    try {
      validatePrivateEvidencePath('users/user_other/cases/case_test/evd_test/original.pdf', 'user_test');
      expect.unreachable('the path is not this account’s');
    } catch (error) {
      expect(isEvidenceFileError(error)).toBe(true);
    }
  });

  it('reports a segment zod rejects as a sentence, not as a JSON dump of the bad id', () => {
    // The regression. `idSchema.parse` was called bare, so a path of the right shape holding a
    // malformed id threw a `ZodError` whose `message` is an array of issue objects with the
    // offending value quoted inside it — and that message was written to a visible field.
    try {
      validatePrivateEvidencePath('users/user_test/cases/../evd_test/original.pdf', 'user_test');
      expect.unreachable('a traversal segment must be refused');
    } catch (error) {
      expect(isEvidenceFileError(error)).toBe(true);
      expect((error as Error).message).toBe('This evidence file does not belong to the signed-in account.');
      expect((error as Error).message).not.toMatch(identifierShaped);
    }
  });

  it('does not tag an error that came from somewhere else', () => {
    // The default has to be "unsafe". A dependency that starts throwing its own errors must not
    // become quotable because nobody remembered to add it to a list.
    expect(isEvidenceFileError(new TypeError('Cannot read property of undefined'))).toBe(false);
    expect(isEvidenceFileError(new Error('ENOENT: no such file, open /data/user/0/...'))).toBe(false);
    expect(isEvidenceFileError('a string that is not an error')).toBe(false);
    expect(isEvidenceFileError(null)).toBe(false);
  });

  it('says nothing about where the file is in any message it tags', async () => {
    for (const path of [
      'not-a-private-path',
      'users/user_other/cases/case_test/evd_test/original.pdf',
      'users/user_test/cases/../evd_test/original.pdf',
    ]) {
      await expect(readStoredEvidenceFile('user_test', path)).rejects.toSatisfy(
        (error: unknown) => isEvidenceFileError(error) && !identifierShaped.test((error as Error).message),
      );
    }
  });
});
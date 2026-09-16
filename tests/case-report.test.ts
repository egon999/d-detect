import { describe, expect, it } from 'vitest';
import { evidenceBasis, resolveCitation } from '@domain/analysis/case-report';
import type { CaseCitation, Evidence } from '@domain/models';
import { evidence, workspace, CASE_ID } from './helpers';

/**
 * `evidenceBasis` is the sentence printed under an assessment saying how much actually
 * stands behind it. It is the last thing a reader sees before deciding whether to trust a
 * conclusion, so the two ways it can mislead — overcounting one document as many, and
 * dropping the warning that a passage was machine-read — are pinned here.
 */

/** A citation aimed at one segment of a document, quoting it exactly as stored. */
function citeSegment(source: Evidence, segmentIndex: number): CaseCitation {
  const segment = source.extraction?.segments[segmentIndex];
  if (!segment) throw new Error(`Test fixture has no segment ${segmentIndex}`);

  return {
    evidenceId: source.id,
    segmentId: segment.id,
    quote: segment.text,
    startOffset: segment.startOffset,
    endOffset: segment.endOffset,
    stance: 'SUPPORTS',
  };
}

describe('evidenceBasis', () => {
  it('keeps the machine-read warning when a later citation of the same file was read cleanly', () => {
    // The per-source flag was assigned rather than accumulated, so the last citation seen
    // for a document decided the whole document.
    //
    // Sources are keyed by content hash, and every segment within one record shares the
    // method that produced it — so the mix arrives when the *same file* exists as two
    // records read different ways: a scan that went through OCR, and the same PDF re-added
    // once a text layer was found. Both keys are the hash, so the second citation
    // overwrote the first and cleared the warning. The reader was told nothing needed
    // checking against the original at exactly the moment something did.
    const text = 'Invoice total: INR 4,500';
    const scanned = evidence(text, { id: 'evd_scan', title: 'Invoice (scan)', method: 'OCR' });
    const withTextLayer = evidence(text, { id: 'evd_text', title: 'Invoice', method: 'DETERMINISTIC' });

    // Same bytes, so the basis must treat them as one document.
    expect(scanned.sha256).toBe(withTextLayer.sha256);

    const store = workspace({ evidence: [scanned, withTextLayer] });
    const basis = evidenceBasis(store, [citeSegment(scanned, 0), citeSegment(withTextLayer, 0)]);

    expect(basis).toContain('OCR or transcription requires checking against the original');
    expect(basis).toContain('1 distinct cited source');
  });

  it('counts one document once however many times it is quoted', () => {
    // Eight citations of one screenshot are not eight corroborating sources. This is the
    // specific way the number could talk someone into trusting a thin case.
    const single = evidence('Line one\nLine two\nLine three', { id: 'evd_single' });
    const store = workspace({ evidence: [single] });

    const basis = evidenceBasis(store, [
      citeSegment(single, 0),
      citeSegment(single, 1),
      citeSegment(single, 2),
    ]);

    expect(basis).toContain('1 distinct cited source');
  });

  it('treats the same file uploaded twice as one source', () => {
    // Keyed by content hash: two records of identical bytes are one document, whatever
    // they were named on the way in.
    const text = 'Payment of INR 100 received';
    const first = evidence(text, { id: 'evd_a', title: 'Receipt' });
    const second = evidence(text, { id: 'evd_b', title: 'Receipt copy' });

    const store = workspace({ evidence: [first, second] });
    const basis = evidenceBasis(store, [citeSegment(first, 0), citeSegment(second, 0)]);

    expect(basis).toContain('1 distinct cited source');
  });

  it('names how many of the sources are the user’s own statement', () => {
    const document = evidence('Invoice total: INR 4,500', { id: 'evd_doc' });
    const account = evidence('I paid him on the twelfth.', {
      id: 'evd_note',
      kind: 'NOTE',
      note: 'I paid him on the twelfth.',
      sha256: null,
    });

    const store = workspace({ evidence: [document, account] });
    const basis = evidenceBasis(store, [citeSegment(document, 0), citeSegment(account, 0)]);

    expect(basis).toContain('2 distinct cited sources');
    expect(basis).toContain('including 1 user statement');
  });

  it('refuses to imply that a count establishes independence', () => {
    const one = evidence('Invoice total: INR 4,500', { id: 'evd_one' });
    const two = evidence('Amount due: INR 4,500', { id: 'evd_two' });
    const store = workspace({ evidence: [one, two] });

    expect(evidenceBasis(store, [citeSegment(one, 0), citeSegment(two, 0)])).toContain(
      'Source independence and authenticity are not established by this count',
    );
  });

  it('says plainly when nothing cited can still be checked', () => {
    const deleted = evidence('Invoice total: INR 4,500', { id: 'evd_gone' });
    const citation = citeSegment(deleted, 0);
    const store = workspace({ evidence: [{ ...deleted, deletedAt: 9_000 }] });

    expect(evidenceBasis(store, [citation])).toBe(
      'No checkable source passage supports this assessment.',
    );
  });
});

describe('resolveCitation', () => {
  it('withholds a passage whose source text no longer reads the way it was quoted', () => {
    // Offsets survive reprocessing; the characters under them may not. Rendering the stored
    // quotation anyway would put words in the document's mouth.
    const original = evidence('Invoice total: INR 4,500', { id: 'evd_moved' });
    const citation = citeSegment(original, 0);

    const reprocessed = evidence('Completely different text now', { id: 'evd_moved' });
    const store = workspace({ evidence: [reprocessed] });

    expect(resolveCitation(store, citation)).toBeNull();
  });

  it('withholds a passage when the case it belongs to is gone', () => {
    const source = evidence('Invoice total: INR 4,500', { id: 'evd_orphan' });
    const citation = citeSegment(source, 0);

    const store = workspace({ evidence: [source] });
    const orphaned = {
      ...store,
      cases: store.cases.map((item) => (item.id === CASE_ID ? { ...item, deletedAt: 9_000 } : item)),
    };

    expect(resolveCitation(store, citation)).not.toBeNull();
    expect(resolveCitation(orphaned, citation)).toBeNull();
  });

  it('withholds a quotation that reaches outside the segment it claims to come from', () => {
    const source = evidence('Invoice total: INR 4,500\nPaid in full', { id: 'evd_span' });
    const citation = citeSegment(source, 0);
    const store = workspace({ evidence: [source] });

    expect(resolveCitation(store, { ...citation, endOffset: citation.endOffset + 6 })).toBeNull();
  });
});

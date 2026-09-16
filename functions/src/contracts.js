"use strict";
const {z} = require("zod");
const {quoteNamesEntity} = require("../lib/domain/analysis/report-entities");
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const citation = z.object({
  evidenceId: z.string().regex(ID), segmentId: z.string().regex(ID),
  quote: z.string().min(1).max(1800), startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(), stance: z.enum(["SUPPORTS", "CONTRADICTS", "CONTEXT"]),
});
const statement = z.object({statement: z.string().min(1).max(2000), citations: z.array(citation).min(1).max(30)});
const reportSchema = z.object({
  summary: z.string().max(4000),
  claims: z.array(z.object({
    claimId: z.string().regex(ID), statement: z.string().max(2000),
    status: z.enum(["SUPPORTED", "PARTIALLY_SUPPORTED", "CONTRADICTED", "DISPUTED", "INSUFFICIENT_EVIDENCE", "UNRESOLVED"]),
    explanation: z.string().max(4000), citations: z.array(citation).max(40),
    missingInformation: z.array(z.string().max(1000)).max(30), limitations: z.array(z.string().max(1000)).max(30),
  })).max(100),
  agreements: z.array(statement).max(100), contradictions: z.array(statement).max(100),
  timeline: z.array(z.object({description: z.string().max(2000), occurredAt: z.string().max(120).nullable(), citations: z.array(citation).min(1).max(30)})).max(150),
  limitations: z.array(z.string().max(1000)).max(50),
  entities: z.array(z.object({name: z.string().trim().min(1).max(240), type: z.enum(["PERSON", "ORG", "TRANSACTION", "DOCUMENT", "LOCATION"]), citations: z.array(citation).min(1).max(30)})).max(200).default([]),
});
function problem(code, message) { const error = new Error(message); error.code = code; error.safe = true; return error; }
function validateRequest(data, type) {
  if (!data || !ID.test(data.caseId || "") || (type === "EVIDENCE" && !ID.test(data.evidenceId || ""))) {
    throw problem("invalid-argument", "A valid case and evidence identifier are required.");
  }
  return {caseId: data.caseId, evidenceId: type === "EVIDENCE" ? data.evidenceId : null};
}
function validateCitation(ref, evidenceById) {
  const evidence = evidenceById.get(ref.evidenceId);
  const segment = evidence?.extraction?.segments?.find((item) => item.id === ref.segmentId);
  if (!segment || ref.endOffset <= ref.startOffset || ref.startOffset < segment.startOffset || ref.endOffset > segment.endOffset) {
    throw problem("invalid-response", "Analysis returned a citation outside the supplied evidence.");
  }
  const quoted = segment.text.slice(ref.startOffset - segment.startOffset, ref.endOffset - segment.startOffset);
  if (quoted !== ref.quote) throw problem("invalid-response", "Analysis returned a quotation that does not match its source.");
}
function validateReport(raw, evidence, claims) {
  // Character arithmetic is deterministic application work, not a language-model task.
  // Resolve only an exact, uniquely occurring quote in the specifically named segment.
  // Unknown sources, invented quotes, and ambiguous occurrences still fail validation.
  const candidate = structuredClone(raw);
  const originals = new Map(evidence.map((item) => [item.id, item]));
  for (const group of ["claims", "agreements", "contradictions", "timeline", "entities"]) {
    if (!Array.isArray(candidate?.[group])) continue;
    for (const item of candidate[group]) {
      if (!Array.isArray(item?.citations)) continue;
      for (const reference of item.citations) {
        if (typeof reference?.quote !== "string" || !reference.quote) continue;
        const segment = originals.get(reference.evidenceId)?.extraction?.segments?.find((part) => part.id === reference.segmentId);
        if (!segment) continue;
        const offset = segment.text.indexOf(reference.quote);
        if (offset >= 0 && segment.text.indexOf(reference.quote, offset + 1) === -1) {
          reference.startOffset = segment.startOffset + offset;
          reference.endOffset = reference.startOffset + reference.quote.length;
        }
      }
    }
  }
  const parsed = reportSchema.safeParse(candidate);
  if (!parsed.success) throw problem("invalid-response", "The analysis response did not match the required structure.");
  const report = parsed.data;
  const sources = new Map(evidence.map((item) => [item.id, item]));
  const requested = new Map(claims.map((item) => [item.id, item]));
  const seen = new Set();
  for (const assessment of report.claims) {
    const claim = requested.get(assessment.claimId);
    if (!claim || seen.has(claim.id)) throw problem("invalid-response", "Analysis returned an unknown or repeated claim.");
    seen.add(claim.id);
    assessment.statement = claim.statement;
    assessment.citations.forEach((item) => validateCitation(item, sources));
    const support = assessment.citations.some((item) => item.stance === "SUPPORTS");
    const contradiction = assessment.citations.some((item) => item.stance === "CONTRADICTS");
    if ((["SUPPORTED", "PARTIALLY_SUPPORTED"].includes(assessment.status) && !support) ||
      (assessment.status === "CONTRADICTED" && !contradiction) ||
      (assessment.status === "DISPUTED" && !(support && contradiction))) {
      throw problem("invalid-response", "A claim conclusion is missing the evidence required for its status.");
    }
  }
  if (seen.size !== requested.size) throw problem("invalid-response", "Analysis did not assess every submitted claim.");
  [...report.agreements, ...report.contradictions, ...report.timeline].forEach((item) => item.citations.forEach((ref) => validateCitation(ref, sources)));
  report.entities = report.entities.filter((entity) => {
    entity.citations.forEach((ref) => validateCitation(ref, sources));
    if (entity.citations.some((ref) => quoteNamesEntity(ref.quote, entity.name))) return true;
    // Optional graph enrichment must not prevent a valid claim review. Keep its
    // grounding strict: omit names inferred from uploader metadata rather than
    // representing those names as observed source content.
    const limitation = "Some suggested entities were omitted because their names were not present in the cited source text. Uploader attribution does not verify identity.";
    if (!report.limitations.includes(limitation)) report.limitations.push(limitation);
    return false;
  });
  report.agreements = report.agreements.filter((item) => {
    const originals = new Set(item.citations.map((ref) => sources.get(ref.evidenceId)?.sha256 || ref.evidenceId));
    if (originals.size >= 2) return true;
    const limitation = "Repeated copies or passages from one original do not establish independent agreement.";
    if (!report.limitations.includes(limitation)) report.limitations.push(limitation);
    return false;
  });
  return report;
}
module.exports = {ID, problem, validateRequest, validateCitation, validateReport};

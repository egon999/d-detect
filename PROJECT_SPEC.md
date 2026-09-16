# Product specification

Ddetect helps people assess whether claims are supported, contradicted or unresolved by supplied evidence. It organizes a dispute into explicit claims, sources and source-cited assessments. It is not an automated judge, generic AI dashboard or an authenticity certificate.

## Primary workflow

1. Create a case describing the question to investigate. Category and participants are flexible metadata.
2. Add one or more explicit claims.
3. Add originals or typed notes, including source information when known.
4. Wait for persisted extraction status; review failures, unreadable text and truncation.
5. Run case analysis over processed sources. Read each claim's status, citations, missing information and limitations.
6. Inspect underlying evidence and graph relationships rather than relying on a headline.
7. Return later through saved case history and search, or export a readable assessment with citations and limitations.

Every populated record must come from the owner's workspace. Examples belong in explanatory copy or isolated tests, never in a new user's case list or search history.

## User experience contract

Case creation persists before navigation. Errors preserve entered values. Upload, extraction and analysis are separate actions/states; progress is not simulated. An empty workspace explains the next meaningful step. A failed read is not an empty workspace.

Profiles show actual authenticated identity, provider photo or initials, applicable password controls, saved case history, appearance and real search-privacy preferences. Provider keys and developer health checks are excluded. Google-only users manage their password through Google rather than being offered a misleading app-password form.

Search includes real case metadata, claims, evidence text/entities and manual events. Model-extracted entity results require valid current source citations and link to the cited passage. Recent queries belong only to that account on that device. Graph nodes/edges must expose a meaningful relationship and route to their sources. Activity reflects actual saved jobs and audit events.

Previous cloud cases remain reviewable from Profile under the owning account. Recovery only copies missing cases after review; it cannot overwrite current data. Historical text is explicitly unverified and original files require re-upload.

## Evidence conclusions

Supported means the supplied sources support the specific claim under the stated limitations. It does not mean every fact is verified. Contradicted means relevant conflicting evidence was identified, not that a person intentionally lied. Insufficient evidence and unresolved are legitimate outcomes.

Reports preserve source coverage and citations. Missing context, uncertain transcription, duplicated sources, unknown participants and incomplete coverage must remain visible. No decorative confidence percentage may stand in for evidence quality.

## Current scope boundary

The implemented platform uses a local authenticated backend, private originals, durable jobs and backend-managed Groq access. It supports text/document extraction, local English/Hindi image OCR, bounded scanned/mixed-PDF OCR and speech transcription. PDF processing examines up to 80 pages and OCRs up to 10 sparse pages, with partial coverage visible. Video-frame reasoning, verified speaker identification, multi-account collaboration and public production operations remain incomplete.

The detailed acceptance matrix and evidence status are in docs/rebuild-acceptance.md. Architecture and data contracts are in ARCHITECTURE.md and DATA_MODEL.md.

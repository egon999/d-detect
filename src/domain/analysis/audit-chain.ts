import { hashText } from '../hashing';
import type { AuditLog, Workspace } from '../models';

/**
 * Audit chain derivation.
 *
 * A hash chain over a case's audit entries, computed **at render time** and stored
 * nowhere. No entry gains a `digest` field; nothing here is written back. The chain is a
 * function of the entries as they currently are, so — exactly like the evidence graph and
 * the timeline — it cannot drift out of sync with the records it describes.
 *
 * ## What this proves, and what it does not
 *
 * This is the honesty boundary of the whole module, so it is worth stating precisely.
 *
 * **It proves internal consistency.** Each entry's digest covers the previous entry's
 * digest, so a digest depends on the entire history before it. Re-deriving the chain from
 * the stored entries and getting the same head means the sequence now present is the same
 * sequence that was present when that head was last observed: no entry has been altered,
 * inserted between two others, reordered or dropped. That is a real, checkable property,
 * and it is computed from `hashText` — the same SHA-256 the app uses for evidence
 * fingerprints, in pure JS, so an evaluator gets byte-identical digests in the app, in a
 * Node test and in Cloud Functions.
 *
 * **It does not prove the data is tamper-proof at rest.** Nothing is signed: there is no
 * key, so no one can be shown to have authored a chain. Anyone able to rewrite the stored
 * entries can recompute a perfectly valid chain over their rewrite, because the digests
 * are derived rather than sealed. Resistance to mutation is a *storage* property, and in
 * this app it comes from one place only: `rules/firestore.rules` refuses `update` and
 * `delete` on `/auditLogs/{docId}` outright. That is server-side and it is real — but it
 * applies to the Firestore adapter, and the on-device AsyncStorage adapter enforces no
 * such thing.
 *
 * So the two halves are complementary and neither is a substitute for the other: the chain
 * detects an inconsistent history, the security rules prevent one being written through the
 * app. Any UI built on this must say both and claim neither beyond that. In particular it
 * must never say "immutable", "tamper-proof", "signed" or "verified" unqualified.
 *
 * ## Why the digest covers these fields
 *
 * `(previous digest, action, actorId, entityRefs, summary, createdAt)` — the answer to
 * "who did what, to which records, and when", which is the entire content of an audit
 * entry a reader relies on. `id`, `ownerId` and `caseId` are deliberately excluded: they
 * identify and scope the row rather than describe the event, and every entry in a chain
 * shares the same case and owner by construction. `metadata` is excluded too, because it
 * is a free-form `Record<string, string>` whose key order is not guaranteed by the wire
 * format; folding it in would make the digest depend on JSON key ordering and produce
 * spurious mismatches that look like tampering and are not. `updatedAt` is excluded
 * because an append-only record has no meaningful update.
 */

/** The genesis value. A fixed, version-tagged string rather than an empty one, so the
 * first entry's digest is still a hash of something specific, and so a future change to
 * the digest recipe can be told apart from this one by its tag. */
const CHAIN_SEED = 'ddetect-audit-chain/v1';

/**
 * Separates fields inside the hashed payload.
 *
 * ASCII 0x1F, the "unit separator" — a control character that cannot occur in an id, an
 * action name, a numeric timestamp or a user-typed summary. Written as an escape rather
 * than as a literal control byte so it is visible to anyone reading this file.
 *
 * The choice matters. With a printable delimiter such as `|`, a summary containing that
 * character could shift the field boundaries so that two genuinely different entries
 * serialised to the same string and therefore hashed alike — `('a|b', 'c')` and
 * `('a', 'b|c')` must not collide. A control character makes the concatenation
 * unambiguous.
 */
const FIELD_SEPARATOR = '\u001F';

export interface AuditChainLink {
  /** The audit entry this link covers. */
  entry: AuditLog;
  /** Position in the chain, oldest first. `0` is the genesis entry. */
  index: number;
  /** The digest of the entry before this one, or `CHAIN_SEED` at the genesis entry. */
  previousDigest: string;
  /** This entry's digest: SHA-256 hex over the previous digest and this entry's fields. */
  digest: string;
}

export interface AuditChain {
  /** One link per entry, oldest first — the order the digests were computed in. */
  links: AuditChainLink[];
  /**
   * The digest of the most recent entry: one value standing for the whole history.
   *
   * `null` for a case with no audit entries. A chain over nothing has no head, and
   * inventing one would let an empty history display a reassuring-looking hash.
   */
  head: string | null;
  /** How many entries the chain covers. Equal to `links.length`, named for the UI's sake. */
  length: number;
}

/**
 * The exact bytes hashed for one entry.
 *
 * Extracted so the recipe is stated once and can be read on its own. Two properties are
 * load-bearing:
 *
 *   - **Order is fixed.** The fields are concatenated in a declared order, never derived
 *     from `Object.keys`, whose order is not something to depend on across a JSON
 *     round-trip.
 *   - **`entityRefs` is serialised in its stored order, not sorted.** The order the app
 *     recorded the references in is part of what happened; normalising it would make two
 *     genuinely different entries hash alike.
 */
function payloadFor(previousDigest: string, entry: AuditLog): string {
  const refs = entry.entityRefs.map((ref) => `${ref.kind}:${ref.id}`).join(',');

  return [
    previousDigest,
    entry.action,
    entry.actorId,
    refs,
    entry.summary,
    // A number, not a formatted date: a locale-dependent rendering would make the digest
    // depend on the device's locale, and the same history would chain differently on two
    // phones.
    String(entry.createdAt),
  ].join(FIELD_SEPARATOR);
}

/**
 * Derives the chain over a list of audit entries.
 *
 * The caller's array is not mutated and its order is not trusted: entries are copied and
 * sorted oldest-first here, because a chain is only meaningful over a defined sequence and
 * the audit screen holds its list newest-first for display. Ties on `createdAt` — two
 * entries written in the same millisecond, which the demo seed can produce — are broken by
 * `id`, so the chain is deterministic rather than dependent on however the array arrived.
 */
export function buildAuditChain(entries: readonly AuditLog[]): AuditChain {
  const ordered = [...entries].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );

  const links: AuditChainLink[] = [];
  let previousDigest = CHAIN_SEED;

  for (const [index, entry] of ordered.entries()) {
    const digest = hashText(payloadFor(previousDigest, entry));
    links.push({ entry, index, previousDigest, digest });
    previousDigest = digest;
  }

  return {
    links,
    head: links.length > 0 ? links[links.length - 1]!.digest : null,
    length: links.length,
  };
}

/**
 * Derives the chain for one case out of a whole workspace.
 *
 * Unlike the timeline and the graph this does **not** go through `buildRuleContext`, and
 * so does not throw when the case is absent — it returns an empty chain. That is
 * deliberate: the audit trail is the one screen that must still render for a case that has
 * been deleted or has not loaded yet, and a integrity panel that crashes the screen it is
 * reporting on would be a poor kind of integrity.
 */
export function buildCaseAuditChain(
  workspace: Readonly<Workspace>,
  caseId: string,
): AuditChain {
  return buildAuditChain(workspace.auditLogs.filter((log) => log.caseId === caseId));
}

/**
 * A digest, shortened for display.
 *
 * Both ends are kept and the middle elided. Truncating to a prefix alone is the more common
 * choice and is worse here: the first characters of two digests are exactly what a reader
 * compares, and showing only those invites "the first eight match, so it is the same hash"
 * — which for a 64-character value is a much weaker statement than it looks. Keeping the
 * tail means a comparison the user makes by eye is over both ends.
 */
export function shortDigest(digest: string, edge = 8): string {
  if (digest.length <= edge * 2 + 1) return digest;
  return `${digest.slice(0, edge)}…${digest.slice(-edge)}`;
}

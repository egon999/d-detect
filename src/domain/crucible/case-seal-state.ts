import { buildCaseAuditChain, type AuditChain } from '../analysis/audit-chain';
import type { Seal, Workspace } from '../models';
import { SEAL_PUBLIC_KEYS } from './keys';
import {
  latestSeal,
  stillCoveredBy,
  substantiveEntriesSince,
  verifySealedHistory,
  type SealVerification,
} from './seal';

/**
 * One case's sealing state, as a screen needs it.
 *
 * A pure read over the workspace, like every other selector in the domain layer: the audit
 * screen, an export bundle and the verify page all arrive at the same answer from the same
 * records, and none of them asks the network what to believe about the data it already holds.
 *
 * ## The signature is checked here, on the device, every time
 *
 * `verification` is not a cached server verdict. It is this build re-deriving the chain and
 * re-checking each signature against the compiled-in public key, which is the only version
 * of the check worth anything: a stored `verified: true` field would be a claim by the same
 * database whose contents are in question. It is cheap — a hash per entry and one Ed25519
 * verify per seal — and it means the app's own display of a sealed record is subject to
 * exactly the test a hostile reader would apply to the exported one.
 */
export interface CaseSealState {
  /** The chain the seals cover, derived at read time and never stored. */
  chain: AuditChain;
  /** This case's seals, oldest coverage first. */
  seals: Seal[];
  /** The seal covering the most entries, or `null` if the case has never been sealed. */
  latest: Seal | null;
  verification: SealVerification;
  /**
   * Entries recorded since the latest seal that are not themselves records of sealing — the
   * count of things that have happened to this case which no signature covers yet.
   */
  unsealedEntries: number;
  /**
   * Whether asking the server to seal now would produce a new signature.
   *
   * `false` for an empty case, for a case where nothing has happened since the last seal, and
   * for one whose sealed history no longer matches its seal. The last of those is the reason
   * this is computed rather than inferred from `unsealedEntries > 0`: an altered record often
   * has new entries too, and offering to seal it would be offering to sign over the
   * alteration. The server refuses all three; this is the same decision, made early enough to
   * keep the button honest.
   */
  sealable: boolean;
}

/**
 * Reads the sealing state of one case.
 *
 * `caseId` scopes both halves: the chain is built from that case's entries, and seals from
 * other cases are excluded even though they are perfectly valid seals. A seal names the case
 * it covers inside the signed payload, so a seal borrowed from another case would fail its
 * own signature check — but it would fail *loudly*, as a break, and a screen reporting a
 * break because of a filtering mistake would be crying wolf.
 */
export function caseSealState(workspace: Readonly<Workspace>, caseId: string): CaseSealState {
  const chain = buildCaseAuditChain(workspace, caseId);
  const seals = workspace.seals
    .filter((seal) => seal.caseId === caseId)
    .slice()
    .sort((a, b) => a.entryCount - b.entryCount);

  const verification = verifySealedHistory({
    entries: chain.links.map((link) => link.entry),
    seals,
    publicKeys: SEAL_PUBLIC_KEYS,
    // `recordedLinkDigests` is deliberately not passed. It is what lets `verifySealedHistory`
    // name *which* entry was altered, and it only has that power when the digests come from
    // before the alteration — the chain is derived at read time and never stored, so the only
    // digests available here are of the records as they now stand, and comparing those with
    // themselves would find nothing. So a tampered case reports `HEAD_MISMATCH` on this
    // screen: the history does not add up, and this copy cannot say where. A verifier that
    // does hold an earlier snapshot — an export bundle, which records them — gets
    // `ENTRY_ALTERED` and the entry id. Supplying the current digests here would not improve
    // the answer; it would only make the weaker one look like the stronger one.
  });

  const latest = latestSeal(seals);
  const covered = latest !== null && stillCoveredBy(chain, latest);
  const unsealedEntries = latest === null
    ? chain.links.filter((link) => link.entry.action !== 'SEAL_CREATED').length
    : substantiveEntriesSince(chain, latest.entryCount);

  return {
    chain,
    seals,
    latest,
    verification,
    unsealedEntries,
    sealable: chain.head !== null && (latest === null || (covered && unsealedEntries > 0)),
  };
}

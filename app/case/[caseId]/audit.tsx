/**
 * Case history.
 *
 * Three things are on this screen and they must not be confused with each other:
 *
 *   1. **The history** — every audit entry recorded for this case, newest first.
 *   2. **An integrity check over that history** — a hash chain derived here, at render
 *      time, by `src/domain/analysis/audit-chain.ts`.
 *   3. **A server seal over that history** — an Ed25519 signature over the chain head, made
 *      by a key this device does not hold, reported by `SealRibbon` and re-checked here on
 *      every render by `src/domain/crucible/case-seal-state.ts`.
 *
 * It is called "History" — the same word the case screen's navigation row uses for it, and
 * the only one of the four names this file previously gave itself ("Audit trail", "Activity
 * history", "this history") that a user had already been shown before arriving. The panel
 * below is named for what it is, an integrity check, rather than being a second name for the
 * screen it sits on.
 *
 * The second and third are why the copy on this screen is worded as carefully as it is. An
 * earlier version showed a green "HASH SIGNED" chip, a heading reading "Immutable Audit
 * Trail" and a "Tamper-Resistant Ledger" panel. None of that was backed by anything: nothing
 * in the app signed, hashed or chained an audit entry, so all three were claims the product
 * could not support. They are gone, and the arrival of a real signature is not a licence to
 * bring them back — what a seal establishes is narrower than any of those three words, and
 * the narrower claim is the one that survives a hostile reader.
 *
 * What is here instead is the real version of the same idea, each part stated at its true
 * strength and labelled with where it came from:
 *
 *   - The chain **is** computed, from the same SHA-256 used for evidence fingerprints, and
 *     is shown so it can be checked. It proves the displayed entries are *internally
 *     consistent* — none altered, reordered, inserted or dropped relative to the digest.
 *     On its own that is a claim by this device about this device's own records.
 *   - The seal **is** a real signature, and it is what closes that gap: the server recomputed
 *     the chain from Firestore and signed the head, so a match means the history has not
 *     changed since the moment stated on the seal. That makes it *tamper-evident* — it
 *     reveals an edit, it does not prevent one — and an *existence proof* over the entries it
 *     covers. It says nothing about whether those entries are true.
 *   - Append-only **is** genuinely enforced, but by `rules/firestore.rules`
 *     (`allow update, delete: if false` on `/auditLogs`) — server-side, and therefore only
 *     when this session is actually backed by Firestore. On the device adapter it is not
 *     enforced at all, so the screen reads the live adapter from `useRepository()` and says
 *     which of the two situations the user is in rather than asserting the stronger one.
 *   - None of the three is called tamper-proof, immutable, blockchain-anything or legal
 *     proof, and none is called "verified" without saying verified *against what*.
 *
 * A note on the surface treatment: this screen is a column of digests, ids and exact
 * timestamps in monospace, so no panel here is `blurred`. `GlassSurface`'s own header
 * explains why — a blur over a column of digits makes a digit ambiguous, which in an
 * evidence tool is a correctness bug and not a style choice.
 */

import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { shortDigest, type AuditChain, type AuditChainLink } from '@domain/analysis/audit-chain';
import { caseSealState } from '@domain/crucible/case-seal-state';
import { AUDIT_ACTION_LABELS, type AuditAction, type EntityKind } from '@domain/enums';
import type { EntityRef, Workspace } from '@domain/models';
import { SealRibbon } from '@features/crucible/seal-ribbon';
import { useSession } from '@services';
import { useRepository } from '@services/repository-provider';
import { useCaseRecord, useWorkspace } from '@services/use-case-store';
import {
  AnimatedCounter,
  Chip,
  Divider,
  errorDetail,
  ErrorState,
  FadeIn,
  formatRelativeTime,
  HIT_TARGET,
  Icon,
  IconTile,
  Notice,
  Pressable,
  readableToken,
  routeParam,
  Row,
  ScreenScroll,
  SkeletonCard,
  SkeletonList,
  SlideUpIn,
  SPACING,
  Stack,
  Surface,
  Text,
  truncate,
  useTheme,
  type IconName,
  type Tone,
} from '@ui';

type AuditFilter = 'ALL' | 'EVIDENCE' | 'LINKS' | 'CLAIMS_EVENTS' | 'REVIEWS';

/**
 * Action → glyph and tone.
 *
 * A `Tone` rather than a colour, which is the project's rule for every domain-value-to-
 * colour mapping (see `src/ui/semantics.ts`). This map previously held twenty-one hex
 * literals, which meant the audit screen ignored the theme entirely: the greens and reds
 * were tuned for a light canvas and did not meet contrast on the dark one, and re-theming
 * the app would have left this screen behind.
 *
 * The tone assignment follows the same convention as the rest of the product — `ok` for
 * something confirmed, `danger` for a deletion or rejection, `warn` for something undone
 * or retried, `ai` for the analysis engine, `accent`/`info` for ordinary edits. It is a
 * `Record<AuditAction, …>` so adding an action to the enum is a type error here rather
 * than a silently grey row.
 */
const ACTION_META: Record<AuditAction, { icon: IconName; tone: Tone }> = {
  CASE_CREATED: { icon: 'folder-plus-outline', tone: 'accent' },
  CASE_UPDATED: { icon: 'folder-edit-outline', tone: 'info' },
  CASE_STATUS_CHANGED: { icon: 'swap-horizontal', tone: 'warn' },

  CLAIM_CREATED: { icon: 'scale-balance', tone: 'ok' },
  CLAIM_UPDATED: { icon: 'file-document-edit-outline', tone: 'accent' },
  CLAIM_DELETED: { icon: 'close-circle-outline', tone: 'danger' },

  EVENT_CREATED: { icon: 'calendar-plus', tone: 'ok' },
  EVENT_UPDATED: { icon: 'calendar-edit', tone: 'accent' },
  EVENT_DELETED: { icon: 'calendar-remove', tone: 'danger' },

  EVIDENCE_UPLOADED: { icon: 'cloud-upload-outline', tone: 'accent' },
  EVIDENCE_PROCESSED: { icon: 'card-text-outline', tone: 'info' },
  EVIDENCE_CONFIRMED: { icon: 'check-decagram', tone: 'ok' },
  EVIDENCE_DELETED: { icon: 'trash-can-outline', tone: 'danger' },

  EVIDENCE_LINKED: { icon: 'link-variant', tone: 'accent' },
  EVIDENCE_UNLINKED: { icon: 'link-off', tone: 'warn' },

  // Violet is reserved app-wide for machine-derived content, and an analysis run is
  // exactly that.
  ANALYSIS_RUN: { icon: 'brain', tone: 'ai' },
  FINDING_REVIEWED: { icon: 'eye-check-outline', tone: 'ok' },
  FINDING_DISMISSED: { icon: 'eye-off-outline', tone: 'neutral' },
  SUGGESTION_ACCEPTED: { icon: 'check-circle', tone: 'ok' },
  SUGGESTION_REJECTED: { icon: 'close-circle', tone: 'danger' },
  PROCESSING_RETRIED: { icon: 'refresh', tone: 'warn' },

  // `ok` because a seal is a confirmation, and the only one on this screen the user did not
  // make themselves — a server signed the history up to this point. The wax-seal glyph is
  // deliberately unlike every other icon here: nothing else in the list came from off-device.
  SEAL_CREATED: { icon: 'seal-variant', tone: 'ok' },
};

/**
 * Reference kind → glyph and the noun to fall back on.
 *
 * The glyph is what lets a reference chip spend its whole label on the record's *name*.
 * Chips used to read "EVIDENCE a3f9c1b2", which told a reader the one thing they could not
 * use — an id fragment is not something anyone can open, search for or recognise — while
 * spending the label on the thing the icon can say for free.
 *
 * The noun is only reached when a cited record is not in the loaded workspace, which
 * happens for a link retracted since (relationships are hard-deleted; the entry recording
 * them is not) or a participant removed from the case. "Evidence" alone is thin, but it is
 * true, and the entry's summary still names what was touched at the time it happened.
 */
const REF_KIND_META: Record<EntityKind, { icon: IconName; noun: string }> = {
  claim: { icon: 'scale-balance', noun: 'Claim' },
  event: { icon: 'calendar-blank-outline', noun: 'Event' },
  evidence: { icon: 'file-document-outline', noun: 'Evidence' },
  entity: { icon: 'account-outline', noun: 'Person' },
  conflict: { icon: 'alert-circle-outline', noun: 'Finding' },
};

/**
 * Reading the three tables above for a value that came out of storage.
 *
 * Each is declared `Record<Union, …>` so that adding a member to the union fails the build
 * until it has been given an icon and a tone — worth keeping. But that same typing tells
 * TypeScript every lookup succeeds, and here the key is not a literal from this file: it is
 * `log.action` and `ref.kind`, read back off a document. Indexing straight into `.icon`
 * then throws inside render.
 *
 * This screen is the one where that matters most. Audit entries are append-only — never
 * rewritten, never migrated — so they are the oldest records a case holds and the likeliest
 * to name an action a later build stopped declaring. `audit-chain.ts` says outright that
 * this is "the one screen that must still render for a case that has been deleted or has
 * not loaded yet", because "an integrity panel that crashes the screen it is reporting on
 * would be a poor kind of integrity." The domain layer holds up its end of that; the render
 * did not.
 *
 * The fallbacks show the entry rather than hide it. An action nobody has a label for still
 * happened, so it is drawn in neutral with a plain mark and `readableToken` turns its stored
 * name into a phrase — `CASE_STATUS_CHANGED` reads as "Case status changed". A guessed icon
 * or a borrowed tone would be worse than a plain one: both assert something about an entry
 * this build does not understand, on the screen whose whole job is not to do that.
 */
const UNKNOWN_ACTION: { icon: IconName; tone: Tone } = { icon: 'circle-outline', tone: 'neutral' };
const UNKNOWN_REF_KIND: { icon: IconName; noun: string } = { icon: 'circle-outline', noun: 'Record' };

const actionMeta = (action: AuditAction) => ACTION_META[action] ?? UNKNOWN_ACTION;
const refKindMeta = (kind: EntityKind) => REF_KIND_META[kind] ?? UNKNOWN_REF_KIND;
const actionLabel = (action: AuditAction) =>
  (AUDIT_ACTION_LABELS[action] ?? readableToken(action)) || 'Recorded';

/**
 * A reference's id with any kind prefix taken off.
 *
 * Participants and findings are cited with their kind already prefixed onto the id
 * (`entity:per_7`, `conflict:fnd_2`) while claims, events and evidence are not. Stripping it
 * in one place keeps both the name lookup and the route below working off the same id.
 */
function bareId(kind: EntityKind, id: string): string {
  return id.startsWith(`${kind}:`) ? id.slice(kind.length + 1) : id;
}

/**
 * Index key for one reference.
 *
 * Keying by kind *and* id — not id alone — keeps a claim and an event that happened to share
 * an id from resolving to each other's name.
 */
function refKey(kind: EntityKind, id: string): string {
  return `${kind}:${bareId(kind, id)}`;
}

/**
 * Every name an audit entry on this screen might need, indexed once.
 *
 * Built for the whole workspace rather than per row because a case's history cites the same
 * handful of records over and over: resolving a reference by scanning `workspace.evidence`
 * at render time would be a linear search per chip per row.
 */
function buildRefNames(workspace: Readonly<Workspace>): Map<string, string> {
  const names = new Map<string, string>();

  for (const claim of workspace.claims) names.set(refKey('claim', claim.id), claim.statement);
  for (const event of workspace.events) names.set(refKey('event', event.id), event.title);
  for (const item of workspace.evidence) names.set(refKey('evidence', item.id), item.title);
  for (const finding of workspace.analysisResults) {
    names.set(refKey('conflict', finding.id), finding.title);
  }
  for (const record of workspace.cases) {
    for (const person of record.participants) names.set(refKey('entity', person.id), person.name);
  }

  return names;
}

/** The chip label for one reference: the record's name, or the kind when it is gone. */
function refLabel(ref: EntityRef, names: ReadonlyMap<string, string>): string {
  const name = names.get(refKey(ref.kind, ref.id))?.trim();
  // Truncated because a claim statement is a sentence and a chip is one line. The chip
  // ellipsises too, but doing it here keeps the accessibility label — which `Chip` reads
  // from `label` — as short as what is drawn, rather than reading out a paragraph.
  return name ? truncate(name, 48) : refKindMeta(ref.kind).noun;
}

/** Where a reference chip leads. The three kinds that have a screen of their own. */
type RefRoute =
  | { pathname: '/case/[caseId]/claim/[claimId]'; params: { caseId: string; claimId: string } }
  | { pathname: '/case/[caseId]/event/[eventId]'; params: { caseId: string; eventId: string } }
  | {
      pathname: '/case/[caseId]/evidence/[evidenceId]';
      params: { caseId: string; evidenceId: string };
    };

/**
 * The route behind a reference chip, or `null` when there is nowhere to go.
 *
 * Resolving a chip's label to a real record name and then leaving it inert was the worst of
 * both: the chip reads as the name of something you can open, and nothing happens. So the
 * three kinds that have a screen are now tappable and the two that do not stay plain — a
 * participant is stored on the case record rather than as a record of its own, and a finding
 * is read inside the analysis panel rather than at a route of its own.
 *
 * `names` is consulted as well as the kind, because a name only resolves while the record is
 * still in the loaded workspace. A chip that fell back to its kind noun is pointing at
 * something retracted since, and there is nothing at the far end to open.
 */
function refRoute(
  ref: EntityRef,
  caseId: string | null,
  names: ReadonlyMap<string, string>,
): RefRoute | null {
  if (!caseId) return null;
  if (!names.has(refKey(ref.kind, ref.id))) return null;

  const id = bareId(ref.kind, ref.id);
  switch (ref.kind) {
    case 'claim':
      return { pathname: '/case/[caseId]/claim/[claimId]', params: { caseId, claimId: id } };
    case 'event':
      return { pathname: '/case/[caseId]/event/[eventId]', params: { caseId, eventId: id } };
    case 'evidence':
      return {
        pathname: '/case/[caseId]/evidence/[evidenceId]',
        params: { caseId, evidenceId: id },
      };
    default:
      return null;
  }
}

const FILTERS: ReadonlyArray<{ id: AuditFilter; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'EVIDENCE', label: 'Evidence' },
  { id: 'LINKS', label: 'Links' },
  { id: 'CLAIMS_EVENTS', label: 'Claims and events' },
  { id: 'REVIEWS', label: 'Case reviews' },
];

function matchesFilter(action: AuditAction, filter: AuditFilter): boolean {
  switch (filter) {
    case 'ALL':
      return true;
    case 'EVIDENCE':
      return action.startsWith('EVIDENCE_') && !action.includes('LINK');
    case 'LINKS':
      return action.includes('LINK');
    case 'CLAIMS_EVENTS':
      return action.startsWith('CLAIM_') || action.startsWith('EVENT_');
    case 'REVIEWS':
      return action.startsWith('FINDING_') || action.startsWith('CASE_');
  }
}

/**
 * An exact, unambiguous timestamp.
 *
 * `formatRelativeTime` carries the list ("3 hours ago"), but an audit row also has to state
 * precisely when something happened, to the second — "yesterday" is not a record. The
 * relative form is the scannable one and the exact form is the citable one, so both appear.
 */
function formatExactDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function CaseAuditTrailScreen() {
  const theme = useTheme();
  const caseId = routeParam(useLocalSearchParams<{ caseId?: string | string[] }>().caseId);
  const { user } = useSession();
  // Which adapter is actually serving this session. The append-only guarantee is a property
  // of the backend, not of the app, so the copy below is conditioned on this rather than
  // asserted unconditionally.
  const { kind: repositoryKind } = useRepository();

  // `error` is destructured deliberately. A failed load leaves the workspace empty, and an
  // empty workspace on *this* screen renders a complete, plausible-looking audit trail with
  // nothing in it — which reads as "nothing ever happened to this case". That is the one
  // false statement this screen must never make, so a load failure is reported instead.
  const { workspace, loading, refreshing, error, reload } = useWorkspace(user?.id ?? null, caseId ?? null);
  const targetCase = useCaseRecord(workspace, caseId ?? null);

  const [activeFilter, setActiveFilter] = useState<AuditFilter>('ALL');
  const [chainExpanded, setChainExpanded] = useState(false);

  /**
   * The chain, the case's seals and the verdict of checking one against the other.
   *
   * Derived together, from one pass, because the two panels below must not disagree: the
   * integrity panel's digest and the seal ribbon's "this is the history that was signed" are
   * statements about the same computation, and deriving the chain twice would let a future
   * edit make one of them stale. Verifying costs one Ed25519 check per seal and happens here
   * on every render of this screen rather than being read from a stored field — a
   * `verified: true` column would be a claim by the same database whose contents are in
   * question.
   */
  const sealState = useMemo(() => caseSealState(workspace, caseId ?? ''), [workspace, caseId]);
  const chain = sealState.chain;

  /**
   * A lookup from entry id to its link.
   *
   * Indexing the one derived chain is what lets each row show its own digest without every
   * row re-hashing the history behind it — the naive version of this screen would be O(n²)
   * in SHA-256 calls.
   */
  const linkById = useMemo(() => {
    const index = new Map<string, AuditChainLink>();
    for (const link of chain.links) index.set(link.entry.id, link);
    return index;
  }, [chain]);

  // Display order is newest-first, the opposite of the chain's derivation order.
  const logs = useMemo(() => [...chain.links].reverse().map((link) => link.entry), [chain]);

  const filteredLogs = useMemo(
    () => (activeFilter === 'ALL' ? logs : logs.filter((log) => matchesFilter(log.action, activeFilter))),
    [logs, activeFilter],
  );

  /**
   * Names for every record the history cites, so a reference chip can say what it points at.
   *
   * Keyed off the whole workspace rather than the filtered rows: the map is the same
   * regardless of which filter is active, and rebuilding it on every chip press would be
   * work done to produce an identical result.
   */
  const refNames = useMemo(() => buildRefNames(workspace), [workspace]);

  // Cloud-backed sessions are the ones the Firestore rules actually govern.
  const serverEnforced = repositoryKind === 'firebase';

  /**
   * Whether this screen still knows nothing about the case.
   *
   * The distinction matters because everything below the masthead is a statement *about this
   * case's history*: a count, a chip reading "nothing recorded yet", a fingerprint, an empty
   * state. Rendering any of it from an unloaded workspace asserts that the history is empty,
   * which is the one false statement the comment above the error branch already forbids — and
   * the animated counter made it worse by counting up to a zero it had invented. A refresh
   * over entries that are already on screen is deliberately *not* first paint: the content
   * stays put and the refresh control says what is happening.
   */
  const firstPaint = loading && chain.length === 0;

  return (
    <ScreenScroll
      title="History"
      back
      {...(targetCase?.title ? { subtitle: targetCase.title } : {})}
      refreshing={refreshing}
      onRefresh={reload}
    >
      {error ? (
        /*
          The error replaces the whole trail rather than sitting above it. The integrity
          panel derives its chip and its count from the loaded records, so on a failed load
          it would state that nothing is recorded and show a count of zero — a positive claim
          about the history, made from data that never arrived.
        */
        <ErrorState
          title="This history could not be loaded"
          message="The connection to your stored cases failed, so the history for this case could not be read. Nothing has been changed. This is not a sign that the history is empty."
          detail={errorDetail(error)}
          onRetry={reload}
        />
      ) : firstPaint ? (
        /*
          Shaped like what is arriving — one wide panel, then a column of entry cards — so
          nothing jumps when the records land. It says nothing about the case, which is the
          only honest thing to show before the history has been read.
        */
        <Stack
          gap="xl"
          accessibilityRole="progressbar"
          accessibilityLabel="Reading the history of this case"
        >
          <SkeletonCard lines={5} />
          <SkeletonList count={3} />
        </Stack>
      ) : (
        <Stack gap="xl">
          <SlideUpIn>
            <IntegrityPanel
              chain={chain}
              serverEnforced={serverEnforced}
              expanded={chainExpanded}
              onToggle={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
                setChainExpanded((open) => !open);
              }}
            />
          </SlideUpIn>

          {/* Directly below the panel, because it answers the limitation the panel states.
              The panel's own copy admits a self-derived chain proves only internal
              consistency — anyone able to rewrite the records could recompute a matching
              digest. The ribbon is the part that came from off-device, so it sits where a
              reader arrives at that sentence, and is a separate surface so it stays obvious
              which of the two facts came from where. */}
          <SlideUpIn delay={theme.motion.stagger}>
            <SealRibbon
              caseId={caseId ?? ''}
              state={sealState}
              repositoryKind={repositoryKind}
              onSealed={reload}
            />
          </SlideUpIn>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}
          >
            {FILTERS.map((filter) => {
              const count =
                filter.id === 'ALL'
                  ? logs.length
                  : logs.filter((log) => matchesFilter(log.action, filter.id)).length;

              return (
                <Pressable
                  key={filter.id}
                  haptic
                  pressScale={0.96}
                  accessibilityRole="button"
                  accessibilityState={{ selected: activeFilter === filter.id }}
                  accessibilityLabel={`${filter.label}, ${count} entries`}
                  onPress={() => setActiveFilter(filter.id)}
                  style={styles.filterTarget}
                >
                  {/* The count is on every filter, not just "All": a filter that reads
                      "Links" tells you nothing about whether tapping it will show you an
                      empty list. */}
                  <Chip
                    tone={activeFilter === filter.id ? 'accent' : 'neutral'}
                    emphasis={activeFilter === filter.id ? 'filled' : 'soft'}
                    label={`${filter.label} (${count})`}
                  />
                </Pressable>
              );
            })}
          </ScrollView>

          {filteredLogs.length > 0 ? (
            <View style={{ gap: theme.spacing.lg }}>
              {filteredLogs.map((log) => (
                <AuditRow
                  key={log.id}
                  log={log}
                  link={linkById.get(log.id) ?? null}
                  chainLength={chain.length}
                  refNames={refNames}
                  caseId={caseId ?? null}
                  // Whether to attribute the entry to the reader by name. The app holds no
                  // directory of other people, so this is the only actor it can ever name.
                  byCurrentUser={!!user && log.actorId === user.id}
                />
              ))}
            </View>
          ) : (
            <Notice
              tone="neutral"
              title={logs.length === 0 ? 'Nothing recorded yet' : 'Nothing matches this filter'}
              message={
                logs.length === 0
                  ? 'Actions taken on this case — uploads, links, claim edits, analysis runs — are recorded here as they happen.'
                  : 'No entries match the filter you picked. Choose "All" to see the whole history.'
              }
            />
          )}
        </Stack>
      )}
    </ScreenScroll>
  );
}

/**
 * The integrity panel.
 *
 * This is the component that used to make claims the app could not keep, so its job now is
 * to be exact. It reports two *separate* facts and labels which is which, because they have
 * different sources and different strengths: the chain is computed on this device from the
 * displayed records, and the append-only guarantee comes from the server's security rules.
 * Collapsing them into one reassuring green badge is precisely the thing being fixed.
 */
function IntegrityPanel({
  chain,
  serverEnforced,
  expanded,
  onToggle,
}: {
  chain: AuditChain;
  serverEnforced: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const theme = useTheme();

  return (
    <Surface glass glassVariant="hero" radius="lg" style={styles.panel}>
      <Row gap="md" align="center">
        <IconTile icon="history" tone="accent" size="lg" />
        <View style={styles.flex}>
          {/* Named for what the panel is, not for the screen it is on. It used to read
              "Activity history", which was a third name for a screen already called
              "History" in the case navigation — and it described the list below rather than
              the check this panel performs over it. */}
          <Text variant="heading">Integrity check</Text>
          <Text variant="caption" colorToken="textSecondary">
            Computed here, over every recorded change to this case
          </Text>
        </View>
      </Row>

      <Divider spacing="lg" />

      <Row justify="space-between" align="flex-end">
        <View>
          {/* Genuine: a straight count of the entries held for this case. The screen holds
              this panel back until the history has actually been read, so the counter never
              animates up to a zero it invented. */}
          <AnimatedCounter value={chain.length} variant="statValue" tone="accent" />
          <Text variant="caption" colorToken="textSecondary">
            {chain.length === 1 ? 'Recorded entry' : 'Recorded entries'}
          </Text>
        </View>

        <View style={styles.panelStatus}>
          {/*
            Replaces the old `tone="ok"` "HASH SIGNED" chip. `info` rather than `ok`: green
            in this product means "corroborated / settled", and a consistency check that
            nobody has cross-checked against an external record is information, not a
            clean bill of health. The label says what was done — a chain was computed —
            and not what it would be nice for it to mean.
          */}
          <Chip
            tone={chain.head ? 'info' : 'neutral'}
            emphasis="soft"
            icon="link-variant"
            label={chain.head ? 'Chain computed' : 'Nothing recorded yet'}
            size="sm"
          />
          {/*
            Where the case lives, in the words the profile screen already uses for it. This
            said "Cloud Synchronized" / "Device Storage", which named the storage technology
            — the one thing `app/(tabs)/profile.tsx` documents as deliberately absent from
            this product. What a reader needs from it is whether their work is on this phone
            alone, and that is answerable without naming a database.
          */}
          <Chip
            tone={serverEnforced ? 'ok' : 'neutral'}
            emphasis="soft"
            icon={serverEnforced ? 'cloud-check-outline' : 'cellphone'}
            label={serverEnforced ? 'Saved to your account' : 'Saved on this device'}
            size="sm"
            style={{ marginTop: theme.spacing.xs }}
          />
        </View>
      </Row>

      {chain.head ? (
        <>
          <Divider spacing="lg" />

          {/* Was "CHAIN HEAD", which names the data structure rather than the thing. The
              value below is one number standing for this whole history, which is what a
              fingerprint is — and the wording matches how the evidence screen already
              describes the same SHA-256 over a file's bytes. */}
          <Text variant="caption" colorToken="textTertiary">
            Fingerprint of this history
          </Text>
          {/*
            Monospace because it is a machine-computed value — the product's typographic
            promise, and the reason no panel on this screen is blurred. Selectable so an
            evaluator can copy it out and re-derive it themselves.
          */}
          <Text variant="mono" colorToken="textAccent" selectable style={styles.digest}>
            {chain.head}
          </Text>

          <Pressable
            haptic
            pressScale={0.99}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={expanded ? 'Hide what this proves' : 'Explain what this proves'}
            onPress={onToggle}
          >
            <Row gap="xs" align="center">
              <Text variant="caption" colorToken="textAccent">
                {expanded ? 'Hide what this does and does not prove' : 'What does this prove?'}
              </Text>
              <Icon
                name={expanded ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={theme.colors.textAccent}
              />
            </Row>
          </Pressable>

          {expanded ? (
            <FadeIn>
              <View style={{ gap: theme.spacing.md }}>
                {/*
                  The honest statement, split into what is proven and what is not. Written
                  as two Notices rather than one paragraph so the limitation is not a
                  footnote to the reassurance — it has equal visual weight.
                */}
                <Notice
                  tone="info"
                  icon="link-variant"
                  title="What the chain shows"
                  message={
                    'Each entry is hashed together with the hash before it (SHA-256), so the last value depends on the whole history. Re-deriving it and getting the same value means the entries shown here are internally consistent: none has been altered, reordered, inserted or removed. The chain is recomputed from the stored records every time this screen opens and is not saved anywhere.'
                  }
                />
                <Notice
                  tone="warn"
                  icon="information-outline"
                  title="What it does not show"
                  message={
                    serverEnforced
                      ? 'It is not a signature, and it cannot establish that nothing was altered at rest: the hashes are derived from the records, so anyone who could rewrite the records could also recompute a matching chain. Resistance to editing comes from elsewhere — this case is stored in the cloud, where the security rules reject any attempt to change or delete an audit entry. Neither mechanism is a legal attestation.'
                      : 'It is not a signature, and it cannot establish that nothing was altered at rest: the hashes are derived from the records, so anyone who could rewrite the records could also recompute a matching chain. This case is stored on this device, where nothing prevents the stored file being edited — the server-side rule that rejects edits and deletions applies only to cloud-backed cases. Neither mechanism is a legal attestation.'
                  }
                />
              </View>
            </FadeIn>
          ) : null}
        </>
      ) : null}
    </Surface>
  );
}

/**
 * One audit entry.
 *
 * Each row carries its own position in the chain and its own digest, which is the point of
 * deriving the chain at all: a single head value at the top of the screen is only a claim,
 * whereas a per-row digest is something a reader can follow link by link.
 *
 * ## Why the metadata block is gone
 *
 * Every entry carries a free-form `Record<string, string>`, and this row used to print it
 * verbatim as `key: value` in monospace. It was removed rather than relabelled, because
 * relabelling only fixes half of it: the keys are internal (`extractor`, `resultType`,
 * `sizeBytes`, `fields`) and so are the *values* — `OPEN`→`CLOSED`, `EXTRACTED`,
 * `deterministic-v3`, `amounts.0` — so prose labels would have left a reader looking at a
 * tidily-named row of identifiers. Nothing in there is actionable by the person reading
 * this screen, and all of it duplicates what the summary above already says in words:
 * `{ from: 'OPEN', to: 'CLOSED' }` sits directly under "Case status changed from OPEN to
 * CLOSED". None of it is load-bearing for the integrity check either — `metadata` is
 * deliberately excluded from the hashed payload (see `audit-chain.ts`), so what is shown
 * here cannot change what is verified. The field is still written and still stored; this
 * screen just stops reciting it.
 */
function AuditRow({
  log,
  link,
  chainLength,
  refNames,
  caseId,
  byCurrentUser,
}: {
  log: AuditChainLink['entry'];
  link: AuditChainLink | null;
  chainLength: number;
  refNames: ReadonlyMap<string, string>;
  caseId: string | null;
  byCurrentUser: boolean;
}) {
  const theme = useTheme();
  const router = useRouter();
  const meta = actionMeta(log.action);

  return (
    <Surface radius="md" style={styles.logCard}>
      <Row gap="md" align="flex-start">
        <IconTile icon={meta.icon} tone={meta.tone} size="md" style={styles.rowTile} />

        <View style={styles.flex}>
          <Row justify="space-between" align="center" wrap style={{ marginBottom: theme.spacing.xs }}>
            <Chip
              tone={meta.tone}
              emphasis="soft"
              label={actionLabel(log.action)}
              size="sm"
              shrink
            />
            <Text variant="caption" colorToken="textSecondary">
              {formatRelativeTime(log.createdAt, Date.now())}
            </Text>
          </Row>

          <Text variant="bodyMedium">{log.summary}</Text>

          {log.entityRefs.length > 0 ? (
            <Row gap="sm" wrap style={{ marginTop: theme.spacing.xs }}>
              {log.entityRefs.map((ref) => {
                const label = refLabel(ref, refNames);
                const route = refRoute(ref, caseId, refNames);
                const chip = (
                  <Chip
                    tone="neutral"
                    emphasis="outline"
                    icon={refKindMeta(ref.kind).icon}
                    label={label}
                    size="sm"
                    shrink
                  />
                );

                // Composite key: the same entity can legitimately be referenced twice by
                // one entry, so the id alone is not unique within this list.
                const key = `${ref.kind}:${ref.id}`;

                return route ? (
                  <Pressable
                    key={key}
                    haptic
                    pressScale={0.96}
                    accessibilityRole="link"
                    accessibilityLabel={label}
                    accessibilityHint={`Opens this ${refKindMeta(ref.kind).noun.toLowerCase()}.`}
                    onPress={() => router.push(route)}
                    // The chip itself is a label-height pill. The touch area around it is
                    // what has to be reachable, so the wrapper carries the minimum and
                    // centres the chip inside it.
                    style={styles.refTarget}
                  >
                    {chip}
                  </Pressable>
                ) : (
                  <View key={key} style={styles.refTarget}>
                    {chip}
                  </View>
                );
              })}
            </Row>
          ) : null}

          <Divider spacing="md" />

          <Row justify="space-between" align="center" wrap gap="sm">
            {/*
              Was "Actor a3f9c1b2d4" — a slice of a user id, which identifies the person to
              the database and to nobody else. A name is only ever available for one person:
              the app stores no directory of other users, so when an entry was not written by
              the reader there is nothing truthful to put here and the attribution is simply
              absent. The spacer keeps the timestamp at the right edge when that happens.
            */}
            {byCurrentUser ? (
              <Text variant="caption" colorToken="textTertiary">
                Recorded by you
              </Text>
            ) : (
              <View />
            )}
            <Text variant="monoSmall" colorToken="textTertiary">
              {formatExactDate(log.createdAt)}
            </Text>
          </Row>

          {link ? (
            <Row justify="space-between" align="center" wrap gap="sm" style={{ marginTop: theme.spacing.xs }}>
              {/* 1-based for display: "Entry 1 of 24" is what a reader expects, while the
                  chain itself indexes from 0. Was "Chain position 1 of 24", which described
                  the data structure holding the entry rather than the entry. */}
              <Text variant="caption" colorToken="textTertiary">
                Entry {link.index + 1} of {chainLength}
              </Text>
              <Text
                variant="monoSmall"
                colorToken="textTertiary"
                selectable
                // The short form, not `link.digest`. The full value is 64 hex characters,
                // and a screen reader given it reads all 64 out one at a time before
                // reaching the next row.
                accessibilityLabel={`Digest for this entry, ${shortDigest(link.digest)}`}
              >
                {shortDigest(link.digest)}
              </Text>
            </Row>
          ) : null}
        </View>
      </Row>
    </Surface>
  );
}

/**
 * Module-scope styles use the raw `SPACING`/`RADIUS` tokens rather than `useTheme()`,
 * which is only callable inside a component. These are the same numbers the theme hands
 * out — the scale is scheme-independent — so this stays a token reference and not a
 * magic number.
 */
const styles = StyleSheet.create({
  flex: { flex: 1 },
  panel: {
    padding: SPACING.xxl,
  },
  panelStatus: {
    alignItems: 'flex-end',
  },
  digest: {
    marginTop: SPACING.xxs,
    marginBottom: SPACING.lg,
  },
  filterRow: {
    gap: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  // A filter chip and a reference chip are both label-height pills, and both are primary
  // navigation on this screen. `HIT_TARGET` is the floor for anything a finger has to find.
  filterTarget: {
    minHeight: HIT_TARGET,
    justifyContent: 'center',
  },
  refTarget: {
    minHeight: HIT_TARGET,
    justifyContent: 'center',
  },
  logCard: {
    padding: SPACING.xl,
  },
  rowTile: {
    marginTop: SPACING.xxs,
  },
});

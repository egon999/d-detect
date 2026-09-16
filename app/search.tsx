import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRepository, useSession } from '@services';
import { clearSearchHistory, loadSearchHistory, rememberSearch } from '@services/preferences';
import {
  buildSearchIndex,
  mapWithConcurrency,
  matchesSearch,
  searchSnippet,
  type SearchKind,
  type SearchRecord,
} from '@services/search-index';
import {
  Button,
  Chip,
  Divider,
  EmptyState,
  ENTITY_KIND_LABELS,
  ErrorState,
  HIT_TARGET,
  Icon,
  IconButton,
  Notice,
  Pressable,
  Row,
  SPACING,
  Skeleton,
  Stack,
  Text,
  TextField,
  errorDetail,
  readableError,
  useTheme,
  type IconName,
} from '@ui';

/**
 * The kinds, in the order a person looks for them: the container first, then its contents.
 *
 * The values are the internal `SearchKind` union and the labels are what the reader sees,
 * and until now those were the same string. So the filter strip said "Evidence" and
 * "Entities" — the first is the app's collective noun for a case's documents rather than a
 * count of things you can filter to, and the second is a data-model word that means nothing
 * to anyone outside this codebase. A chip is a promise about what the list will contain, so
 * it says "Documents" and "Names", which is what the list does contain.
 */
const FILTERS: readonly { value: 'All' | SearchKind; label: string }[] = [
  { value: 'All', label: 'All' },
  { value: 'Cases', label: 'Cases' },
  { value: 'Evidence', label: 'Documents' },
  { value: 'Claims', label: 'Claims' },
  { value: 'Entities', label: 'Names' },
  { value: 'Events', label: 'Events' },
];

/**
 * What one result calls itself, on the line above its title.
 *
 * Singular, because it is describing the one row it sits on — the plural chip label would
 * read "Entities · Payment receipt". Four of the five come from `ENTITY_KIND_LABELS`, the
 * map the rest of the app already renders these kinds through, so a result row and the same
 * record shown inside a case cannot end up called two different things. Only `Cases` has no
 * entry there: a case is the container, not something extracted from a document.
 */
const KIND_LABELS: Record<SearchKind, string> = {
  Cases: 'Case',
  Claims: ENTITY_KIND_LABELS.claim,
  Evidence: ENTITY_KIND_LABELS.evidence,
  Entities: ENTITY_KIND_LABELS.entity,
  Events: ENTITY_KIND_LABELS.event,
};

const ICONS: Record<SearchKind, IconName> = {
  Cases: 'folder-outline',
  Claims: 'scale-balance',
  Evidence: 'file-document-outline',
  Entities: 'account-search-outline',
  Events: 'calendar-clock',
};

/**
 * How many results are mounted at once, and how many more arrive per tap.
 *
 * A broad query against a large workspace matches thousands of records. Mounting them all
 * costs seconds on the mid-range Android hardware this is built for, and nobody reads past
 * the first screen of a search anyway.
 */
const PAGE_SIZE = 30;

/** Below this, a query is a keystroke on the way to a word, not a search worth remembering. */
const MIN_REMEMBERED_QUERY = 2;

/**
 * Search across the whole workspace.
 *
 * ## Why the index is built here rather than queried
 *
 * There is no server to query. Every record lives in the local repository, and the amount
 * of it that belongs to one person is small enough to hold in memory and scan. Building an
 * index once on entry and filtering it in memory gives results that keep up with typing,
 * which a round trip per keystroke would not.
 *
 * The index is rebuilt on each focus rather than cached across visits: evidence finishes
 * processing in the background, and a search that silently omits a document the user
 * watched finish extracting is worse than a short wait.
 *
 * ## What is searchable, and what is not
 *
 * Titles, extracted document text, names and dates — the things a person remembers about a
 * document. Nothing is scored or ranked by relevance: results appear in index order, which
 * is stable and explainable. A relevance score that put one document above another without
 * being able to say why would be the wrong instinct in a product whose whole claim is that
 * its conclusions can be checked.
 *
 * ## Recent searches are stored, results are not
 *
 * Only the query strings are persisted, and only when the user submits one. The records
 * they matched are never written anywhere: they came from the repository and that is where
 * they stay.
 */
export default function SearchScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useSession();
  const { repository, ready } = useRepository();

  const ownerId = user?.id ?? null;

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'All' | SearchKind>('All');
  const [index, setIndex] = useState<SearchRecord[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * The failure that stopped the index being built, kept as it was caught.
   *
   * It used to be flattened to `caught.message` the moment it arrived, which put whatever
   * the storage layer says — "Missing or insufficient permissions.", a Firestore code, a
   * cancellation sentinel this file throws at itself — straight into the visible `detail`
   * line. Holding the original lets `readableError` decide whether it is a sentence written
   * for a person and `errorDetail` keep the raw text where a reader can choose to open it.
   */
  const [failure, setFailure] = useState<unknown>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZE);

  // Filtering lags the text field by a frame under load, so typing never stutters waiting
  // for a scan of the index to finish. The snippet highlighting reads the same deferred
  // value, so a result never highlights a word the list was not filtered by.
  const activeQuery = useDeferredValue(query);

  useFocusEffect(
    useCallback(() => {
      setAttempt((current) => current + 1);
    }, []),
  );

  // Signing out mid-session must not leave one account's records on screen for the next.
  useEffect(() => {
    setQuery('');
    setHistory([]);
    setIndex([]);
    setHistoryError(null);
  }, [ownerId]);

  // A narrowed search starts from the top. Keeping a scrolled-in page count across a new
  // query would mount a hundred rows of results nobody asked to see.
  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [activeQuery, filter]);

  useEffect(() => {
    let cancelled = false;
    setHistory([]);

    if (ownerId) {
      void loadSearchHistory(ownerId)
        .then((items) => {
          if (!cancelled) setHistory(items);
        })
        .catch(() => {
          // Recent searches are a convenience. Failing to load them is worth saying, but
          // it must not take the search itself down with it.
          if (!cancelled) setHistoryError('Recent searches could not be loaded.');
        });
    }

    return () => {
      cancelled = true;
    };
  }, [ownerId, attempt]);

  useEffect(() => {
    let cancelled = false;
    setIndex([]);
    setFailure(null);
    setLoading(true);

    // Signed out is a final answer, and the empty state for it is accurate, so loading ends.
    if (!ownerId) {
      setLoading(false);
      return;
    }

    // Storage not being ready yet says nothing about what the user has saved. `loading`
    // stays true rather than collapsing into the empty index, which is what made this
    // screen tell a signed-in user on a stalled adapter that their workspace was empty.
    // The effect re-runs when `ready` flips, so the index is built as soon as it can be.
    if (!ready) return;

    void (async () => {
      try {
        if (repository.loadAllWorkspace) {
          // One read of everything, where the backing store can do it. Far cheaper than a
          // request per case, which is what the fallback below costs.
          const snapshot = await repository.loadAllWorkspace(ownerId);
          if (!cancelled) setIndex(buildSearchIndex(ownerId, snapshot.cases, [snapshot]));
        } else {
          const cases = await repository.listCases(ownerId);
          const workspaces = await mapWithConcurrency(cases, 4, (record) => {
            // Throwing is how an in-flight fan-out is stopped: the loader aborts rather
            // than reading every remaining case for a screen the user has left.
            if (cancelled) throw new Error('Search cancelled');
            return repository.loadWorkspace(ownerId, record.id);
          });
          if (!cancelled) setIndex(buildSearchIndex(ownerId, cases, workspaces));
        }
      } catch (caught) {
        if (!cancelled) {
          setFailure(caught);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ownerId, repository, ready, attempt]);

  const matches = useMemo(
    () => index.filter((record) => matchesSearch(record, activeQuery)),
    [index, activeQuery],
  );

  const results = useMemo(
    () => (filter === 'All' ? matches : matches.filter((record) => record.kind === filter)),
    [matches, filter],
  );

  // Saved on submit and on opening a result — both are moments the user showed the query
  // was worth something. Saving on every keystroke would fill the list with prefixes.
  const saveQuery = useCallback(() => {
    if (!ownerId || query.trim().length < MIN_REMEMBERED_QUERY) return;
    void rememberSearch(ownerId, query)
      .then(setHistory)
      .catch(() => setHistoryError('This search could not be saved to your recent searches.'));
  }, [ownerId, query]);

  /**
   * Open the record a result stands for.
   *
   * `push`, not `replace`. Every one of these five used to replace the search screen with
   * its destination, so a person who opened the third result to check whether it was the
   * right document had no way back to the other nine but to press the tab bar, open search
   * again and retype the query — the index is rebuilt on focus, so even the results were
   * gone. A search is a place you look *from*; it has to still be there when you look up.
   */
  const open = useCallback(
    (record: SearchRecord) => {
      saveQuery();
      switch (record.kind) {
        case 'Cases':
          router.push({ pathname: '/case/[caseId]', params: { caseId: record.caseId } });
          break;
        case 'Claims':
          router.push({
            pathname: '/case/[caseId]/claim/[claimId]',
            params: { caseId: record.caseId, claimId: record.recordId },
          });
          break;
        case 'Evidence':
          router.push({
            pathname: '/case/[caseId]/evidence/[evidenceId]',
            params: { caseId: record.caseId, evidenceId: record.recordId },
          });
          break;
        case 'Entities':
          // An entity is not a record of its own — it was read out of a document. Opening
          // it means opening that document, scrolled to the passage it came from.
          router.push({
            pathname: '/case/[caseId]/evidence/[evidenceId]',
            params: {
              caseId: record.caseId,
              evidenceId: record.recordId,
              segmentId: record.segmentId,
            },
          });
          break;
        case 'Events':
          router.push({
            pathname: '/case/[caseId]/event/[eventId]',
            params: { caseId: record.caseId, eventId: record.recordId },
          });
          break;
      }
    },
    [router, saveQuery],
  );

  const clearHistory = useCallback(async () => {
    if (!ownerId) return;
    try {
      await clearSearchHistory(ownerId);
      setHistory([]);
      setHistoryError(null);
    } catch {
      setHistoryError('Search history could not be cleared. Try again.');
    }
  }, [ownerId]);

  const closeSearch = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/cases');
  }, [router]);

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas, paddingTop: insets.top }]}>
      <View style={[styles.header, { paddingHorizontal: theme.layout.screenPadding }]}>
        <Row gap="sm" align="center">
          <IconButton icon="arrow-left" accessibilityLabel="Close search" onPress={closeSearch} />
          <View style={styles.fill}>
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder="Search your cases and documents"
              accessibilityLabel="Search your cases, documents, claims, names and events"
              autoFocus
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={saveQuery}
              trailing={
                query ? (
                  <IconButton
                    icon="close"
                    accessibilityLabel="Clear search"
                    onPress={() => setQuery('')}
                  />
                ) : undefined
              }
            />
          </View>
        </Row>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: theme.spacing.sm, paddingVertical: theme.spacing.md }}
        >
          {FILTERS.map((kind) => (
            <Pressable
              key={kind.value}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === kind.value }}
              accessibilityLabel={`Show ${kind.label.toLowerCase()} only`}
              onPress={() => setFilter(kind.value)}
              style={styles.filter}
            >
              <Chip label={kind.label} tone={filter === kind.value ? 'accent' : 'neutral'} />
            </Pressable>
          ))}
        </ScrollView>
      </View>

      <FlatList
        data={results.slice(0, limit)}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingHorizontal: theme.layout.screenPadding,
          paddingBottom: insets.bottom + theme.spacing.xl,
        }}
        ListHeaderComponent={
          <View style={{ gap: theme.spacing.md, marginBottom: theme.spacing.md }}>
            {historyError ? <Notice tone="warn" title="Recent searches" message={historyError} /> : null}

            {!query && history.length > 0 ? (
              <>
                <Row between align="center">
                  <Text variant="subheading">Recent searches</Text>
                  <Button label="Clear" variant="ghost" size="sm" onPress={() => void clearHistory()} />
                </Row>
                <Row gap="sm" wrap>
                  {history.map((term) => (
                    <Pressable
                      key={term}
                      accessibilityRole="button"
                      accessibilityLabel={`Search ${term}`}
                      onPress={() => setQuery(term)}
                      style={styles.filter}
                    >
                      <Chip label={term} tone="neutral" />
                    </Pressable>
                  ))}
                </Row>
              </>
            ) : null}

            {!loading && !failure && results.length > 0 ? (
              // The help clause only while there is nothing to count. Once a reader has
              // searched, being told what is searchable is a fact they have just used, and
              // splicing it onto the result count with a middle dot made one line say two
              // unrelated things at the same rank.
              <Text variant="caption" colorToken="textSecondary">
                {activeQuery
                  ? `${results.length} matching records`
                  : 'Your saved records. Names, document text and dates are searchable.'}
              </Text>
            ) : null}
          </View>
        }
        /*
          A rule between rows rather than under each one. `borderBottomWidth` on the row
          itself also draws a line under the last result, which is an edge with nothing on
          the other side of it — and a separator is the list's business, not the row's.
        */
        ItemSeparatorComponent={() => <Divider />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${KIND_LABELS[item.kind]}: ${item.title}, ${item.context}`}
            onPress={() => open(item)}
            style={styles.result}
          >
            <Row gap="md" align="flex-start">
              <Icon name={ICONS[item.kind]} color={theme.colors.textSecondary} />

              <View style={styles.fill}>
                {/*
                  Three lines, one fact each, in the order a reader ranks them: what kind of
                  record this is, the record itself, then which case it lives in.

                  It was `KIND_LABELS[item.kind] · item.context` on one line above the title —
                  a dot-joined meta string that made a classifier and a location read as a
                  single blurred label, and left the thing the reader actually searched for
                  as the second thing on the row.

                  The singular label, not the raw `item.kind`. That printed the filter's
                  plural into a line about one record — "Entities" — which is not a word this
                  product says to anyone.
                */}
                <Text variant="caption" colorToken="textTertiary">
                  {KIND_LABELS[item.kind]}
                </Text>
                <Text variant="subheading" numberOfLines={2} style={{ marginTop: theme.spacing.xxs }}>
                  {item.title}
                </Text>
                <Text
                  variant="caption"
                  colorToken="textSecondary"
                  numberOfLines={1}
                  style={{ marginTop: theme.spacing.xxs }}
                >
                  {item.context}
                </Text>
                {item.text ? (
                  <Text
                    variant="bodySmall"
                    colorToken="textSecondary"
                    numberOfLines={3}
                    style={{ marginTop: theme.spacing.xs }}
                  >
                    {searchSnippet(item, activeQuery)}
                  </Text>
                ) : null}
              </View>

              <Icon name="chevron-right" color={theme.colors.textTertiary} />
            </Row>
          </Pressable>
        )}
        ListEmptyComponent={
          loading ? (
            <ResultsSkeleton />
          ) : failure ? (
            <ErrorState
              title="Your records could not be read"
              message={readableError(
                failure,
                'Search needs to read your saved cases first, and that did not finish. Check your connection and try again.',
              )}
              detail={errorDetail(failure)}
              onRetry={() => setAttempt((value) => value + 1)}
            />
          ) : !ownerId ? (
            <EmptyState
              icon="account-outline"
              title="Sign in to search"
              message="Search looks through your own cases and documents, so it needs to know who you are."
              action={{ label: 'Sign in', onPress: () => router.replace('/sign-in') }}
            />
          ) : !index.length ? (
            <EmptyState
              icon="folder-open-outline"
              title="Nothing to search yet"
              message="Create a case and add a document. Everything you save becomes searchable here — including the text read out of your documents."
              action={{ label: 'Create a case', onPress: () => router.replace('/new-case') }}
            />
          ) : (
            <EmptyState
              icon="magnify"
              title="No matching records"
              message="Try another name, date, phrase or document title, or change the filter."
            />
          )
        }
        ListFooterComponent={
          results.length > limit ? (
            <Button
              label={`Show ${Math.min(PAGE_SIZE, results.length - limit)} more results`}
              variant="secondary"
              onPress={() => setLimit((count) => count + PAGE_SIZE)}
            />
          ) : null
        }
      />
    </View>
  );
}

/**
 * The shape of the list that is coming, while it is being built.
 *
 * `SkeletonList` was wrong here: it stacks `SkeletonCard`s, and the results below are not
 * cards — they are flat rows separated by a rule. Four rounded panels resolving into
 * borderless rows reads as the screen changing its mind about what it is showing, which is
 * the one thing a placeholder must not do. These are the row: glyph, kind line, title.
 */
function ResultsSkeleton() {
  return (
    <Stack gap="none">
      {Array.from({ length: 5 }).map((_, index) => (
        <View key={index} style={styles.result}>
          <Row gap="md" align="flex-start">
            <Skeleton width={SPACING.lg} height={SPACING.lg} radius="xs" />
            <Stack gap="sm" style={styles.fill}>
              <Skeleton width="34%" height={SPACING.md} />
              <Skeleton width="78%" height={SPACING.lg} />
            </Stack>
          </Row>
        </View>
      ))}
    </Stack>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { paddingTop: SPACING.md },
  // A chip on its own is shorter than the smallest reliably tappable target.
  filter: { minHeight: HIT_TARGET, justifyContent: 'center' },
  // The list rhythm the rest of the app's rows use. It was 20, which is off the 4pt grid
  // and taller than every other row in the product.
  result: { paddingVertical: SPACING.lg },
});

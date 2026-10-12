import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  destinationFor,
  isCancelled,
  readableError,
  searchEverything,
  worthRetrying,
  type SearchResult,
  type SearchResultType,
} from '@api';
import {
  Divider,
  EmptyState,
  ErrorState,
  Icon,
  IconTile,
  Pressable,
  ScreenList,
  SkeletonList,
  Text,
  TextField,
  formatAbsoluteDate,
  useTheme,
  type IconName,
} from '@ui';

type Filter = SearchResultType | 'all';

const KINDS: Record<SearchResultType, { word: string; icon: IconName; tone: 'info' | 'accent' | 'ok' | 'neutral' }> = {
  record: { word: 'Entry', icon: 'file-document-outline', tone: 'info' },
  meeting: { word: 'Meeting', icon: 'microphone-outline', tone: 'accent' },
  task: { word: 'To-do', icon: 'check-circle-outline', tone: 'ok' },
  case: { word: 'Case', icon: 'scale-balance', tone: 'neutral' },
};

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'record', label: 'Entries' },
  { value: 'meeting', label: 'Meetings' },
  { value: 'task', label: 'To-dos' },
  { value: 'case', label: 'Cases' },
];

const TYPING_SETTLE_MS = 280;

const MIN_QUERY_LENGTH = 2;

type Phase = 'empty' | 'searching' | 'results' | 'failed';

export default function SearchScreen() {
  const theme = useTheme();

  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [phase, setPhase] = useState<Phase>('empty');
  const [problem, setProblem] = useState<string | null>(null);

  const [retryable, setRetryable] = useState(true);

  const [searched, setSearched] = useState('');

  const query = text.trim();
  const tooShort = query.length > 0 && query.length < MIN_QUERY_LENGTH;

  const inFlight = useRef<AbortController | null>(null);
  const sequence = useRef(0);

  const run = useCallback(
    async (wanted: string, within: Filter) => {
      inFlight.current?.abort();

      if (wanted.length < MIN_QUERY_LENGTH) {
        inFlight.current = null;
        sequence.current += 1;
        setResults([]);
        setSearched('');
        setProblem(null);
        setPhase('empty');
        return;
      }

      const controller = new AbortController();
      inFlight.current = controller;
      const ticket = (sequence.current += 1);

      setPhase('searching');
      setProblem(null);

      try {
        const found = await searchEverything(wanted, {
          kind: within === 'all' ? undefined : within,
          signal: controller.signal,
        });
        if (ticket !== sequence.current) return;
        setResults(found);
        setSearched(wanted);
        setPhase('results');
      } catch (cause) {

        if (isCancelled(cause) || controller.signal.aborted || ticket !== sequence.current) return;
        setResults([]);
        setSearched(wanted);

        setProblem(readableError(cause, 'The search could not be completed. Try again in a moment.'));
        setRetryable(worthRetrying(cause));
        setPhase('failed');
      }
    },
    [],
  );

  useEffect(() => {
    const timer = setTimeout(() => void run(query, filter), TYPING_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [query, filter, run]);

  useEffect(() => () => inFlight.current?.abort(), []);

  const retry = useCallback(() => void run(query, filter), [run, query, filter]);

  const open = useCallback((result: SearchResult) => {

    router.push(destinationFor(result));
  }, []);

  const filters = useMemo(
    () => (
      <View style={[styles.filters, { gap: theme.spacing.sm }]}>
        {FILTERS.map((option) => {
          const active = option.value === filter;
          return (
            <Pressable
              key={option.value}
              onPress={() => setFilter(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Search ${option.label.toLowerCase()}`}
              pressScale={0.96}
              style={{
                paddingVertical: theme.spacing.sm,
                paddingHorizontal: theme.spacing.lg,
                borderRadius: theme.radius.pill,
                backgroundColor: active ? theme.tone('accent').bg : theme.colors.surfaceSunken,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: active ? theme.tone('accent').border : theme.colors.border,
              }}
            >
              <Text variant="label" colorToken={active ? 'accent' : 'textSecondary'}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    ),
    [filter, theme],
  );

  const header = (
    <View style={{ gap: theme.spacing.lg, marginBottom: theme.spacing.lg }}>
      <TextField
        value={text}
        onChangeText={setText}
        icon="magnify"
        placeholder="A name, an amount, what it was for"
        accessibilityLabel="What are you looking for"
        autoFocus
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        onSubmitEditing={() => void run(query, filter)}
        hint={tooShort ? 'Keep typing — two letters or more.' : undefined}
        trailing={
          text.length > 0 ? (
            <Pressable
              onPress={() => setText('')}
              accessibilityRole="button"
              accessibilityLabel="Clear what you typed"
              hitSlop={10}
              pressScale={0.9}
            >
              <Icon name="close-circle" size={18} color={theme.colors.textTertiary} />
            </Pressable>
          ) : null
        }
      />
      {filters}
      {phase === 'results' && results.length > 0 ? (
        <Text variant="caption" colorToken="textSecondary">
          {results.length === 1 ? '1 match' : `${results.length} matches`}
        </Text>
      ) : null}
    </View>
  );

  const narrowed = filter !== 'all';

  let empty: React.ReactNode;
  if (phase === 'searching') {
    empty = <SkeletonList count={4} />;
  } else if (phase === 'failed') {
    empty = (
      <ErrorState
        title="Search did not work"
        message={problem ?? 'Try again in a moment.'}
        {...(retryable ? { onRetry: retry } : {})}
      />
    );
  } else if (phase === 'results') {
    empty = (
      <EmptyState
        icon="text-search"
        title={`Nothing matched “${searched}”`}
        message={
          narrowed
            ? 'Nothing in this section matched. Try searching everything, or use fewer words.'
            : 'Try fewer words, or the name or amount exactly as it appears on the entry.'
        }
        action={narrowed ? { label: 'Search everything', onPress: () => setFilter('all') } : undefined}
      />
    );
  } else {
    empty = (
      <EmptyState
        icon="magnify"
        title="Find anything you have saved"
        message="Entries, meetings, to-dos and cases are all searched together. A shop name, a person, an amount, or what something was for."
      />
    );
  }

  return (
    <ScreenList<SearchResult>
      title="Search"
      back
      data={results}
      keyExtractor={(item) => `${item.type}:${item.id}`}
      listHeader={header}
      empty={empty}
      renderItem={(item) => <ResultRow result={item} onPress={() => open(item)} />}
    />
  );
}

function ResultRow({ result, onPress }: { result: SearchResult; onPress: () => void }) {
  const theme = useTheme();
  const kind = KINDS[result.type];
  const when = result.occurredAt === null ? null : formatAbsoluteDate(result.occurredAt);

  return (
    <View>
      <Pressable
        onPress={onPress}
        dimOnPress
        pressScale={0}
        accessibilityRole="button"
        accessibilityLabel={[kind.word, result.title, result.amountLabel, when].filter(Boolean).join(', ')}
        style={{ paddingVertical: theme.spacing.lg }}
        contentStyle={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}
      >
        <IconTile icon={kind.icon} tone={kind.tone} size="md" />

        <View style={[styles.body, { gap: theme.spacing.xxs }]}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {result.title}
          </Text>
          {result.subtitle ? (
            <Text variant="bodySmall" colorToken="textSecondary" numberOfLines={1}>
              {result.subtitle}
            </Text>
          ) : null}
          <Text variant="caption" colorToken="textTertiary">
            {when ? `${kind.word} · ${when}` : kind.word}
          </Text>
        </View>

        {result.amountLabel ? (
          <Text variant="monoSmall" colorToken="text">
            {result.amountLabel}
          </Text>
        ) : null}

        <Icon name="chevron-right" size={18} color={theme.colors.textTertiary} />
      </Pressable>
      <Divider />
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', flexWrap: 'wrap' },
  body: { flex: 1 },
});

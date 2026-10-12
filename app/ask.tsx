import { RecordingPresets, requestRecordingPermissionsAsync, useAudioRecorder } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { askDaybook, readableError, type DaybookAnswer, type DaybookSource } from '@api';
import { useTranslation } from '@i18n';
import {
  AIChatComposer,
  AudioWaveformVisualizer,
  Button,
  Chip,
  GlassSurface,
  HIT_TARGET,
  Icon,
  MOTION,
  Notice,
  Pressable,
  RADIUS,
  Row,
  SPACING,
  ScreenScroll,
  ShinyText,
  SpotlightCard,
  Stack,
  Stagger,
  Surface,
  Text,
  useReducedMotion,
  useTheme,
  useToast,
  type IconName,
} from '@ui';

const QUESTION_LIMIT = 500;

const SOURCE_ICON: Record<DaybookSource['type'], IconName> = {
  record: 'file-document-outline',
  meeting: 'microphone-outline',
  task: 'checkbox-marked-circle-outline',
};

const PROMPT_CATEGORIES = [
  {
    key: 'all',
    title: 'Featured',
    icon: 'star-four-points-outline' as IconName,
    prompts: [
      'What did we decide in our last meeting?',
      'How much have I spent this month?',
      'Who has action items and follow-ups assigned?',
      'What can D-Detect do and how does it protect evidence?',
    ],
  },
  {
    key: 'meetings',
    title: 'Meetings & Audio',
    icon: 'microphone' as IconName,
    prompts: [
      'What did we decide in our last meeting?',
      'Who has action items and follow-ups assigned?',
      'Summarize key commitments from recent recordings',
    ],
  },
  {
    key: 'documents',
    title: 'Documents & Expenses',
    icon: 'file-document-outline' as IconName,
    prompts: [
      'How much have I spent this month?',
      'What bills or receipts did I scan recently?',
      'Summarize recent payments and expenses',
    ],
  },
  {
    key: 'cases',
    title: 'Cases & Tasks',
    icon: 'shield-check-outline' as IconName,
    prompts: [
      'What tasks or deadlines are overdue?',
      'How do I create and structure a dispute case?',
      'What evidence is still pending in my active cases?',
    ],
  },
  {
    key: 'general',
    title: 'App Assistant',
    icon: 'help-circle-outline' as IconName,
    prompts: [
      'What is D-Detect and what can you do?',
      'How does Discrepancy Radar detect contradictions?',
      'How do I record a meeting with AI transcription?',
    ],
  },
] as const;

interface Turn {
  id: number;
  question: string;
  state: 'asking' | 'answered' | 'failed';
  answer: DaybookAnswer | null;
  error: unknown;
}

function openSource(source: DaybookSource) {
  if (source.type === 'record') {
    router.push({ pathname: '/record/[id]', params: { id: source.id } });
  } else if (source.type === 'meeting') {
    router.push({ pathname: '/meeting/[id]', params: { id: source.id } });
  } else {
    router.push({ pathname: '/(tabs)/tasks', params: { focus: source.id } });
  }
}

function sourceHint(type: DaybookSource['type']): string {
  if (type === 'record') return 'Opens this entry';
  if (type === 'meeting') return 'Opens this meeting';
  return 'Opens this in your to-dos';
}

export default function AskScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const counter = useRef(0);
  const asking = useRef(false);

  const [isListening, setIsListening] = useState(false);
  const voiceRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recognitionRef = useRef<any>(null);

  const busy = turns.some((turn) => turn.state === 'asking');

  const toggleVoiceInput = useCallback(async () => {
    try {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      if (isListening) {
        setIsListening(false);
        if (recognitionRef.current) {
          try {
            recognitionRef.current.stop();
          } catch {}
          recognitionRef.current = null;
        }
        try {
          if (voiceRecorder.isRecording) await voiceRecorder.stop();
        } catch {}
        return;
      }

      const nav = typeof window !== typeof undefined ? (window as any) : null;
      const SpeechClass = nav?.SpeechRecognition || nav?.webkitSpeechRecognition;
      if (SpeechClass) {
        const rec = new SpeechClass();
        rec.continuous = false;
        rec.interimResults = false;
        rec.lang = 'en-US';
        rec.onresult = (event: any) => {
          const spoken = event.results?.[0]?.[0]?.transcript;
          if (spoken) {
            setQuestion(spoken.trim());
          }
          setIsListening(false);
        };
        rec.onerror = () => setIsListening(false);
        rec.onend = () => setIsListening(false);
        recognitionRef.current = rec;
        rec.start();
        setIsListening(true);
        return;
      }

      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) return;
      setIsListening(true);
      await voiceRecorder.prepareToRecordAsync();
      voiceRecorder.record();
    } catch {
      setIsListening(false);
    }
  }, [isListening, voiceRecorder]);

  const send = useCallback(async (id: number, text: string) => {
    asking.current = true;
    try {
      const answer = await askDaybook(text);
      setTurns((prev) =>
        prev.map((turn) => (turn.id === id ? { ...turn, state: 'answered', answer, error: null } : turn)),
      );
    } catch (error) {
      setTurns((prev) =>
        prev.map((turn) => (turn.id === id ? { ...turn, state: 'failed', answer: null, error } : turn)),
      );
    } finally {
      asking.current = false;
    }
  }, []);

  const clearChat = useCallback(() => {
    setTurns([]);
    setQuestion('');
  }, []);

  const ask = useCallback(
    (raw: string) => {
      const text = raw.trim().slice(0, QUESTION_LIMIT);
      if (!text || asking.current) return;
      const id = (counter.current += 1);
      setTurns((prev) => [...prev, { id, question: text, state: 'asking', answer: null, error: null }]);
      setQuestion('');
      void send(id, text);
    },
    [send],
  );

  const retry = useCallback(
    (turn: Turn) => {
      if (asking.current) return;
      setTurns((prev) =>
        prev.map((item) => (item.id === turn.id ? { ...item, state: 'asking', error: null } : item)),
      );
      void send(turn.id, turn.question);
    },
    [send],
  );

  return (
    <ScreenScroll
      title={t('ask.title') || 'Assistant'}
      overline={t('ask.overline') || 'Product Intelligence'}
      subtitle={t('ask.subtitle') || 'Context-aware intelligence for meetings, documents, timeline, and disputes.'}
      back
      actions={turns.length > 0 ? [{ icon: 'refresh', label: 'Start new chat', onPress: clearChat }] : []}
      footer={
        <AIChatComposer
          value={question}
          onChangeText={setQuestion}
          onSubmit={() => ask(question)}
          isListening={isListening}
          onToggleVoice={() => void toggleVoiceInput()}
          isBusy={busy}
          placeholder={isListening ? 'Listening to your voice...' : 'Ask about meetings, documents, tasks, or general help...'}
          maxLength={QUESTION_LIMIT}
        />
      }
    >
      <Stack gap="lg">
        {turns.length === 0 ? (
          <IdlePanel onAsk={ask} />
        ) : (
          <Stack gap="xl">
            {turns.map((turn) => (
              <TurnCard key={turn.id} turn={turn} busy={busy} onAsk={ask} onRetry={() => retry(turn)} />
            ))}
          </Stack>
        )}
      </Stack>
    </ScreenScroll>
  );
}

function IdlePanel({ onAsk }: { onAsk: (question: string) => void }) {
  const theme = useTheme();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');

  const currentCategory =
    PROMPT_CATEGORIES.find((cat) => cat.key === selectedCategory) ?? PROMPT_CATEGORIES[0];

  return (
    <Stack gap="lg">
      <SpotlightCard
        glowColor="rgba(58, 134, 255, 0.35)"
        edgeColor="rgba(0, 240, 255, 0.25)"
        borderRadius={24}
        style={{ padding: SPACING.xl }}
      >
        <Stack gap="md" style={{ width: '100%' }}>
          <Row gap="sm" align="center">
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                backgroundColor: 'rgba(58, 134, 255, 0.15)',
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: 'rgba(58, 134, 255, 0.35)',
              }}
            >
              <Icon name="star-four-points" size={20} color="#00F0FF" />
            </View>
            <Stack gap="none" style={{ flex: 1 }}>
              <ShinyText
                text="D-Detect AI Assistant"
                style={{ fontSize: 18, fontWeight: '700' }}
              />
              <Text variant="caption" colorToken="textTertiary">
                Grounded in your meetings, documents & timeline data
              </Text>
            </Stack>
          </Row>

          <Text variant="bodySmall" colorToken="textSecondary">
            Ask questions about meeting decisions, action items, uploaded bills, spending patterns, dispute cases, or how to use any feature in D-Detect.
          </Text>

          {}
          <Row wrap gap="xs" style={{ marginTop: SPACING.xs }}>
            {PROMPT_CATEGORIES.map((cat) => {
              const active = cat.key === selectedCategory;
              return (
                <Pressable
                  key={cat.key}
                  onPress={() => setSelectedCategory(cat.key)}
                  accessibilityRole="button"
                  accessibilityLabel={cat.title}
                  dimOnPress
                  pressScale={0.96}
                >
                  <Chip
                    label={cat.title}
                    icon={cat.icon}
                    tone={active ? 'accent' : 'neutral'}
                    emphasis={active ? 'solid' : 'outline'}
                    size="sm"
                  />
                </Pressable>
              );
            })}
          </Row>

          <Row gap="xs" align="center" style={{ marginTop: SPACING.xs }}>
            <Icon name="lightbulb-outline" size={16} color={theme.colors.accent} />
            <Text variant="label" colorToken="textSecondary">
              Prompt suggestions ({currentCategory.title})
            </Text>
          </Row>

          <Stack gap="sm">
            {currentCategory.prompts.map((prompt) => (
              <Pressable
                key={prompt}
                onPress={() => onAsk(prompt)}
                dimOnPress
                pressScale={0.98}
                style={{
                  borderRadius: theme.radius.md,
                  borderWidth: 1,
                  borderColor: 'rgba(255, 255, 255, 0.08)',
                  backgroundColor: 'rgba(10, 19, 41, 0.65)',
                }}
                contentStyle={styles.suggestionRow}
                accessibilityRole="button"
                accessibilityLabel={`Ask: ${prompt}`}
              >
                <Icon name="arrow-right" size={16} color={theme.colors.accent} />
                <Text variant="bodySmall" style={styles.flex}>
                  {prompt}
                </Text>
              </Pressable>
            ))}
          </Stack>
        </Stack>
      </SpotlightCard>

      {}
      <GlassSurface padding="lg" radius="xl">
        <Stack gap="md">
          <Text variant="overline" colorToken="textTertiary" uppercase>
            Direct Capabilities
          </Text>
          <Row wrap gap="sm">
            <Button
              label="Record Meeting"
              icon="microphone"
              variant="secondary"
              size="sm"
              onPress={() => router.push({ pathname: '/capture', params: { mode: 'meeting' } })}
            />
            <Button
              label="Scan Document"
              icon="crop-free"
              variant="secondary"
              size="sm"
              onPress={() => router.push('/capture')}
            />
            <Button
              label="View Cases"
              icon="scale-balance"
              variant="ghost"
              size="sm"
              onPress={() => router.push('/(tabs)/cases')}
            />
            <Button
              label="To-Do Items"
              icon="checkbox-marked-circle-outline"
              variant="ghost"
              size="sm"
              onPress={() => router.push('/(tabs)/tasks')}
            />
          </Row>
        </Stack>
      </GlassSurface>
    </Stack>
  );
}

interface TurnCardProps {
  turn: Turn;
  busy: boolean;
  onAsk: (question: string) => void;
  onRetry: () => void;
}

function TurnCard({ turn, busy, onAsk, onRetry }: TurnCardProps) {
  return (
    <Stack gap="md">
      <UserBubble question={turn.question} />
      {turn.state === 'asking' ? (
        <Thinking />
      ) : turn.state === 'failed' ? (
        <Stack gap="md">
          <Notice
            tone="danger"
            icon="alert-circle-outline"
            message={readableError(
              turn.error,
              'That question could not be answered right now. Please check your connection and try again.',
            )}
          />
          <Button label="Ask it again" variant="secondary" icon="refresh" onPress={onRetry} disabled={busy} />
          {busy ? (
            <Text variant="caption" colorToken="textTertiary">
              Another question is being answered. You can ask this one again once that is done.
            </Text>
          ) : null}
        </Stack>
      ) : turn.answer ? (
        <AnswerCard answer={turn.answer} busy={busy} onAsk={onAsk} />
      ) : null}
    </Stack>
  );
}

function UserBubble({ question }: { question: string }) {
  const theme = useTheme();
  return (
    <View style={{ alignSelf: 'flex-end', maxWidth: '85%' }}>
      <Surface
        radius="lg"
        padding="md"
        style={{
          backgroundColor: 'rgba(37, 99, 235, 0.22)',
          borderColor: 'rgba(56, 189, 248, 0.35)',
          borderWidth: 1,
        }}
      >
        <Row gap="xs" align="center" style={{ marginBottom: 4 }}>
          <Icon name="account" size={14} color={theme.colors.accent} />
          <Text variant="caption" colorToken="textTertiary" uppercase style={{ fontSize: 10, letterSpacing: 0.8 }}>
            You
          </Text>
        </Row>
        <Text variant="bodyMedium" colorToken="text">
          {question}
        </Text>
      </Surface>
    </View>
  );
}

const THINKING_STEPS = [
  'Checking query context & intent...',
  'Scanning meetings, documents & timeline data...',
  'Cross-referencing verified dates and decisions...',
  'Synthesizing intelligent product response...',
];

function Thinking() {
  const theme = useTheme();
  const cloudPulse = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      Animated.sequence([
        Animated.timing(fadeAnim, { toValue: 0.2, duration: 250, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      ]).start();
      setStep((prev) => (prev + 1) % THINKING_STEPS.length);
    }, 2000);
    return () => clearInterval(timer);
  }, [fadeAnim]);

  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(cloudPulse, { toValue: 1, duration: 1200, useNativeDriver: true }),
        Animated.timing(cloudPulse, { toValue: 0, duration: 1200, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [cloudPulse, reduced]);

  const cloudScale = cloudPulse.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.1] });
  const cloudOpacity = cloudPulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0.75] });

  return (
    <SpotlightCard glowColor="rgba(0, 240, 255, 0.3)" borderRadius={22} style={{ padding: SPACING.lg }}>
      <Stack gap="md" style={{ width: '100%' }}>
        <Row gap="md" align="center" justify="space-between" style={{ width: '100%' }}>
          <Row gap="sm" align="center" style={{ flex: 1, flexShrink: 1 }}>
            <View style={{ width: 32, height: 32, alignItems: 'center', justifyContent: 'center' }}>
              <Animated.View
                style={{
                  position: 'absolute',
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  backgroundColor: 'rgba(0, 240, 255, 0.15)',
                  transform: [{ scale: cloudScale }],
                  opacity: cloudOpacity,
                }}
              />
              <Icon name="cloud-sync-outline" size={20} color="#00F0FF" />
            </View>

            <Animated.View style={{ opacity: fadeAnim, flex: 1, flexShrink: 1 }}>
              <Text variant="bodySmall" numberOfLines={1} style={{ color: '#E2E8F0', fontWeight: '500' }}>
                {THINKING_STEPS[step]}
              </Text>
            </Animated.View>
          </Row>

          <AudioWaveformVisualizer isActive barCount={8} maxHeight={18} tone="accent" />
        </Row>

        <View
          style={{
            height: 4,
            width: '100%',
            borderRadius: 2,
            backgroundColor: 'rgba(255, 255, 255, 0.08)',
            overflow: 'hidden',
          }}
        >
          <Animated.View
            style={{
              height: '100%',
              width: '45%',
              borderRadius: 2,
              backgroundColor: '#00F0FF',
              opacity: cloudOpacity,
              transform: [
                {
                  translateX: cloudPulse.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-20, 180],
                  }),
                },
              ],
            }}
          />
        </View>
      </Stack>
    </SpotlightCard>
  );
}

interface AnswerCardProps {
  answer: DaybookAnswer;
  busy: boolean;
  onAsk: (question: string) => void;
}

function CitationCard({ source }: { source: DaybookSource }) {
  const theme = useTheme();
  const icon = SOURCE_ICON[source.type];
  const typeLabel =
    source.type === 'record' ? 'Document / Record' : source.type === 'meeting' ? 'Meeting' : 'Task';

  return (
    <Pressable
      onPress={() => openSource(source)}
      style={styles.citationPressable}
      accessibilityRole="button"
      accessibilityLabel={`Open ${source.title}`}
      accessibilityHint={sourceHint(source.type)}
      dimOnPress
      pressScale={0.98}
    >
      <Surface radius="md" padding="sm" style={styles.citationSurface}>
        <Row gap="sm" align="center" style={{ width: '100%' }}>
          <Icon name={icon} size={16} color={theme.colors.accent} />
          <Stack gap="none" style={styles.flex}>
            <Text variant="bodySmall" numberOfLines={1}>
              {source.title}
            </Text>
            <Text variant="caption" colorToken="textTertiary">
              {typeLabel}
            </Text>
          </Stack>
          <Icon name="arrow-top-right" size={14} color={theme.colors.textTertiary} />
        </Row>
      </Surface>
    </Pressable>
  );
}

function AnswerCard({ answer, busy, onAsk }: AnswerCardProps) {
  const theme = useTheme();
  const toast = useToast();
  const paragraphs = answer.text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const foundNothing = answer.sources.length === 0;

  return (
    <Stack gap="md" style={{ width: '100%' }}>
      <SpotlightCard
        glowColor="rgba(58, 134, 255, 0.35)"
        edgeColor="rgba(0, 240, 255, 0.2)"
        borderRadius={24}
        style={{ padding: SPACING.xl }}
      >
        <Stack gap="lg" style={{ width: '100%' }}>
          <Row between align="center" style={{ width: '100%' }}>
            <Row gap="sm" align="center">
              <Icon name="star-four-points" size={18} color="#00F0FF" />
              <ShinyText text="D-DETECT INTELLIGENCE" style={{ fontSize: 13, fontWeight: '700', letterSpacing: 1 }} />
            </Row>
            {answer.sources.length > 0 ? (
              <Chip label={`${answer.sources.length} sources`} tone="ok" size="sm" />
            ) : null}
          </Row>

          <Stagger variant="fade" step={PARAGRAPH_STEP} gap="md">
            {paragraphs.map((paragraph, index) => {
              const lines = paragraph.split('\n');
              const isList = lines.length > 1 && lines.some((l) => /^\s*[-*•]\s+/.test(l));

              if (isList) {
                return (
                  <Stack key={index} gap="xs">
                    {lines.map((line, lineIndex) => {
                      const clean = line.replace(/^\s*[-*•]\s+/, '').trim();
                      if (!clean) return null;
                      return (
                        <Row key={lineIndex} gap="sm" align="flex-start">
                          <View style={[styles.bulletDot, { backgroundColor: theme.colors.accent }]} />
                          <Text variant="body" style={styles.flex}>
                            {clean}
                          </Text>
                        </Row>
                      );
                    })}
                  </Stack>
                );
              }

              return (
                <Text key={index} variant="body">
                  {paragraph}
                </Text>
              );
            })}
          </Stagger>

          {answer.sources.length > 0 ? (
            <Stack gap="sm">
              <Text variant="overline" colorToken="textTertiary" uppercase>
                Grounded Provenance
              </Text>
              <Stack gap="xs">
                {answer.sources.map((source) => (
                  <CitationCard key={`${source.type}-${source.id}`} source={source} />
                ))}
              </Stack>
            </Stack>
          ) : null}
        </Stack>
      </SpotlightCard>

      {foundNothing ? (
        <Stack gap="md">
          <Row gap="sm" align="center">
            <Icon name="information-outline" size={16} color={theme.colors.textTertiary} />
            <Text variant="caption" colorToken="textTertiary" style={styles.flex}>
              There was nothing saved in your records to directly answer this.
            </Text>
          </Row>
          <Row gap="sm">
            <Button
              label="Record Meeting"
              icon="microphone"
              variant="secondary"
              size="sm"
              onPress={() => router.push({ pathname: '/capture', params: { mode: 'meeting' } })}
            />
            <Button
              label="Scan Document"
              icon="crop-free"
              variant="secondary"
              size="sm"
              onPress={() => router.push('/capture')}
            />
          </Row>
        </Stack>
      ) : null}

      {answer.followUp ? (
        <Stack gap="sm">
          <Text variant="overline" colorToken="textTertiary" uppercase>
            Suggested Follow-Up
          </Text>
          <Pressable
            onPress={() => onAsk(answer.followUp ?? '')}
            disabled={busy}
            style={styles.chipTarget}
            accessibilityRole="button"
            accessibilityLabel={`Ask this next: ${answer.followUp}`}
          >
            <Chip label={answer.followUp} icon="arrow-right" tone="accent" emphasis="outline" size="md" />
          </Pressable>
        </Stack>
      ) : null}
    </Stack>
  );
}

const PARAGRAPH_STEP = MOTION.stagger * 2;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chipTarget: { minHeight: HIT_TARGET, justifyContent: 'center' },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    minHeight: HIT_TARGET,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
  },
  userBubbleContainer: {
    alignSelf: 'stretch',
  },
  userBubble: {
    borderWidth: 1,
  },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 8,
  },
  citationPressable: {
    minHeight: HIT_TARGET,
  },
  citationSurface: {
    width: '100%',
  },
});

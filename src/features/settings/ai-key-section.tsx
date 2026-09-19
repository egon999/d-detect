/**
 * Reasoning Engine & Provider Settings.
 *
 * Provides a clean, production-grade interface for managing on-device
 * Evidence Reasoning Engine and optional cloud LLM providers (Groq, xAI, Gemini).
 */

import * as Haptics from 'expo-haptics';
import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import {
  AI_PROVIDER_IDS,
  AI_PROVIDER_LABELS,
  clearKey,
  configuredProviders,
  loadKey,
  saveKey,
  secureStorageAvailable,
  type AIProviderId,
} from '@services/ai/credentials';
import {
  Button,
  Chip,
  Divider,
  IconButton,
  Notice,
  Row,
  Surface,
  Text,
  TextField,
  useTheme,
} from '@ui';

interface Feedback {
  tone: 'ok' | 'warn' | 'danger' | 'info';
  title: string;
  message: string;
}

export function AIKeySection() {
  const theme = useTheme();
  const [hasStorage, setHasStorage] = useState<boolean | null>(null);
  const [activeProvider, setActiveProvider] = useState<AIProviderId>('groq');
  const [apiKey, setApiKey] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [configured, setConfigured] = useState<AIProviderId[]>([]);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const refreshProviders = useCallback(async () => {
    try {
      const providers = await configuredProviders();
      setConfigured(providers);
      if (providers.length > 0 && !providers.includes(activeProvider)) {
        setActiveProvider(providers[0]!);
      }
    } catch {
      setConfigured([]);
    }
  }, [activeProvider]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const storageOk = await secureStorageAvailable();
      if (cancelled) return;
      setHasStorage(storageOk);
      if (storageOk) {
        await refreshProviders();
        const existingKey = await loadKey(activeProvider);
        if (!cancelled && existingKey) {
          setApiKey(existingKey);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProvider, refreshProviders]);

  const handleProviderSelect = async (provider: AIProviderId) => {
    setActiveProvider(provider);
    setFeedback(null);
    try {
      const key = await loadKey(provider);
      setApiKey(key ?? '');
    } catch {
      setApiKey('');
    }
  };

  const handleSave = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) return;
    setSaving(true);
    setFeedback(null);
    try {
      await saveKey(activeProvider, trimmed);
      await refreshProviders();
      setFeedback({
        tone: 'ok',
        title: 'API key saved',
        message: `${AI_PROVIDER_LABELS[activeProvider]} key is saved securely in your device keystore.`,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (caught) {
      setFeedback({
        tone: 'danger',
        title: 'Could not save key',
        message: caught instanceof Error ? caught.message : 'Please check key format and try again.',
      });
    } finally {
      setSaving(false);
    }
  }, [activeProvider, apiKey, refreshProviders]);

  const handleClear = useCallback(async () => {
    setSaving(true);
    setFeedback(null);
    try {
      await clearKey(activeProvider);
      setApiKey('');
      await refreshProviders();
      setFeedback({
        tone: 'ok',
        title: 'API key removed',
        message: `${AI_PROVIDER_LABELS[activeProvider]} key has been removed from this device.`,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch {
      setFeedback({
        tone: 'danger',
        title: 'Could not remove key',
        message: 'Failed to clear device secure storage.',
      });
    } finally {
      setSaving(false);
    }
  }, [activeProvider, refreshProviders]);

  const isConfigured = configured.includes(activeProvider);

  return (
    <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
      <Row between align="center" gap="md">
        <View style={{ flex: 1 }}>
          <Text variant="subheading">AI Provider</Text>
          <Text variant="caption" colorToken="textSecondary" style={{ marginTop: 2 }}>
            Add an optional API key to enable AI-powered analysis
          </Text>
        </View>
        {configured.length > 0 ? (
          <Chip
            label={`${configured.length} configured`}
            tone="accent"
            size="sm"
          />
        ) : null}
      </Row>

      <Divider />

      {feedback ? (
        <Notice
          tone={feedback.tone}
          title={feedback.title}
          message={feedback.message}
          onDismiss={() => setFeedback(null)}
        />
      ) : null}

      {!expanded ? (
        <Button
          label={configured.length > 0 ? 'Manage AI Providers' : 'Add AI Provider (Optional)'}
          variant="secondary"
          icon="key-outline"
          onPress={() => setExpanded(true)}
        />
      ) : (
        <View style={{ gap: theme.spacing.md }}>
          <Row between align="center">
            <Text variant="label" colorToken="textSecondary">
              Select Provider
            </Text>
            <Button
              label="Close"
              variant="ghost"
              size="sm"
              onPress={() => setExpanded(false)}
            />
          </Row>

          <Row gap="xs" style={{ flexWrap: 'wrap' }}>
            {AI_PROVIDER_IDS.filter((id) => id !== 'gemini').map((id) => (
              <Button
                key={id}
                label={AI_PROVIDER_LABELS[id]}
                size="sm"
                variant={activeProvider === id ? 'primary' : 'secondary'}
                onPress={() => void handleProviderSelect(id)}
              />
            ))}
          </Row>

          <TextField
            label={`${AI_PROVIDER_LABELS[activeProvider]} API Key`}
            value={apiKey}
            onChangeText={setApiKey}
            placeholder={activeProvider === 'groq' ? 'gsk_...' : 'xai-...'}
            secureTextEntry={!revealed}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            trailing={
              <IconButton
                icon={revealed ? 'eye-off-outline' : 'eye-outline'}
                accessibilityLabel={revealed ? 'Hide API key' : 'Show API key'}
                onPress={() => setRevealed((curr) => !curr)}
              />
            }
          />

          <Row gap="sm">
            <Button
              label={isConfigured ? 'Update Key' : 'Save Key'}
              icon="check"
              loading={saving}
              disabled={saving || !apiKey.trim()}
              onPress={() => void handleSave()}
            />
            {isConfigured ? (
              <Button
                label="Remove Key"
                variant="ghost"
                icon="trash-can-outline"
                disabled={saving}
                onPress={() => void handleClear()}
              />
            ) : null}
          </Row>
        </View>
      )}
    </Surface>
  );
}
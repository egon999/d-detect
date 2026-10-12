import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import { useRouter } from 'expo-router';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';

import {
  DELETE_CONFIRMATION,
  deleteAccount,
  exportAccount,
  getMe,
  readableError,
  updateMe,
  type Me,
  type StoredSummary,
} from '@api';
import { LANGUAGE_OPTIONS, useTranslation, type SupportedLanguage } from '@i18n';
import { readableAuthError, sendDiagnosticReport, useSession } from '@services';
import {
  currencyLabel,
  getStoredCurrency,
  localeLabel,
  resolveCurrency,
  resolveLocale,
  setStoredCurrency,
} from '@services/preferences';
import {
  BottomSheet,
  Button,
  Chip,
  Disclosure,
  Divider,
  EmptyState,
  ErrorState,
  GlassSurface,
  Icon,
  IconButton,
  IconTile,
  IndeterminateBar,
  Notice,
  Pressable,
  ProgressBar,
  Row,
  ScreenScroll,
  Section,
  SegmentedControl,
  Skeleton,
  SlideUpIn,
  Stack,
  Surface,
  Text,
  TextField,
  UserAvatar,
  useTheme,
  useToast,
  type IconName,
  type Tone,
} from '@ui';

const PRODUCT = 'D-Detect';

const APP_VERSION =
  typeof Constants.expoConfig?.version === 'string' && Constants.expoConfig.version.trim()
    ? Constants.expoConfig.version.trim()
    : null;

const MAX_NAME = 80;

const CURRENCY_CHOICES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'] as const;

const LOCALE_CHOICES = ['en-IN', 'hi-IN', 'en-GB', 'en-US'] as const;

type Failure = string;

function sessionFailure(cause: unknown): Failure {
  return readableAuthError(cause);
}

function accountFailure(cause: unknown, fallback: string): Failure {
  return readableError(cause, fallback);
}

function countPhrase(count: number, one: string, many: string): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? one : many}`;
}

function listed(parts: Array<string | null>): string | null {
  const kept = parts.filter((part): part is string => part !== null);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0] ?? null;
  return `${kept.slice(0, -1).join(', ')} and ${kept.at(-1) ?? ''}`;
}

function storedLine(stored: StoredSummary): string {
  const counts = listed([
    countPhrase(stored.entries, 'entry', 'entries'),
    countPhrase(stored.meetings, 'meeting', 'meetings'),
    countPhrase(stored.files, 'file', 'files'),
  ]);
  if (!counts) return 'Nothing yet';
  return stored.files > 0 ? `${counts} · ${stored.sizeLabel}` : counts;
}

function deleteLine(stored: StoredSummary): string {
  const everything = listed([
    countPhrase(stored.entries, 'entry', 'entries'),
    countPhrase(stored.meetings, 'meeting', 'meetings'),
    countPhrase(stored.tasks, 'task', 'tasks'),
    countPhrase(stored.cases, 'case', 'cases'),
    countPhrase(stored.files, 'stored file', 'stored files'),
  ]);
  if (!everything) return 'Your account is removed. There is nothing stored in it.';
  const size = stored.files > 0 ? `, ${stored.sizeLabel} in all` : '';
  return `Your account goes, and with it ${everything}${size}. The files are deleted, not hidden.`;
}

function SettingsGroup({ children }: { children: React.ReactNode }) {
  const items = React.Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;
  return (
    <Surface radius="lg" style={{ overflow: 'hidden' }}>
      {items.map((child, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <Divider /> : null}
          {child}
        </React.Fragment>
      ))}
    </Surface>
  );
}

interface SettingRowProps {
  icon: IconName;
  tone?: 'neutral' | 'accent' | 'danger';
  title: string;
  value?: string;
  onPress?: () => void;
  accessibilityHint?: string;
}

function SettingRow({ icon, tone = 'neutral', title, value, onPress, accessibilityHint }: SettingRowProps) {
  const theme = useTheme();
  const padding = { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.lg };
  const body = (
    <Row gap="md" align="center">
      <IconTile icon={icon} tone={tone} />
      <Text variant="bodyMedium" numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>
        {title}
      </Text>
      {value ? (
        <Text
          variant="bodySmall"
          colorToken="textSecondary"
          numberOfLines={1}
          style={{ maxWidth: '48%', textAlign: 'right' }}
        >
          {value}
        </Text>
      ) : null}
      {onPress ? <Disclosure /> : null}
    </Row>
  );
  if (!onPress) {
    return <View style={padding}>{body}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      pressScale={1}
      accessibilityRole="button"
      accessibilityLabel={value ? `${title}. ${value}` : title}
      contentStyle={padding}
      {...(accessibilityHint ? { accessibilityHint } : {})}
    >
      {body}
    </Pressable>
  );
}

interface StatCardProps {
  label: string;
  value: number;
  subtitle: string;
  icon: IconName;
  tone?: Tone;
  onPress: () => void;
  accessibilityHint: string;
}

function StatCard({
  label,
  value,
  subtitle,
  icon,
  tone = 'accent',
  onPress,
  accessibilityHint,
}: StatCardProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      pressScale={0.97}
      dimOnPress
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}. ${subtitle}`}
      accessibilityHint={accessibilityHint}
      style={{
        flex: 1,
        minWidth: 140,
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        overflow: 'hidden',
      }}
      contentStyle={{
        padding: theme.spacing.md,
      }}
    >
      <Row between align="center">
        <IconTile icon={icon} tone={tone} size="sm" />
        <Icon name="chevron-right" size={16} color={theme.colors.textTertiary} />
      </Row>
      <Stack gap="xxs" style={{ marginTop: theme.spacing.sm }}>
        <Text variant="statValue" mono tone={tone}>
          {String(value)}
        </Text>
        <Text variant="bodySmall" style={{ fontWeight: '600' }}>
          {label}
        </Text>
        <Text variant="caption" colorToken="textTertiary">
          {subtitle}
        </Text>
      </Stack>
    </Pressable>
  );
}

function formatBytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function ChoiceRow({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      pressScale={1}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      style={{ borderRadius: theme.radius.md }}
      contentStyle={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.sm,
      }}
    >
      <Text variant="body" style={{ flex: 1 }}>
        {label}
      </Text>
      {selected ? <Icon name="check" size={20} color={theme.colors.accent} /> : null}
    </Pressable>
  );
}

function SheetHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.md }}>
      <Row between align="flex-start" gap="md">
        <Stack gap="xxs" style={{ flex: 1 }}>
          <Text variant="heading">{title}</Text>
          {subtitle ? (
            <Text variant="bodySmall" colorToken="textSecondary">
              {subtitle}
            </Text>
          ) : null}
        </Stack>
        <IconButton icon="close" accessibilityLabel="Close" onPress={onClose} />
      </Row>
    </View>
  );
}

function SheetBody({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{
        paddingHorizontal: theme.spacing.xl,
        paddingTop: theme.spacing.sm,
        paddingBottom: theme.spacing.xl,
      }}
    >
      <Stack gap="lg">{children}</Stack>
    </ScrollView>
  );
}

function SheetFailure({ failure }: { failure: Failure | null }) {
  if (!failure) return null;
  return <Notice tone="danger" icon="alert-circle-outline" message={failure} />;
}

function LoadingYou() {
  const theme = useTheme();
  const rowPadding = { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.lg };

  const rows = (count: number) => (
    <Surface radius="lg" style={{ overflow: 'hidden' }}>
      {Array.from({ length: count }, (_unused, index) => (
        <React.Fragment key={index}>
          {index > 0 ? <Divider /> : null}
          <View style={rowPadding}>
            <Row gap="md" align="center">
              <Skeleton width={theme.layout.tileSize} height={theme.layout.tileSize} radius="md" />
              <Stack gap="xxs" style={{ flex: 1 }}>
                <Skeleton width="45%" height={theme.type.bodyMedium.lineHeight} />
                <Skeleton width="70%" height={theme.type.bodySmall.lineHeight} />
              </Stack>
            </Row>
          </View>
        </React.Fragment>
      ))}
    </Surface>
  );

  return (
    <ScreenScroll title="You" subtitle="Account profile, evidence vault & preferences">
      <View>
        <Surface radius="lg" padding="xl">
          <Row gap="lg" align="center">
            <Skeleton
              width={theme.spacing.colossal}
              height={theme.spacing.colossal}
              radius="pill"
            />
            <Stack gap="xs" style={{ flex: 1 }}>
              <Skeleton width="55%" height={theme.type.heading.lineHeight} />
              <Skeleton width="75%" height={theme.type.bodySmall.lineHeight} />
              <Skeleton width="45%" height={24} radius="pill" />
            </Stack>
          </Row>
          <Divider spacing="lg" />
          <Row gap="sm">
            <Skeleton width="31%" height={36} radius="sm" />
            <Skeleton width="31%" height={36} radius="sm" />
            <Skeleton width="31%" height={36} radius="sm" />
          </Row>
        </Surface>

        <View style={{ marginTop: theme.spacing.md }}>
          <Row gap="sm">
            <Surface radius="lg" padding="md" style={{ flex: 1 }}>
              <Skeleton width={28} height={28} radius="sm" />
              <View style={{ height: theme.spacing.sm }} />
              <Skeleton width="50%" height={theme.type.statValue.lineHeight} />
              <Skeleton width="70%" height={theme.type.bodySmall.lineHeight} />
            </Surface>
            <Surface radius="lg" padding="md" style={{ flex: 1 }}>
              <Skeleton width={28} height={28} radius="sm" />
              <View style={{ height: theme.spacing.sm }} />
              <Skeleton width="50%" height={theme.type.statValue.lineHeight} />
              <Skeleton width="70%" height={theme.type.bodySmall.lineHeight} />
            </Surface>
          </Row>
          <View style={{ height: theme.spacing.sm }} />
          <Row gap="sm">
            <Surface radius="lg" padding="md" style={{ flex: 1 }}>
              <Skeleton width={28} height={28} radius="sm" />
              <View style={{ height: theme.spacing.sm }} />
              <Skeleton width="50%" height={theme.type.statValue.lineHeight} />
              <Skeleton width="70%" height={theme.type.bodySmall.lineHeight} />
            </Surface>
            <Surface radius="lg" padding="md" style={{ flex: 1 }}>
              <Skeleton width={28} height={28} radius="sm" />
              <View style={{ height: theme.spacing.sm }} />
              <Skeleton width="50%" height={theme.type.statValue.lineHeight} />
              <Skeleton width="70%" height={theme.type.bodySmall.lineHeight} />
            </Surface>
          </Row>
        </View>

        <Surface radius="lg" padding="lg" style={{ marginTop: theme.spacing.md }}>
          <Row between align="center">
            <Skeleton width="40%" height={theme.type.bodyMedium.lineHeight} />
            <Skeleton width="25%" height={theme.type.statValue.lineHeight} />
          </Row>
          <View style={{ height: theme.spacing.sm }} />
          <Skeleton width="100%" height={6} radius="pill" />
        </Surface>

        <Section title="Appearance">{rows(1)}</Section>
        <Section title="Preferences">{rows(3)}</Section>
        <Section title="System">{rows(2)}</Section>
      </View>
    </ScreenScroll>
  );
}

export default function YouScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const {
    status,
    user,
    isLocal,
    signOut,
    sendPasswordReset,
    updateUserPassword,
    updateUserProfile,
  } = useSession();

  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadFailure, setLoadFailure] = useState<Failure | null>(null);

  const { language, setLanguage, t } = useTranslation();

  const [sheet, setSheet] = useState<
    'name' | 'currency' | 'dates' | 'language' | 'password' | 'stored' | 'export' | 'delete' | 'help' | 'signout' | null
  >(null);
  const [busy, setBusy] = useState<
    'idle' | 'name' | 'currency' | 'dates' | 'language' | 'password' | 'reset' | 'export' | 'delete' | 'signOut'
  >('idle');

  const [localCurrency, setLocalCurrency] = useState<string | null>(null);

  useEffect(() => {
    void getStoredCurrency().then(setLocalCurrency);
  }, []);

  const [nameDraft, setNameDraft] = useState('');
  const [nameFailure, setNameFailure] = useState<Failure | null>(null);

  const [currencyDraft, setCurrencyDraft] = useState('');
  const [currencyFailure, setCurrencyFailure] = useState<Failure | null>(null);

  const [currencyNote, setCurrencyNote] = useState<string | null>(null);

  const [localeFailure, setLocaleFailure] = useState<Failure | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordFailure, setPasswordFailure] = useState<Failure | null>(null);

  const [exportFailure, setExportFailure] = useState<Failure | null>(null);

  const [deleteDraft, setDeleteDraft] = useState('');
  const [deleteFailure, setDeleteFailure] = useState<Failure | null>(null);

  const accountBacked = !isLocal;

  const load = useCallback(
    async (mode: 'first' | 'again') => {
      if (mode === 'first') setLoading(true);
      else setRefreshing(true);
      try {
        const next = await getMe();
        setMe(next);
        setLoadFailure(null);
      } catch (cause) {
        if (accountBacked) {
          setLoadFailure(accountFailure(cause, 'Your account details could not be loaded. Please try again.'));
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [accountBacked],
  );

  useEffect(() => {
    if (status !== 'signedIn') {
      setLoading(false);
      return;
    }
    void load('first');
  }, [status, load]);

  const effectiveLocale = resolveLocale(me?.locale ?? null);

  const openedAt = useMemo(() => {
    const stamp = me?.createdAt ?? user?.createdAt ?? null;
    if (!stamp) return null;
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) return null;

    return date.toLocaleDateString(effectiveLocale, { month: 'long', year: 'numeric' });
  }, [me?.createdAt, user?.createdAt, effectiveLocale]);

  const busyElsewhere = busy !== 'idle';

  const closeSheet = useCallback(() => {
    if (busy !== 'idle') return;
    setSheet(null);
  }, [busy]);

  const openLanguageSheet = useCallback(() => {
    setSheet('language');
  }, []);

  const handleSelectLanguage = useCallback(
    async (code: SupportedLanguage) => {
      setBusy('language');
      try {
        await setLanguage(code);
        setSheet(null);
        toast.show({
          message: `Language set to ${LANGUAGE_OPTIONS.find((l) => l.code === code)?.nativeName ?? code}.`,
          tone: 'ok',
          icon: 'check',
        });
      } finally {
        setBusy('idle');
      }
    },
    [setLanguage, toast],
  );

  const openNameSheet = useCallback(() => {

    setNameDraft(me?.displayName ?? '');
    setNameFailure(null);
    setSheet('name');
  }, [me?.displayName]);

  const handleSaveName = useCallback(async () => {
    const trimmed = nameDraft.replace(/\s+/g, ' ').trim();
    if (trimmed.length > MAX_NAME) {
      setNameFailure(`That name is too long. Use ${MAX_NAME} characters or fewer.`);
      return;
    }

    if (trimmed === (me?.displayName ?? '')) {
      setSheet(null);
      return;
    }
    setBusy('name');
    setNameFailure(null);
    try {
      const saved = await updateMe({ displayName: trimmed || null });
      setMe(saved);
      setSheet(null);
      toast.show({
        message: trimmed ? 'Your name is saved.' : 'Your name is back to the one your sign-in gave.',
        tone: 'ok',
        icon: 'check',
      });

      if (trimmed) void updateUserProfile(trimmed).catch(() => undefined);
    } catch (cause) {
      setNameFailure(accountFailure(cause, 'Your name could not be saved. Please try again.'));
    } finally {
      setBusy('idle');
    }
  }, [nameDraft, me?.displayName, updateUserProfile, toast]);

  const storedCurrency = me?.currency ? me.currency.toUpperCase() : localCurrency;

  const currencyOptions = useMemo(() => {
    const codes = new Set<string>(CURRENCY_CHOICES);
    if (storedCurrency) codes.add(storedCurrency);
    return [...codes];
  }, [storedCurrency]);

  const openCurrencySheet = useCallback(() => {
    setCurrencyDraft('');
    setCurrencyFailure(null);
    setSheet('currency');
  }, []);

  const saveCurrency = useCallback(
    async (code: string | null) => {

      const typed = (code ?? '').trim();
      const nextCode = typed ? typed.toUpperCase() : null;
      if (nextCode === storedCurrency) {
        setSheet(null);
        setCurrencyDraft('');
        return;
      }
      setBusy('currency');
      setCurrencyFailure(null);
      if (code) {
        void setStoredCurrency(code);
        setLocalCurrency(nextCode);
      }
      if (!accountBacked) {
        setSheet(null);
        setCurrencyDraft('');
        setBusy('idle');
        toast.show({
          message: code ? 'Saved.' : 'That is cleared.',
          tone: 'ok',
          icon: 'check',
        });
        return;
      }
      try {
        const saved = await updateMe({ currency: code });
        setMe(saved);
        setCurrencyNote(saved.note);
        setSheet(null);
        setCurrencyDraft('');
        toast.show({
          message: code ? 'Saved.' : 'That is cleared.',
          tone: 'ok',
          icon: 'check',
        });
      } catch (cause) {
        setCurrencyFailure(accountFailure(cause, 'Your currency could not be saved. Please try again.'));
      } finally {
        setBusy('idle');
      }
    },
    [accountBacked, storedCurrency, toast],
  );

  const localeOptions = useMemo(() => {
    const tags = new Set<string>(LOCALE_CHOICES);
    if (me?.locale) tags.add(me.locale);
    return [...tags]
      .map((tag) => ({ tag, label: localeLabel(tag) }))
      .filter((option): option is { tag: string; label: string } => option.label !== null);
  }, [me?.locale]);

  const saveLocale = useCallback(
    async (tag: string | null) => {

      if (tag === (me?.locale ?? null)) {
        setSheet(null);
        return;
      }
      setBusy('dates');
      setLocaleFailure(null);
      try {
        const saved = await updateMe({ locale: tag });
        setMe(saved);
        setSheet(null);
        toast.show({ message: 'Saved.', tone: 'ok', icon: 'check' });
      } catch (cause) {
        setLocaleFailure(accountFailure(cause, 'How your dates and numbers are written could not be saved. Please try again.'));
      } finally {
        setBusy('idle');
      }
    },
    [me?.locale, toast],
  );

  const openPasswordSheet = useCallback(() => {
    setCurrentPassword('');
    setNewPassword('');
    setPasswordFailure(null);
    setSheet('password');
  }, []);

  const handleUpdatePassword = useCallback(async () => {
    if (newPassword.length < 6) {
      setPasswordFailure('Choose a longer password — at least six characters.');
      return;
    }
    if (!currentPassword) {
      setPasswordFailure('Enter your current password to confirm this change.');
      return;
    }
    setBusy('password');
    setPasswordFailure(null);
    try {
      await updateUserPassword(newPassword, currentPassword);
      setSheet(null);
      setCurrentPassword('');
      setNewPassword('');
      toast.show({ message: 'Your password is changed.', tone: 'ok', icon: 'check' });
    } catch (cause) {
      setPasswordFailure(sessionFailure(cause));
    } finally {
      setBusy('idle');
    }
  }, [newPassword, currentPassword, updateUserPassword, toast]);

  const handleSendReset = useCallback(async () => {
    setBusy('reset');
    setPasswordFailure(null);
    try {
      await sendPasswordReset();
      setSheet(null);
      const target = me?.email ?? user?.email ?? null;
      toast.show({
        message: target ? `We’ve sent a reset link to ${target}.` : 'We’ve sent you a link for setting a new password.',
        tone: 'ok',
        icon: 'email-check-outline',
      });
    } catch (cause) {
      setPasswordFailure(sessionFailure(cause));
    } finally {
      setBusy('idle');
    }
  }, [sendPasswordReset, me?.email, user?.email, toast]);

  const handleSendReport = useCallback(async () => {
    try {
      await sendDiagnosticReport({
        userId: user?.id,
        email: user?.email,
        status,
        storageSummary: me ? `${me.stored.sizeLabel || `${me.stored.bytes} bytes`} preserved` : 'Vault active',
      });
      toast.show({
        message: 'Opening email with diagnostic report ready to send.',
        tone: 'ok',
        icon: 'email-outline',
      });
    } catch {
      toast.show({ message: 'Could not open email application.', tone: 'danger' });
    }
  }, [me, status, toast, user]);

  const handleExport = useCallback(async () => {
    setBusy('export');
    setExportFailure(null);
    try {
      const copy = await exportAccount();

      const name = copy.downloadName;
      const body = JSON.stringify(copy, null, 2);

      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([body], { type: 'application/json;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } else {

        if (!FileSystem.cacheDirectory) {
          setExportFailure('There is nowhere on this phone to write the file.');
          return;
        }
        const destination = `${FileSystem.cacheDirectory}${name}`;
        try {
          await FileSystem.writeAsStringAsync(destination, body);
          if (!(await Sharing.isAvailableAsync())) {
            setExportFailure('This phone has no way to save or send a file from an app.');
            return;
          }
          await Sharing.shareAsync(destination, {
            mimeType: 'application/json',
            UTI: 'public.json',
            dialogTitle: `Your ${PRODUCT} records`,
          });
        } finally {

          await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
        }
      }

      setSheet(null);
      toast.show({ message: 'Your copy is ready to keep or send.', tone: 'ok', icon: 'check' });
    } catch (cause) {
      setExportFailure(accountFailure(cause, 'Your copy could not be made. Please try again.'));
    } finally {
      setBusy('idle');
    }
  }, [toast]);

  const openDeleteSheet = useCallback(() => {
    setDeleteDraft('');
    setDeleteFailure(null);
    setSheet('delete');
  }, []);

  const deleteConfirmed = deleteDraft.replace(/\s+/g, ' ').trim().toLowerCase() === DELETE_CONFIRMATION;

  const handleDelete = useCallback(async () => {
    if (!deleteConfirmed) return;
    setBusy('delete');
    setDeleteFailure(null);
    try {
      const outcome = await deleteAccount(deleteDraft);

      try {
        await signOut();
      } catch {

      }
      setSheet(null);
      setBusy('idle');
      router.replace('/sign-in');
      toast.show({ message: outcome.message, tone: 'ok', icon: 'check' });
    } catch (cause) {
      setDeleteFailure(accountFailure(cause, 'Your account could not be deleted. Please try again.'));
      setBusy('idle');
    }
  }, [deleteConfirmed, deleteDraft, signOut, router, toast]);

  const handleSignOut = useCallback(async () => {
    setBusy('signOut');
    try {
      await signOut();
      setSheet(null);
      setBusy('idle');
      router.replace('/sign-in');
    } catch (cause) {
      setSheet(null);
      setBusy('idle');
      toast.show({ message: sessionFailure(cause), tone: 'danger', icon: 'alert-circle-outline' });
    }
  }, [signOut, router, toast]);

  if (status === 'restoring') return <LoadingYou />;

  if (status === 'signedOut') {
    return (
      <ScreenScroll title="You">
        <EmptyState
          icon="account-outline"
          title="You’re signed out"
          message="Sign in to see your name, what you have stored, and what you can do with it."
          action={{ label: 'Sign in', icon: 'login', onPress: () => router.replace('/sign-in') }}
        />
      </ScreenScroll>
    );
  }

  if (!user) {
    return (
      <ScreenScroll title="You">
        {}
        <ErrorState
          message="We couldn’t load your account details."
          retryLabel="Sign in again"
          onRetry={() => void handleSignOut()}
        />
      </ScreenScroll>
    );
  }

  if (accountBacked && loading && !me && !loadFailure) return <LoadingYou />;

  const canChangePassword = accountBacked && user.providerIds.includes('password');
  const displayName = me?.name ?? user.displayName;
  const email = me?.email ?? user.email ?? null;

  const currencyValue = storedCurrency
    ? currencyLabel(storedCurrency)
    : `${currencyLabel(resolveCurrency(null))} — not chosen yet`;

  const localeValue = me?.locale
    ? localeLabel(me.locale) ?? 'The one you chose'
    : localeLabel(effectiveLocale)
      ? `${localeLabel(effectiveLocale) ?? ''} — from your phone`
      : 'The way your phone writes them';

  const storedData: StoredSummary = me?.stored ?? {
    entries: 0,
    meetings: 0,
    tasks: 0,
    cases: 0,
    files: 0,
    bytes: 0,
    sizeLabel: '0 B',
  };

  return (
    <ScreenScroll
      title="You"
      subtitle="Account settings, storage and preferences."
      {...(accountBacked ? { onRefresh: () => void load('again'), refreshing } : {})}
    >
      <SlideUpIn>
        <View>
          {}
          <GlassSurface
            variant="hero"
            elevation="high"
            radius="lg"
            padding="xl"
          >
            <Row gap="lg" align="center">
              <UserAvatar
                size={theme.spacing.colossal}
                displayName={displayName}
                {...(user.photoURL ? { photoURL: user.photoURL } : {})}
              />
              <Stack gap="xs" style={{ flex: 1 }}>
                <Text variant="heading" numberOfLines={1}>
                  {displayName}
                </Text>
                {email ? (
                  <Text variant="bodySmall" colorToken="textSecondary" numberOfLines={1}>
                    {email}
                  </Text>
                ) : null}
                <Row gap="xs" align="center" style={{ flexWrap: 'wrap' }}>
                  <Chip
                    label={accountBacked ? 'Evidence Vault Active · Encrypted' : 'Guest Session · Local'}
                    tone={accountBacked ? 'ok' : 'neutral'}
                    icon={accountBacked ? 'shield-check-outline' : 'cellphone'}
                    size="sm"
                    emphasis="soft"
                  />
                  {openedAt ? (
                    <Text variant="caption" colorToken="textTertiary">
                      {`Member since ${openedAt}`}
                    </Text>
                  ) : null}
                </Row>
              </Stack>
            </Row>

            <Divider spacing="lg" />

            <Row gap="xs" style={{ width: '100%', alignItems: 'stretch' }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="account-edit-outline"
                  label={t('profile.editName') || 'Edit Name'}
                  onPress={openNameSheet}
                  fullWidth
                  accessibilityHint="Edit your display name"
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="download-outline"
                  label={t('profile.exportVault') || 'Export Vault'}
                  onPress={() => {
                    setExportFailure(null);
                    setSheet('export');
                  }}
                  fullWidth
                  accessibilityHint="Export your complete evidence vault archive"
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="translate"
                  label={LANGUAGE_OPTIONS.find((opt) => opt.code === language)?.nativeName ?? 'Language'}
                  onPress={openLanguageSheet}
                  fullWidth
                  accessibilityHint="Select interface language"
                />
              </View>
            </Row>
          </GlassSurface>

          {}
          <View style={{ marginTop: theme.spacing.md }}>
            <Row gap="sm">
              <StatCard
                label="Entries"
                value={storedData.entries}
                subtitle="Timeline view"
                icon="notebook-outline"
                tone="accent"
                onPress={() => router.push('/(tabs)')}
                accessibilityHint="Open entries in the main timeline"
              />
              <StatCard
                label="Meetings"
                value={storedData.meetings}
                subtitle="Record & notes"
                icon="microphone-outline"
                tone="ok"
                onPress={() => router.push({ pathname: '/capture', params: { mode: 'meeting' } })}
                accessibilityHint="Open meeting recorder"
              />
            </Row>
            <View style={{ height: theme.spacing.sm }} />
            <Row gap="sm">
              <StatCard
                label="Tasks"
                value={storedData.tasks}
                subtitle="Action items"
                icon="checkbox-marked-outline"
                tone="warn"
                onPress={() => router.push('/(tabs)/tasks')}
                accessibilityHint="Open tasks screen"
              />
              <StatCard
                label="Cases"
                value={storedData.cases}
                subtitle="Active disputes"
                icon="folder-outline"
                tone="info"
                onPress={() => router.push('/(tabs)/cases')}
                accessibilityHint="Open cases screen"
              />
            </Row>
          </View>

          {}
          <Surface radius="lg" padding="lg" style={{ marginTop: theme.spacing.md }}>
            <Stack gap="sm">
              <Row between align="center">
                <Row gap="sm" align="center">
                  <IconTile icon="harddisk" tone="accent" size="sm" />
                  <Stack gap="xxs">
                    <Text variant="bodyMedium" style={{ fontWeight: '600' }}>
                      {t('profile.vaultStorage') || 'Vault Storage'}
                    </Text>
                    <Text variant="caption" colorToken="textSecondary">
                      {t('profile.vaultStorageDesc', { count: storedData.files }) || `${storedData.files} ${storedData.files === 1 ? 'file' : 'files'} securely archived`}
                    </Text>
                  </Stack>
                </Row>
                <Text variant="statValue" mono tone="accent">
                  {storedData.sizeLabel}
                </Text>
              </Row>

              <ProgressBar
                value={Math.min(1, Math.max(0, storedData.bytes / (2 * 1024 * 1024 * 1024)))}
                tone="accent"
                size="md"
                accessibilityLabel="Storage capacity usage"
              />

              {(() => {
                const photosCount = storedData.categories?.images.count ?? Math.max(0, storedData.files - storedData.meetings);
                const audioCount = storedData.categories?.audio.count ?? storedData.meetings;
                const docsCount = storedData.categories?.documents.count ?? Math.max(0, storedData.files - photosCount - audioCount);
                return (
                  <Row gap="xs" align="center" style={{ flexWrap: 'wrap', marginTop: theme.spacing.xxs }}>
                    <Chip
                      label={`Photos: ${photosCount}`}
                      icon="image-outline"
                      size="sm"
                      tone="accent"
                      emphasis="soft"
                    />
                    <Chip
                      label={`Audio: ${audioCount}`}
                      icon="microphone-outline"
                      size="sm"
                      tone="ok"
                      emphasis="soft"
                    />
                    <Chip
                      label={`Docs: ${docsCount}`}
                      icon="file-document-outline"
                      size="sm"
                      tone="info"
                      emphasis="soft"
                    />
                  </Row>
                );
              })()}

              <Row between align="center" style={{ marginTop: theme.spacing.xs }}>
                {(() => {
                  const maxBytes = 2 * 1024 * 1024 * 1024;
                  const availBytes = Math.max(0, maxBytes - storedData.bytes);
                  const availLabel = formatBytesLabel(availBytes);
                  const pct = Math.round((storedData.bytes / maxBytes) * 100);
                  return (
                    <Stack gap="xxs" style={{ flex: 1, paddingRight: theme.spacing.sm }}>
                      <Text variant="caption" colorToken="textTertiary">
                        {t('profile.storageCapacity', { used: storedData.sizeLabel, total: '2 GB', percent: pct })}
                      </Text>
                      <Text variant="caption" colorToken="textSecondary">
                        {t('profile.availableStorage', { available: availLabel })}
                      </Text>
                    </Stack>
                  );
                })()}
                <Button
                  size="sm"
                  variant="ghost"
                  label={t('profile.vaultDetails') || 'Vault details'}
                  icon="information-outline"
                  onPress={() => setSheet('stored')}
                  accessibilityHint="View detailed breakdown of stored items"
                />
              </Row>
            </Stack>
          </Surface>

          <Section title="Appearance">
            <Surface radius="lg" padding="md">
              <Stack gap="sm">
                <Row between align="center">
                  <Text variant="bodySmall" colorToken="textSecondary">
                    Theme mode
                  </Text>
                  <Text variant="caption" colorToken="textTertiary">
                    {theme.mode === 'system' ? 'System default' : theme.mode === 'dark' ? 'Dark royal' : 'Clean light'}
                  </Text>
                </Row>
                <SegmentedControl
                  options={[
                    { value: 'system', label: 'System', icon: 'brightness-auto' },
                    { value: 'dark', label: 'Dark', icon: 'weather-night' },
                    { value: 'light', label: 'Light', icon: 'white-balance-sunny' },
                  ]}
                  value={theme.mode}
                  onChange={(mode) => theme.setThemeMode(mode)}
                />
              </Stack>
            </Surface>
          </Section>

          <Section title="Preferences">
            <Stack gap="lg">
              {!accountBacked ? (
                <Notice
                  tone="info"
                  icon="account-question-outline"
                  title="Guest mode"
                  message="Sign in to save your settings, currency preference, and cloud backup across devices."
                />
              ) : null}
              <SettingsGroup>
                <SettingRow
                  icon="account-outline"
                  title="Name"
                  value={displayName}
                  onPress={openNameSheet}
                  accessibilityHint="Change the name this app calls you"
                />
                <SettingRow
                  icon="translate"
                  title="App language"
                  value={LANGUAGE_OPTIONS.find((opt) => opt.code === language)?.nativeName ?? 'English'}
                  onPress={openLanguageSheet}
                  accessibilityHint="Choose the language for the app interface"
                />
                <SettingRow
                  icon="currency-inr"
                  title="Currency"
                  value={currencyValue}
                  onPress={openCurrencySheet}
                  accessibilityHint="Choose the currency you prefer"
                />
                {localeOptions.length > 0 ? (
                  <SettingRow
                    icon="calendar-text-outline"
                    title="Dates and numbers"
                    value={localeValue}
                    onPress={accountBacked ? () => {
                      setLocaleFailure(null);
                      setSheet('dates');
                    } : undefined}
                    accessibilityHint="Choose how dates and amounts are written"
                  />
                ) : null}
                <SettingRow
                  icon="bell-outline"
                  title="Reminders"
                  value="Daily alerts"
                  onPress={() => router.push('/reminders')}
                  accessibilityHint="Configure reminders and alert schedules"
                />
              </SettingsGroup>

              {currencyNote ? (
                <Notice
                  tone="info"
                  icon="information-outline"
                  message={currencyNote}
                  onDismiss={() => setCurrencyNote(null)}
                />
              ) : null}
            </Stack>
          </Section>

          <Section title="Account and security">
            <Stack gap="lg">
              <SettingsGroup>
                {canChangePassword ? (
                  <SettingRow
                    icon="lock-outline"
                    title="Password"
                    value="Change password"
                    onPress={openPasswordSheet}
                    accessibilityHint="Set a new password"
                  />
                ) : null}
                <SettingRow
                  icon="shield-check-outline"
                  title="Evidence handling"
                  value="Safeguards"
                  onPress={() => router.push('/legal')}
                  accessibilityHint="Read what happens to what you add"
                />
                <SettingRow
                  icon="information-outline"
                  title={`About ${PRODUCT}`}
                  value={APP_VERSION ? `v${APP_VERSION}` : 'Active'}
                  onPress={() => router.push({ pathname: '/legal', params: { part: 'purpose' } })}
                  accessibilityHint="Read what this app is for"
                />
                <SettingRow
                  icon="lifebuoy"
                  title="Support and diagnostics"
                  onPress={() => setSheet('help')}
                  accessibilityHint="Read what to do when something goes wrong"
                />
                <SettingRow
                  icon="email-outline"
                  title="Report an issue to Diya Jothikumar"
                  value="1-Tap Email"
                  onPress={() => void handleSendReport()}
                  accessibilityHint="Email device diagnostic logs and issue report directly to technical support"
                />
              </SettingsGroup>
              <SettingsGroup>
                <SettingRow
                  icon="logout"
                  title="Sign out"
                  onPress={() => setSheet('signout')}
                  accessibilityHint="Sign out of this account"
                />
                {me ? (
                  <SettingRow
                    icon="delete-outline"
                    tone="danger"
                    title="Delete account"
                    onPress={openDeleteSheet}
                    accessibilityHint="Delete your account and everything in it"
                  />
                ) : null}
              </SettingsGroup>
            </Stack>
          </Section>
        </View>
      </SlideUpIn>

      {}

      <BottomSheet
        visible={sheet === 'name'}
        onDismiss={closeSheet}
        dismissOnBackdropPress={busy === 'idle'}
        header={<SheetHeader title="Your name" subtitle="What this app calls you." onClose={closeSheet} />}
      >
        <SheetBody>
          <SheetFailure failure={nameFailure} />
          <TextField
            label="Name"
            hint="Leave it empty to go back to the name your sign-in gave."
            value={nameDraft}
            onChangeText={(text) => {
              setNameDraft(text);
              if (nameFailure) setNameFailure(null);
            }}
            autoCapitalize="words"
            autoComplete="name"
            autoFocus
            maxLength={MAX_NAME}
            returnKeyType="done"
            onSubmitEditing={() => void handleSaveName()}
          />
          <Button
            label="Save"
            variant="primary"
            fullWidth
            loading={busy === 'name'}
            disabled={busyElsewhere}
            onPress={() => void handleSaveName()}
            accessibilityHint="Save this name"
          />
        </SheetBody>
      </BottomSheet>

      {}

      <BottomSheet
        visible={sheet === 'currency'}
        onDismiss={closeSheet}
        dismissOnBackdropPress={busy === 'idle'}
        header={
          <SheetHeader title="Currency" subtitle="The one you think in." onClose={closeSheet} />
        }
      >
        <SheetBody>
          <SheetFailure failure={currencyFailure} />
          <Text variant="bodySmall" colorToken="textSecondary">
            Anything you have already saved keeps the currency it was saved in, and nothing is ever
            converted.
          </Text>
          <View accessibilityRole="radiogroup">
            <ChoiceRow
              label="Not chosen"
              selected={storedCurrency === null}
              disabled={busyElsewhere}
              onPress={() => void saveCurrency(null)}
            />
            {currencyOptions.map((code) => (
              <ChoiceRow
                key={code}
                label={currencyLabel(code)}
                selected={storedCurrency === code}
                disabled={busyElsewhere}
                onPress={() => void saveCurrency(code)}
              />
            ))}
          </View>
          <Divider />
          <TextField
            label="Another currency"
            hint="Three letters, like INR for rupees."
            value={currencyDraft}
            onChangeText={(text) => {
              setCurrencyDraft(text);
              if (currencyFailure) setCurrencyFailure(null);
            }}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={24}
            returnKeyType="done"
            onSubmitEditing={() => void saveCurrency(currencyDraft)}
          />
          <Button
            label="Save this one"
            variant="secondary"
            fullWidth
            loading={busy === 'currency'}
            disabled={busyElsewhere || currencyDraft.trim().length === 0}
            onPress={() => void saveCurrency(currencyDraft)}
            accessibilityHint="Save the currency you typed"
          />
        </SheetBody>
      </BottomSheet>

      {}

      <BottomSheet
        visible={sheet === 'dates'}
        onDismiss={closeSheet}
        dismissOnBackdropPress={busy === 'idle'}
        header={
          <SheetHeader
            title="Dates and numbers"
            subtitle="How they are written, not which language the app is in."
            onClose={closeSheet}
          />
        }
      >
        <SheetBody>
          <SheetFailure failure={localeFailure} />
          <Text variant="bodySmall" colorToken="textSecondary">
            The words in the app stay in English. This decides whether a date reads 1 March 2026 or
            March 1, 2026, and how a long number is grouped.
          </Text>
          <View accessibilityRole="radiogroup">
            <ChoiceRow
              label="However your phone is set"
              selected={!me?.locale}
              disabled={busyElsewhere}
              onPress={() => void saveLocale(null)}
            />
            {localeOptions.map((option) => (
              <ChoiceRow
                key={option.tag}
                label={option.label}
                selected={me?.locale === option.tag}
                disabled={busyElsewhere}
                onPress={() => void saveLocale(option.tag)}
              />
            ))}
          </View>
        </SheetBody>
      </BottomSheet>

      {}

      <BottomSheet
        visible={sheet === 'password'}
        onDismiss={closeSheet}
        dismissOnBackdropPress={busy === 'idle'}
        header={
          <SheetHeader
            title="Change your password"
            subtitle="You stay signed in on this phone."
            onClose={closeSheet}
          />
        }
      >
        <SheetBody>
          <SheetFailure failure={passwordFailure} />
          <TextField
            label="Current password"
            value={currentPassword}
            onChangeText={(text) => {
              setCurrentPassword(text);
              if (passwordFailure) setPasswordFailure(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
          />
          <TextField
            label="New password"
            hint="At least six characters."
            value={newPassword}
            onChangeText={(text) => {
              setNewPassword(text);
              if (passwordFailure) setPasswordFailure(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
          />
          <Button
            label="Save new password"
            variant="primary"
            fullWidth
            loading={busy === 'password'}
            disabled={busyElsewhere}
            onPress={() => void handleUpdatePassword()}
            accessibilityHint="Save this new password"
          />
          <Button
            label="Email me a link instead"
            variant="ghost"
            fullWidth
            loading={busy === 'reset'}
            disabled={busyElsewhere}
            onPress={() => void handleSendReset()}
            accessibilityHint="Send a link for setting a new password"
          />
        </SheetBody>
      </BottomSheet>

      {}

      <BottomSheet
        visible={sheet === 'stored'}
        onDismiss={closeSheet}
        header={
          <SheetHeader
            title="What you have stored"
            subtitle="Counted when this page loaded."
            onClose={closeSheet}
          />
        }
      >
        <SheetBody>
          <SettingsGroup>
            <SettingRow icon="notebook-outline" title="Entries" value={String(storedData.entries)} />
            <SettingRow icon="microphone-outline" title="Meetings" value={String(storedData.meetings)} />
            <SettingRow icon="checkbox-marked-outline" title="Things to do" value={String(storedData.tasks)} />
            <SettingRow icon="folder-outline" title="Disputes" value={String(storedData.cases)} />
            <SettingRow
              icon="harddisk"
              title="Total Vault Storage"
              value={`${storedData.files} ${storedData.files === 1 ? 'file' : 'files'} · ${storedData.sizeLabel}`}
            />
          </SettingsGroup>
          {(() => {
            const imgCount = storedData.categories?.images.count ?? Math.max(0, storedData.files - storedData.meetings);
            const audCount = storedData.categories?.audio.count ?? storedData.meetings;
            const docCount = storedData.categories?.documents.count ?? Math.max(0, storedData.files - imgCount - audCount);
            return (
              <>
                <Text variant="label" colorToken="textSecondary" style={{ marginTop: theme.spacing.sm }}>
                  Vault files by category
                </Text>
                <SettingsGroup>
                  <SettingRow
                    icon="image-outline"
                    title="Photos and images"
                    value={`${imgCount} ${imgCount === 1 ? 'file' : 'files'}`}
                  />
                  <SettingRow
                    icon="microphone-outline"
                    title="Meeting recordings"
                    value={`${audCount} ${audCount === 1 ? 'file' : 'files'}`}
                  />
                  <SettingRow
                    icon="file-document-outline"
                    title="Documents and PDFs"
                    value={`${docCount} ${docCount === 1 ? 'file' : 'files'}`}
                  />
                </SettingsGroup>
              </>
            );
          })()}
          <Text variant="bodySmall" colorToken="textSecondary">
            The size is every picture, document and recording you have added, added up exactly.
            Adding the same file twice counts once, because it is kept once.
          </Text>
        </SheetBody>
      </BottomSheet>

      {}

      <BottomSheet
        visible={sheet === 'export'}
        onDismiss={closeSheet}
        dismissOnBackdropPress={busy === 'idle'}
        header={
          <SheetHeader
            title="Save a copy of everything"
            subtitle="One file, yours to keep."
            onClose={closeSheet}
          />
        }
      >
        <SheetBody>
          <SheetFailure failure={exportFailure} />
          <Text variant="body" colorToken="textSecondary">
            It holds your entries, your meetings, the things to do, your disputes, your budgets and
            every detail that was read off what you added — written out so you can open it and read
            it yourself.
          </Text>
          <Text variant="body" colorToken="textSecondary">
            The original pictures, documents and recordings are not inside it. Each one is listed
            with its name and size, and the file itself stays on your account — open an entry to
            save one of those.
          </Text>
          {busy === 'export' ? (
            <Stack gap="sm" style={{ paddingVertical: theme.spacing.sm }}>
              <IndeterminateBar tone="accent" size="sm" accessibilityLabel="Preparing export archive" />
              <Text variant="caption" colorToken="textSecondary" center>
                Preparing your complete archive...
              </Text>
            </Stack>
          ) : null}
          <Button
            label={busy === 'export' ? 'Preparing export...' : 'Save or send the file'}
            icon="download-outline"
            variant="primary"
            fullWidth
            loading={busy === 'export'}
            disabled={busyElsewhere}
            onPress={() => void handleExport()}
            accessibilityHint="Make the file and hand it to your phone to keep or send"
          />
        </SheetBody>
      </BottomSheet>

      {}

      <BottomSheet
        visible={sheet === 'delete'}
        onDismiss={closeSheet}
        dismissOnBackdropPress={busy === 'idle'}
        header={
          <SheetHeader
            title="Delete your account"
            subtitle="This cannot be undone."
            onClose={closeSheet}
          />
        }
      >
        <SheetBody>
          <SheetFailure failure={deleteFailure} />
          {me ? (
            <Notice
              tone="danger"
              icon="alert-circle-outline"
              title="What goes"
              message={deleteLine(me.stored)}
            />
          ) : null}
          <Text variant="body" colorToken="textSecondary">
            There is no copy kept anywhere to put it back from, and nothing returns. If you want
            your records first, close this and choose “Save a copy of everything”.
          </Text>
          <TextField
            label={`Type “${DELETE_CONFIRMATION}” to confirm`}
            hint="Typing it is the confirmation. Nothing is deleted until you do."
            value={deleteDraft}
            onChangeText={(text) => {
              setDeleteDraft(text);
              if (deleteFailure) setDeleteFailure(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={40}
          />
          <Button
            label="Delete everything"
            icon="delete-outline"
            variant="danger"
            fullWidth
            loading={busy === 'delete'}
            disabled={busyElsewhere || !deleteConfirmed}
            onPress={() => void handleDelete()}
            accessibilityHint="Delete this account and everything stored for it"
          />
          <Button
            label="Keep my account"
            variant="secondary"
            fullWidth
            disabled={busyElsewhere}
            onPress={closeSheet}
            accessibilityHint="Close without deleting anything"
          />
        </SheetBody>
      </BottomSheet>

      {}

      <BottomSheet
        visible={sheet === 'help'}
        onDismiss={closeSheet}
        header={<SheetHeader title="If something is not working" onClose={closeSheet} />}
      >
        <SheetBody>
          <Stack gap="xs">
            <Text variant="subheading">If something you added would not read</Text>
            <Text variant="body" colorToken="textSecondary">
              Open the entry and look at the picture you added. A blurred, dark or cut-off photo is
              the usual reason a date or an amount is missing — add a clearer one of the same thing
              and it is read again. Where the app could not make something out it asks you for it
              instead of guessing, and you can type it in yourself.
            </Text>
          </Stack>
          <Stack gap="xs">
            <Text variant="subheading">If a detail looks wrong</Text>
            <Text variant="body" colorToken="textSecondary">
              The original is always kept with the entry, so open the entry and check the two
              against each other. Anything you are going to rely on is worth checking this way — a
              number can be read off a photograph incorrectly.
            </Text>
          </Stack>
          <Stack gap="xs">
            <Text variant="subheading">If a page will not load</Text>
            <Text variant="body" colorToken="textSecondary">
              Pull down on it to try again. Most of these are a connection that dropped for a
              moment, and the second attempt works.
            </Text>
          </Stack>
          <Stack gap="xs">
            <Text variant="subheading">If you need to report it</Text>
            <Text variant="body" colorToken="textSecondary">
              Write down what you were doing, what you expected, and the sentence the app showed
              you. There is nothing hidden behind the message to go looking for — what is on the
              screen is all of it, and it is written to be read out as it stands. The version of
              the app, above, is worth adding if you are sending this to someone.
            </Text>
          </Stack>
        </SheetBody>
      </BottomSheet>

      {}

      <BottomSheet
        visible={sheet === 'signout'}
        onDismiss={closeSheet}
        dismissOnBackdropPress={busy === 'idle'}
        header={<SheetHeader title="Sign out?" onClose={closeSheet} />}
      >
        <SheetBody>
          <Text variant="body" colorToken="textSecondary">
            Nothing is deleted. You’ll need to sign in again to see your records on this phone.
          </Text>
          <Button
            label="Sign out"
            icon="logout"
            variant="danger"
            fullWidth
            loading={busy === 'signOut'}
            disabled={busyElsewhere}
            onPress={() => void handleSignOut()}
            accessibilityHint="Sign out and go back to the sign-in screen"
          />
          <Button
            label="Stay signed in"
            variant="secondary"
            fullWidth
            disabled={busyElsewhere}
            onPress={closeSheet}
            accessibilityHint="Close without signing out"
          />
        </SheetBody>
      </BottomSheet>

      {}

      <BottomSheet
        visible={sheet === 'language'}
        onDismiss={closeSheet}
        dismissOnBackdropPress={busy === 'idle'}
        header={
          <SheetHeader
            title="App language / भाषा"
            subtitle="Choose your preferred language for the interface."
            onClose={closeSheet}
          />
        }
      >
        <SheetBody>
          <View accessibilityRole="radiogroup">
            {LANGUAGE_OPTIONS.map((opt) => (
              <ChoiceRow
                key={opt.code}
                label={`${opt.nativeName} (${opt.name})`}
                selected={language === opt.code}
                disabled={busyElsewhere}
                onPress={() => void handleSelectLanguage(opt.code)}
              />
            ))}
          </View>
        </SheetBody>
      </BottomSheet>
    </ScreenScroll>
  );
}

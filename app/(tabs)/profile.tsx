import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Switch, View } from 'react-native';

import { AIKeySection } from '@features/settings/ai-key-section';
import { confirmDestructive } from '@features/settings/confirm';
import { useTabBarInset } from '@features/navigation/tab-bar';
import { useRepository, useSession } from '@services';
import { eraseEverything } from '@services/erase';
import {
  Button,
  Chip,
  Divider,
  Icon,
  Notice,
  Pressable,
  Row,
  ScreenScroll,
  SegmentedControl,
  Surface,
  Text,
  TextField,
  UserAvatar,
  useTheme,
  type IconName,
  type ThemePreference,
} from '@ui';

const NOTIFICATIONS_STORAGE_KEY = 'detact:settings:notifications_enabled';

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string; icon: IconName }> = [
  { value: 'dark', label: 'Dark Royal', icon: 'weather-night' },
  { value: 'light', label: 'Light', icon: 'white-balance-sunny' },
  { value: 'system', label: 'System', icon: 'cellphone-cog' },
];

export default function ProfileScreen() {
  const theme = useTheme();
  const tabBarInset = useTabBarInset();
  const router = useRouter();
  const {
    user,
    isLocal,
    signOut,
    sendPasswordReset,
    updateUserPassword,
    updateUserProfile,
    error: sessionError,
  } = useSession();
  const { repository, ready } = useRepository();

  // Claimant Identity State
  const [name, setName] = useState(user?.displayName ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [address, setAddress] = useState(user?.address ?? '');
  const [editingIdentity, setEditingIdentity] = useState(false);

  // Settings State
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  // Status State
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const passwordAccount = user?.providerIds?.includes('password') ?? false;

  useEffect(() => {
    setName(user?.displayName ?? '');
    setPhone(user?.phone ?? '');
    setAddress(user?.address ?? '');
  }, [user?.displayName, user?.phone, user?.address]);

  useEffect(() => {
    void AsyncStorage.getItem(NOTIFICATIONS_STORAGE_KEY).then((value) => {
      if (value !== null) {
        setNotificationsEnabled(value === 'true');
      }
    });
  }, []);

  const toggleNotifications = useCallback(async (enabled: boolean) => {
    setNotificationsEnabled(enabled);
    try {
      await AsyncStorage.setItem(NOTIFICATIONS_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
      // Non-critical preference write
    }
  }, []);

  const perform = useCallback(
    async (action: string, work: () => Promise<void>, success?: string) => {
      if (busy) return;
      setBusy(action);
      setError(null);
      setNotice(null);
      try {
        await work();
        if (success) setNotice(success);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Action failed. Please try again.');
      } finally {
        setBusy(null);
      }
    },
    [busy],
  );

  const handleSaveIdentity = useCallback(async () => {
    if (!name.trim()) {
      setError('Please provide a name for the claimant.');
      return;
    }
    await perform(
      'identity',
      async () => {
        await updateUserProfile(name.trim(), undefined, {
          phone: phone.trim(),
          address: address.trim(),
        });
        setEditingIdentity(false);
      },
      'Claimant identity updated.',
    );
  }, [name, phone, address, perform, updateUserProfile]);

  const handleClearCache = useCallback(async () => {
    await perform(
      'clearCache',
      async () => {
        try {
          if (Platform.OS !== 'web') {
            const { Paths } = await import('expo-file-system');
            const cacheDir = Paths.cache;
            if (cacheDir.exists) {
              const items = cacheDir.list();
              for (const item of items) {
                if (item.name.startsWith('ingest-') || item.name.startsWith('temp-') || item.name.endsWith('.tmp')) {
                  try {
                    item.delete();
                  } catch {
                    // Ignore locked file
                  }
                }
              }
            }
          }
        } catch {
          // Non-critical cache cleanup
        }
      },
      'Temporary cache and file previews cleared.',
    );
  }, [perform]);

  const handleSignOut = useCallback(() => {
    confirmDestructive({
      title: 'Sign out?',
      message: 'Your cases remain safely saved. You can sign back in anytime.',
      confirmLabel: 'Sign out',
      onConfirm: () => {
        void perform('signout', async () => {
          await signOut();
          router.replace('/sign-in');
        });
      },
    });
  }, [perform, signOut, router]);

  const handleEraseAll = useCallback(() => {
    if (!user) return;
    confirmDestructive({
      title: 'Delete all case data?',
      message:
        'All cases, documents, and analysis records will be permanently deleted from this device and account. This action cannot be undone.',
      confirmLabel: 'Delete everything',
      onConfirm: () => {
        void perform('erase', async () => {
          await eraseEverything(repository, user.id);
          await signOut();
          router.replace('/sign-in');
        });
      },
    });
  }, [user, repository, perform, signOut, router]);

  const resetPasswordFields = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmation('');
  };

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenScroll
        title="Profile"
        meta={
          <Chip
            label={isLocal ? 'Offline Mode' : ready ? 'Cloud Connected' : 'Connecting'}
            tone={isLocal ? 'neutral' : 'ok'}
            dot
            size="sm"
          />
        }
        contentStyle={{ paddingBottom: tabBarInset }}
      >
        <View style={{ width: '100%', maxWidth: theme.layout.maxContentWidth, alignSelf: 'center', gap: theme.spacing.lg }}>
          {error || sessionError ? (
            <Notice
              tone="danger"
              title="Action failed"
              message={error ?? sessionError?.message ?? ''}
              onDismiss={() => setError(null)}
            />
          ) : null}

          {notice ? (
            <Notice tone="ok" title="Success" message={notice} onDismiss={() => setNotice(null)} />
          ) : null}

          {/* Claimant Identity Card */}
          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
            <Row between align="center">
              <Row align="center" gap="md" style={styles.flex}>
                <UserAvatar photoURL={user?.photoURL ?? null} displayName={user?.displayName ?? null} size={54} />
                <View style={styles.flex}>
                  <Text variant="subheading" numberOfLines={1}>
                    {user?.displayName || 'Claimant Profile'}
                  </Text>
                  <Text variant="caption" colorToken="textSecondary" numberOfLines={1}>
                    {isLocal ? 'Local Device Account' : user?.email}
                  </Text>
                </View>
              </Row>
              {!editingIdentity && (
                <Button
                  label="Edit Identity"
                  icon="pencil-outline"
                  variant="ghost"
                  size="sm"
                  onPress={() => setEditingIdentity(true)}
                />
              )}
            </Row>

            {!editingIdentity ? (
              <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.xs }}>
                <Row align="center" gap="sm">
                  <Icon name="phone-outline" size={16} color={theme.colors.textTertiary} />
                  <Text variant="bodySmall" colorToken={user?.phone ? 'text' : 'textTertiary'}>
                    {user?.phone || 'No phone number provided'}
                  </Text>
                </Row>
                <Row align="center" gap="sm">
                  <Icon name="map-marker-outline" size={16} color={theme.colors.textTertiary} />
                  <Text variant="bodySmall" colorToken={user?.address ? 'text' : 'textTertiary'} numberOfLines={2}>
                    {user?.address || 'No mailing address provided'}
                  </Text>
                </Row>
              </View>
            ) : (
              <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.xs }}>
                <TextField
                  label="Full Legal Name"
                  value={name}
                  onChangeText={setName}
                  maxLength={100}
                  autoComplete="name"
                  editable={!busy}
                />
                <TextField
                  label="Contact Phone"
                  value={phone}
                  onChangeText={setPhone}
                  maxLength={40}
                  autoComplete="tel"
                  keyboardType="phone-pad"
                  editable={!busy}
                />
                <TextField
                  label="Mailing Address"
                  value={address}
                  onChangeText={setAddress}
                  maxLength={250}
                  autoComplete="street-address"
                  editable={!busy}
                />
                <Row gap="sm" style={{ marginTop: theme.spacing.xs }}>
                  <Button
                    label="Save Identity"
                    size="sm"
                    loading={busy === 'identity'}
                    disabled={Boolean(busy) || !name.trim()}
                    onPress={handleSaveIdentity}
                  />
                  <Button
                    label="Cancel"
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(busy)}
                    onPress={() => {
                      setEditingIdentity(false);
                      setName(user?.displayName ?? '');
                      setPhone(user?.phone ?? '');
                      setAddress(user?.address ?? '');
                    }}
                  />
                </Row>
              </View>
            )}
          </Surface>

          {/* Cases on this Device (Offline Migration) */}
          <Surface padding="lg" radius="lg">
            <Pressable
              onPress={() => router.push('/previous-cases')}
              pressScale={0.99}
              style={{ gap: theme.spacing.xs }}
            >
              <Row between align="center">
                <Row align="center" gap="sm">
                  <Icon name="folder-sync-outline" size={22} color={theme.colors.accent} />
                  <View>
                    <Text variant="subheading">Cases on this Device</Text>
                    <Text variant="caption" colorToken="textSecondary">
                      View or transfer offline cases created without sign-in
                    </Text>
                  </View>
                </Row>
                <Icon name="chevron-right" size={20} color={theme.colors.textTertiary} />
              </Row>
            </Pressable>
          </Surface>

          {/* App Settings: Appearance */}
          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">Appearance</Text>
            <SegmentedControl value={theme.preference} onChange={theme.setPreference} options={THEME_OPTIONS} />
          </Surface>

          {/* App Settings: Notifications */}
          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
            <Row between align="center">
              <View style={styles.flex}>
                <Text variant="subheading">Notifications</Text>
                <Text variant="caption" colorToken="textSecondary" style={{ marginTop: 2 }}>
                  Statutory deadlines and dispute updates
                </Text>
              </View>
              <Switch
                value={notificationsEnabled}
                onValueChange={toggleNotifications}
                trackColor={{ false: theme.colors.border, true: theme.colors.accent }}
                thumbColor="#FFFFFF"
              />
            </Row>
          </Surface>

          {/* App Settings: Storage & Data */}
          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">Storage & Data</Text>
            <Row between align="center">
              <View style={styles.flex}>
                <Text variant="bodySmall" colorToken="text">
                  Temporary File Cache
                </Text>
                <Text variant="caption" colorToken="textTertiary">
                  Clear cached document previews and OCR buffers
                </Text>
              </View>
              <Button
                label="Clear Cache"
                variant="secondary"
                size="sm"
                icon="cached"
                loading={busy === 'clearCache'}
                disabled={Boolean(busy)}
                onPress={handleClearCache}
              />
            </Row>
          </Surface>

          {/* AI Settings Section */}
          <AIKeySection />

          {/* Security & Account Settings */}
          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
            <Text variant="subheading">Security & Account</Text>

            {isLocal ? (
              <Row between align="center">
                <Text variant="bodySmall" colorToken="textSecondary">
                  You are using an offline device account.
                </Text>
                <Button
                  label="Sign In / Register"
                  size="sm"
                  variant="secondary"
                  onPress={() => router.push('/sign-in')}
                />
              </Row>
            ) : passwordAccount ? (
              changingPassword ? (
                <View style={{ gap: theme.spacing.sm }}>
                  <TextField
                    label="Current password"
                    value={currentPassword}
                    onChangeText={setCurrentPassword}
                    secureTextEntry
                    editable={!busy}
                  />
                  <TextField
                    label="New password"
                    value={newPassword}
                    onChangeText={setNewPassword}
                    secureTextEntry
                    editable={!busy}
                  />
                  <TextField
                    label="Confirm new password"
                    value={confirmation}
                    onChangeText={setConfirmation}
                    secureTextEntry
                    editable={!busy}
                  />
                  <Row gap="sm">
                    <Button
                      label="Update Password"
                      size="sm"
                      loading={busy === 'password'}
                      disabled={Boolean(busy) || !currentPassword || newPassword.length < 6 || newPassword !== confirmation}
                      onPress={() =>
                        void perform(
                          'password',
                          async () => {
                            await updateUserPassword(newPassword, currentPassword);
                            setChangingPassword(false);
                            resetPasswordFields();
                          },
                          'Password updated successfully.',
                        )
                      }
                    />
                    <Button
                      label="Cancel"
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(busy)}
                      onPress={() => {
                        setChangingPassword(false);
                        resetPasswordFields();
                      }}
                    />
                  </Row>
                </View>
              ) : (
                <Row gap="sm" wrap>
                  <Button
                    label="Change password"
                    variant="secondary"
                    size="sm"
                    icon="lock-outline"
                    onPress={() => setChangingPassword(true)}
                  />
                  <Button
                    label="Send reset link"
                    variant="ghost"
                    size="sm"
                    loading={busy === 'reset'}
                    onPress={() =>
                      void perform('reset', () => sendPasswordReset(user?.email), 'Reset link sent to your email.')
                    }
                  />
                </Row>
              )
            ) : user?.providerIds?.includes('google.com') ? (
              <Row between align="center">
                <Row align="center" gap="sm">
                  <Chip label="Google Account" tone="neutral" icon="google" size="sm" />
                  <Text variant="bodySmall" colorToken="textSecondary">
                    Connected
                  </Text>
                </Row>
                <Button
                  label="Google Security"
                  size="sm"
                  variant="ghost"
                  icon="open-in-new"
                  onPress={() => void Linking.openURL('https://myaccount.google.com/security')}
                />
              </Row>
            ) : null}

            <Divider />

            <Row between align="center">
              <View style={styles.flex}>
                <Text variant="bodySmall" colorToken="text">
                  Reset Data
                </Text>
                <Text variant="caption" colorToken="textTertiary">
                  Permanently delete all cases and documents
                </Text>
              </View>
              <Button
                label="Delete Data"
                variant="danger"
                size="sm"
                icon="trash-can-outline"
                loading={busy === 'erase'}
                disabled={!user || Boolean(busy)}
                onPress={handleEraseAll}
              />
            </Row>
          </Surface>

          {/* Sign Out Button */}
          <View style={{ marginTop: theme.spacing.xs }}>
            <Button
              label="Sign out"
              icon="logout-variant"
              variant="secondary"
              loading={busy === 'signout'}
              disabled={Boolean(busy)}
              onPress={handleSignOut}
            />
          </View>
        </View>
      </ScreenScroll>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
});

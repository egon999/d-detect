/**
 * The tab shell, and the sheet behind the tab bar's compose button.
 *
 * ## Why the sheet is `BottomSheet` and not a `Modal` built here
 *
 * It was a hand-built one, and it was the only overlay in the app that did not behave like
 * the app's overlays: it *faded* in rather than rising from the edge it is attached to, it
 * paid no safe-area inset anywhere in the file — so on a device with a home indicator the
 * bottom button sat under it — and it lifted itself with a pure-black shadow at 30% over 16pt
 * while the theme's own `elevation.high` carries a scheme-tinted value for exactly this. It
 * also overrode `Surface`'s border to `borderStrong` at a literal width, which is the third
 * statement of one edge on a surface that already had a fill and a shadow.
 *
 * `BottomSheet` owns all of that: the scrim and its fade, the spring from the bottom edge, the
 * drag-to-dismiss, Android's hardware back, `accessibilityViewIsModal`, the top-only radius,
 * the hairline, `elevation.high`, and the bottom inset painted in the sheet's own fill. What
 * is left here is the content, which is all this file ever had an opinion about.
 */

import { Tabs, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { TabBar } from '@features/navigation/tab-bar';
import { useSession } from '@services';
import { useCaseList } from '@services/use-case-store';
import {
  BottomSheet,
  Button,
  IconButton,
  Notice,
  Row,
  Stack,
  Text,
  truncate,
  useTheme,
} from '@ui';

export default function TabLayout() {
  const router = useRouter();
  const theme = useTheme();
  const { user } = useSession();
  /**
   * The case list, including the two flags this file used to drop on the floor.
   *
   * Taking only `cases` meant the sheet could not tell "you have no cases" from "the list has
   * not arrived" or from "the list failed to load", and it said the first of those in all
   * three: a user with four saved cases who opened the sheet a beat too early was told to
   * start one, with no route to the evidence upload they had pressed the button for.
   */
  const { cases, loading, error } = useCaseList(user?.id ?? null);
  const [composeVisible, setComposeVisible] = useState(false);

  /**
   * The case an upload would go to: the live one that changed most recently.
   *
   * Sorted rather than taken at index 0. The list arrives in repository order, so the old
   * `cases[0]` was an arbitrary case being described to the user as "the case you worked on
   * last" — and it did not exclude deleted ones, so a case the user had just thrown away
   * could be offered as the destination for their next document.
   */
  const recentCase = useMemo(
    () =>
      cases
        .filter((record) => record.deletedAt === null)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null,
    [cases],
  );

  const handleCompose = useCallback(() => {
    setComposeVisible(true);
  }, []);

  const dismiss = useCallback(() => setComposeVisible(false), []);

  const openNewCase = () => {
    setComposeVisible(false);
    router.push('/new-case');
  };

  // Only reachable from a button that renders when `recentCase` exists, so there is no
  // fallback branch: the old one pushed /new-case from a control labelled "Upload Evidence".
  const openUpload = () => {
    if (!recentCase) return;
    setComposeVisible(false);
    router.push({ pathname: '/case/[caseId]/upload', params: { caseId: recentCase.id } });
  };

  return (
    <View style={styles.fill}>
      <Tabs
        tabBar={(props) => <TabBar {...props} onCompose={handleCompose} />}
        screenOptions={{
          headerShown: false,
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home' }} />
        <Tabs.Screen name="cases" options={{ title: 'Cases' }} />
        <Tabs.Screen name="insights" options={{ title: 'Analysis' }} />
        <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
      </Tabs>

      <BottomSheet
        visible={composeVisible}
        onDismiss={dismiss}
        header={
          <Row
            between
            align="center"
            gap="md"
            style={{
              paddingHorizontal: theme.layout.screenPadding,
              paddingBottom: theme.spacing.sm,
            }}
          >
            {/* Names what the sheet does from where the user is standing. "Add to a case"
                was the fixed title, which is not what the sheet offers to someone who does
                not have one yet. */}
            <Text variant="heading" numberOfLines={1} style={styles.flex}>
              {recentCase ? 'Add to a case' : 'Create a case'}
            </Text>
            <IconButton icon="close" onPress={dismiss} accessibilityLabel="Close" />
          </Row>
        }
      >
        <Stack
          gap="md"
          style={{
            paddingHorizontal: theme.layout.screenPadding,
            paddingBottom: theme.spacing.xl,
          }}
        >
          <Text variant="bodySmall" colorToken="textSecondary">
            {loading
              ? 'Checking which cases you already have…'
              : recentCase
                ? `Your most recently changed case is ${truncate(recentCase.title, 40)}.`
                : 'A case is where one dispute lives: what you are disputing, and the documents that bear on it. Evidence goes in once the case exists.'}
          </Text>

          {error && !recentCase && !loading ? (
            <Notice
              tone="warn"
              icon="cloud-off-outline"
              message="Your existing cases could not be checked just now, so only the option to create one is offered here. Open the Cases tab to try again."
            />
          ) : null}

          {/*
            Ordered by what the user is most likely to have come for, which is not the same
            in both states: with a case in hand the next document is the point, and without
            one there is only one thing to do.

            Both labels are the app's canonical names for these two actions. This sheet used
            to call them "Start a case" and "Add evidence to <truncated title>", while the
            same two destinations were called "Create a case", "Create your first case",
            "Start another case" and "Start a case" on the four screens around it. The case's
            name is stated once, in the line above, rather than inside a button label that
            then changes width with it.
          */}
          {recentCase ? (
            <Button
              label="Add evidence"
              icon="file-upload-outline"
              variant="primary"
              fullWidth
              accessibilityHint={`Adds a document to ${recentCase.title}`}
              onPress={openUpload}
            />
          ) : null}

          <Button
            label="Create a case"
            icon="folder-plus-outline"
            variant={recentCase ? 'secondary' : 'primary'}
            fullWidth
            onPress={openNewCase}
          />
        </Stack>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
});

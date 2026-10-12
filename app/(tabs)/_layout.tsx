import { Tabs, router } from 'expo-router';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

import { useTranslation } from '@i18n';
import {
  BORDER_WIDTH,
  Button,
  CONTROL_SCALE_CAP,
  Divider,
  FONT_FAMILY,
  HIT_TARGET,
  Icon,
  LAYOUT,
  MOTION,
  Pressable,
  Row,
  SPACING,
  Stack,
  Text,
  useReducedMotion,
  useTheme,
  type IconName,
} from '@ui';

const WIDE_LAYOUT_MIN_WIDTH = 1024;

const SIDEBAR_WIDTH = 230;

const TAB_ICON_SIZE = 24;

const SIDEBAR_ICON_SIZE = 22;

const BRAND_MARK_SIZE = 28;

const ADD_ACTION_SIZE = 54;

const ADD_ACTION_ICON_SIZE = 26;

const ADD_SLOT_WIDTH = ADD_ACTION_SIZE + SPACING.md;

const TAB_FOCUS_SCALE = 1.08;

const TAB_FOCUS_LIFT = -2;

type TabName = 'index' | 'money' | 'tasks' | 'cases' | 'you';

interface TabMeta {
  label: string;
  on: IconName;
  off: IconName;
  spoken?: string;
}

const TAB_META: Record<TabName, TabMeta> = {
  index: { label: 'Home', on: 'notebook', off: 'notebook-outline', spoken: 'Home, your activity timeline' },
  money: {
    label: 'Hub',
    on: 'view-dashboard',
    off: 'view-dashboard-outline',
    spoken: 'Hub, meetings, documents, scanner and financial overview',
  },
  tasks: {
    label: 'Tasks',
    on: 'checkbox-marked-circle',
    off: 'checkbox-marked-circle-outline',
    spoken: 'Tasks, things to do',
  },
  cases: { label: 'Cases', on: 'shield-check', off: 'shield-check-outline', spoken: 'Cases and disputes' },
  you: { label: 'Profile', on: 'account', off: 'account-outline', spoken: 'Profile, your account' },
};

const TAB_ORDER: readonly TabName[] = ['index', 'money', 'tasks', 'cases', 'you'];

const PHONE_LEFT_TABS: readonly TabName[] = ['index', 'money'];

const PHONE_RIGHT_TABS: readonly TabName[] = ['cases', 'you'];

function tap() {
  if (Platform.OS !== 'web') void Haptics.selectionAsync();
}

function openAddRecord() {
  router.push('/capture');
}

function TabButton({
  meta,
  focused,
  onPress,
}: {
  meta: TabMeta;
  focused: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const anim = useRef(new Animated.Value(focused ? 1 : 0)).current;
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced !== false) {
      anim.setValue(focused ? 1 : 0);
      return;
    }
    Animated.timing(anim, {
      toValue: focused ? 1 : 0,
      duration: MOTION.duration.normal,
      useNativeDriver: true,
    }).start();
  }, [anim, focused, reduced]);

  const scale = anim.interpolate({ inputRange: [0, 1], outputRange: [1, TAB_FOCUS_SCALE] });
  const lift = anim.interpolate({ inputRange: [0, 1], outputRange: [0, TAB_FOCUS_LIFT] });

  return (
    <Pressable
      style={styles.tab}
      contentStyle={styles.tabContent}
      onPress={onPress}
      pressScale={0}
      dimOnPress
      accessibilityRole="tab"
      accessibilityLabel={meta.spoken ?? meta.label}
      accessibilityState={{ selected: focused }}
    >
      <Animated.View style={[styles.tabInner, { transform: [{ scale }, { translateY: lift }] }]}>
        <Icon
          name={focused ? meta.on : meta.off}
          size={TAB_ICON_SIZE}
          color={focused ? theme.colors.accent : theme.colors.textTertiary}
        />
        <Text
          variant="caption"
          colorToken={focused ? 'text' : 'textTertiary'}
          style={[styles.tabLabel, focused ? { fontFamily: FONT_FAMILY.sansSemiBold } : undefined]}
          numberOfLines={1}
          maxFontSizeMultiplier={CONTROL_SCALE_CAP}
        >
          {meta.label}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

function AddRecordButton() {
  const theme = useTheme();
  const glowAnim = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(glowAnim, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [glowAnim, reduced]);

  const auraScale = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, 1.2],
  });
  const auraOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.75],
  });

  return (
    <View style={styles.addSlot}>
      {}
      <View pointerEvents="none" style={styles.haloContainer}>
        <Animated.View
          style={[
            styles.softFeatherGlow,
            {
              opacity: auraOpacity,
              transform: [{ scale: auraScale }],
            },
          ]}
        />
      </View>
      <Pressable
        style={styles.addPressable}
        contentStyle={styles.addContent}
        onPress={openAddRecord}
        pressScale={0.92}
        haptic
        noFeedback
        accessibilityRole="button"
        accessibilityLabel="Add a record"
        accessibilityHint="Opens a sheet for a photo, a file or a note"
      >
        <View style={styles.addCircle}>
          <LinearGradient
            colors={['#2563EB', '#1D4ED8', '#1E3A8A']}
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          {}
          <LinearGradient
            colors={['rgba(255, 255, 255, 0.32)', 'transparent']}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 0.6 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <Icon name="plus" size={ADD_ACTION_ICON_SIZE} color="#FFFFFF" />
        </View>
      </Pressable>
    </View>
  );
}

function SidebarRow({
  meta,
  focused,
  onPress,
}: {
  meta: TabMeta;
  focused: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      accessibilityRole="tab"
      accessibilityLabel={meta.spoken ?? meta.label}
      accessibilityState={{ selected: focused }}
      style={[
        styles.sidebarRow,
        {
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
          borderRadius: theme.radius.md,
          backgroundColor: focused ? theme.tone('accent').bg : 'transparent',
        },
      ]}
    >
      <Row gap="md">
        <Icon
          name={focused ? meta.on : meta.off}
          size={SIDEBAR_ICON_SIZE}
          color={focused ? theme.colors.accent : theme.colors.textTertiary}
        />
        <Text
          variant="bodyMedium"
          colorToken={focused ? 'text' : 'textSecondary'}
          numberOfLines={1}
          style={styles.sidebarLabel}
          maxFontSizeMultiplier={CONTROL_SCALE_CAP}
        >
          {meta.label}
        </Text>
      </Row>
    </Pressable>
  );
}

function GlassTabBar({ state, navigation }: BottomTabBarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { t } = useTranslation();

  const tabMeta: Record<TabName, TabMeta> = {
    index: { label: t('tabs.home'), on: 'notebook', off: 'notebook-outline', spoken: t('tabs.homeSpoken') },
    money: {
      label: t('tabs.insights'),
      on: 'chart-box',
      off: 'chart-box-outline',
      spoken: t('tabs.insightsSpoken'),
    },
    tasks: {
      label: t('tabs.tasks'),
      on: 'checkbox-marked-circle',
      off: 'checkbox-marked-circle-outline',
      spoken: t('tabs.tasksSpoken'),
    },
    cases: { label: t('tabs.cases'), on: 'shield-check', off: 'shield-check-outline', spoken: t('tabs.casesSpoken') },
    you: { label: t('tabs.you'), on: 'account', off: 'account-outline', spoken: t('tabs.youSpoken') },
  };

  const current = state.routes[state.index]?.name;

  const select = (name: TabName) => {
    if (name === 'cases' && current === 'tasks') {
      navigation.navigate('cases');
      return;
    }
    const route = state.routes.find((item) => item.name === name);
    if (!route) return;
    const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
    if (current !== name && !event.defaultPrevented) navigation.navigate(route.name);
  };

  const places = TAB_ORDER.filter((name) => state.routes.some((route) => route.name === name));

  if (width >= WIDE_LAYOUT_MIN_WIDTH) {
    return (
      <View
        accessibilityRole="tablist"
        style={[
          styles.sidebar,
          {
            width: SIDEBAR_WIDTH,
            paddingTop: insets.top + theme.spacing.xxxl,
            paddingBottom: insets.bottom + theme.spacing.xxl,
            paddingLeft: Math.max(insets.left, theme.layout.screenPadding),
            paddingRight: theme.layout.screenPadding,
            backgroundColor: theme.colors.surfaceSunken,
            borderRightColor: theme.colors.glass.border,
          },
        ]}
      >
        <Stack gap="xl" style={styles.fill}>
          <Row
            gap="sm"
            style={{ paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg }}
          >
            <Icon name="layers-outline" size={BRAND_MARK_SIZE} color={theme.colors.accent} />
            <Text variant="subheading">D-Detect</Text>
          </Row>

          <Button
            label="Add a record"
            icon="plus"
            variant="primary"
            onPress={openAddRecord}
            fullWidth
          />

          <Stack gap="xs">
            {places.map((name) => (
              <View key={name}>
                {name === 'cases' ? <Divider spacing="md" /> : null}
                <SidebarRow
                  meta={tabMeta[name]}
                  focused={current === name}
                  onPress={() => select(name)}
                />
              </View>
            ))}
          </Stack>

          <View style={styles.fill} />

          <Button
            label="Start meeting"
            icon="microphone-outline"
            variant="ghost"
            size="sm"
            onPress={() => router.push({ pathname: '/capture', params: { mode: 'meeting' } })}
            fullWidth
          />
        </Stack>
      </View>
    );
  }

  const renderTab = (name: TabName) => {
    const isCasesOrTasks = name === 'cases' && current === 'tasks';
    const focused = current === name || isCasesOrTasks;
    const meta = isCasesOrTasks
      ? { ...tabMeta.tasks, spoken: t('tabs.tasksSpoken') }
      : tabMeta[name];
    return (
      <TabButton
        key={name}
        meta={meta}
        focused={focused}
        onPress={() => {
          tap();
          select(name);
        }}
      />
    );
  };

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom }]}>
      <BlurView
        tint={theme.colors.glass.blurTint}
        intensity={theme.colors.glass.blurIntensity}
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.glass.chromeFill }]} />
      <View style={[styles.hairline, { backgroundColor: theme.colors.glass.highlight }]} />
      <View style={styles.row} accessibilityRole="tablist">
        <View style={styles.sideGroup}>{PHONE_LEFT_TABS.map(renderTab)}</View>
        <AddRecordButton />
        <View style={styles.sideGroup}>{PHONE_RIGHT_TABS.map(renderTab)}</View>
      </View>
    </View>
  );
}

export default function TabLayout() {
  const { width } = useWindowDimensions();
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <Tabs
      tabBar={(props) => <GlassTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarPosition: width >= WIDE_LAYOUT_MIN_WIDTH ? 'left' : 'bottom',
        sceneStyle: { backgroundColor: theme.colors.canvas },
      }}
    >
      {TAB_ORDER.map((name) => {
        const labels: Record<TabName, string> = {
          index: t('tabs.home'),
          money: t('tabs.insights'),
          tasks: t('tabs.tasks'),
          cases: t('tabs.cases'),
          you: t('tabs.you'),
        };
        return <Tabs.Screen key={name} name={name} options={{ title: labels[name] }} />;
      })}
    </Tabs>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bar: { backgroundColor: 'transparent' },
  hairline: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: BORDER_WIDTH.hairline,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: LAYOUT.tabBarHeight,
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: SPACING.xs,
  },
  sideGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  tab: {
    flex: 1,
    minWidth: 44,
    maxWidth: 64,
    minHeight: HIT_TARGET,
    paddingVertical: SPACING.xxs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabInner: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    marginTop: 3,
    fontSize: 10,
    lineHeight: 13,
  },
  addSlot: {
    width: ADD_SLOT_WIDTH,
    height: ADD_ACTION_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    marginHorizontal: SPACING.xxs,
    marginTop: -8,
    zIndex: 10,
  },
  haloContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  softFeatherGlow: {
    position: 'absolute',
    width: ADD_ACTION_SIZE + 10,
    height: ADD_ACTION_SIZE + 10,
    borderRadius: (ADD_ACTION_SIZE + 10) / 2,
    backgroundColor: 'rgba(56, 189, 248, 0.45)',
    shadowColor: '#38BDF8',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.85,
    shadowRadius: 20,
    elevation: 8,
    ...(Platform.OS === 'web'
      ? ({
          boxShadow: '0 0 24px rgba(56, 189, 248, 0.6), 0 0 44px rgba(37, 99, 235, 0.35)',
        } as any)
      : {}),
  },
  addPressable: {
    width: ADD_ACTION_SIZE,
    height: ADD_ACTION_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  addCircle: {
    width: ADD_ACTION_SIZE,
    height: ADD_ACTION_SIZE,
    borderRadius: ADD_ACTION_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(186, 230, 253, 0.45)',
  },
  sidebar: { borderRightWidth: BORDER_WIDTH.hairline },
  sidebarRow: {
    minHeight: HIT_TARGET,
  },
  sidebarLabel: { flexShrink: 1 },
});

# Foundations audit — `src/ui/`

Read in full: `tokens.ts` (927), `theme.tsx` (172), `semantics.ts` (339), `fonts.ts` (81), `format.ts` (277), `index.ts` (41), `icon.tsx` (50), and all 16 files under `primitives/` (5,800). Total 7,687 lines.

Scope is the design system only. Screens are cited only as corroboration.

**Line numbers are as of 2026-09-15 23:40.** A concurrent session is editing this directory: `Screen.tsx` changed 4 minutes before this section was written, and `Button.tsx`, `Chip.tsx`, `Feedback.tsx`, `Field.tsx`, `Layout.tsx`, `Progress.tsx`, `UserAvatar.tsx` and `tokens.ts` all changed this morning. Every citation below was re-verified against the on-disk state at that timestamp. Two findings were **retracted** during re-verification because the concurrent session had already fixed them — both are noted inline so they are not re-reported.

**Calibration respected.** The gold `colors.accent` / blue `colors.cta` / blue `tones.accent` three-way split is documented at `src/ui/tokens.ts:444`, `:453`, `:482-487` and is treated here as correct. Nothing below asks for it to be unified. What *is* reported is inconsistent **application** of it — two components painting the same class of element from two different sides of the split (§3, §10 in Ranked).

**`ErrorBoundary.tsx` excluded from the bypass indictment.** Its 15 raw hex values, 8 raw `fontSize`, 4 inline `fontWeight` and `fontFamily: 'monospace'` are deliberate and explained at `src/ui/primitives/ErrorBoundary.tsx:15-18` and `:97-104` — "it must render when the theme provider is what threw, so it cannot depend on anything." Counting it would inflate every number in §2 and hide the real offenders. One genuine drift is noted there anyway.

---

## 1. Primitives inventory

Call-site counts are occurrences of `<Name` or `Name(` across `app/` and `src/`, excluding the defining file. "0" was re-verified by a second whole-repo grep that also covered `tests/`.

### `Text.tsx`
| Export | Props | Sites |
|---|---|---|
| `Text` | `variant` (18 `TYPE` keys), `tone`, `colorToken`, `color`, `center`, `mono`, + `TextProps` | 700+ |
| `MonoText` | same, `mono` forced | **0** |

`MonoText` (`src/ui/primitives/Text.tsx:129-135`) is a one-line wrapper over `<Text mono>` with zero call sites. Every caller uses the `variant="mono*"` tokens instead.

### `Layout.tsx`
| Export | Props | Sites |
|---|---|---|
| `Surface` | `variant` (`plain\|raised\|sunken\|accent`), `elevation`, `padding`, `radius`, `bordered`, `gap` | 71 |
| `Pressable` | `pressScale`, `pressOpacity`, `disabled`, + a11y props | 34 |
| `Row` | `gap`, `align`, `between`, `wrap`, `flex` | 143 |
| `Divider` | `spacing`, `inset`, `vertical` | 28 |
| `Stack` | `gap`, `align` | 9 |
| `IconTile` | `icon`, `tone`, `size`, `variant` | 4 |
| `Gradient` | `colors`, `angle`, `style` | 1 |
| `Spacer` | `size`, `flex` | **0** |

`Spacer` is dead — every caller uses `gap` on `Row`/`Stack`, which is the better pattern. `Stack` at 9 sites versus `Row` at 143 is a smell in itself: vertical rhythm is being hand-rolled with `gap` on bare `View`s across the app rather than funnelled through `Stack`.

### `Button.tsx`
| Export | Props | Sites |
|---|---|---|
| `Button` | `label`, `variant` (`primary\|secondary\|ghost\|danger\|tonal`), `size` (`sm\|md\|lg`), `icon`, `trailingIcon`, `loading`, `disabled`, `fullWidth`, `tone` | 48 |
| `IconButton` | `icon`, `accessibilityLabel` (required), `size`, `tone`, `variant` | 8 |
| `SegmentedControl` | `options`, `value`, `onChange` | 3 |

### `Chip.tsx`
| Export | Props | Sites |
|---|---|---|
| `Chip` | `label`, `tone`, `icon`, `size` (`sm\|md`), `emphasis` (`soft\|outline\|solid\|filled`), `dot`, `shrink` | 43 |
| `ProgressChip` | `label`, `value`, `tone` | **0** |
| `CountBadge` | `count`, `tone`, `max` | **0** |
| `ToneDot` | `tone`, `size` | **0** |

Three of four exports in this file are dead.

### `Field.tsx`
| Export | Props | Sites |
|---|---|---|
| `TextField` | `label`, `hint`, `error`, `mono`, `icon`, `trailing`, `multiline`, `minHeight`, `labelHint`, + `TextInputProps` | 8 |
| `SelectField` | `label`, `value`, `options`, `onChange`, `hint` | 1 |

Eight text fields and one select, in an app whose entire job is data entry from documents. Either the forms are hand-rolled elsewhere or the product has almost no input surface; the eight-site count says the primitive is not where the app's typing happens.

### `Feedback.tsx`
| Export | Props | Sites |
|---|---|---|
| `Notice` | `tone`, `icon`, `title`, `message`, `onDismiss` | 37 |
| `EmptyState` | `icon`, `title`, `message`, `action`, `compact` | 14 |
| `SkeletonList` | `count` | 7 |
| `SkeletonCard` | `lines` | 3 |
| `ErrorState` | `title`, `message`, `onRetry`, `retryLabel`, `detail`, `compact` | 2 |
| `Skeleton` | `width`, `height`, `radius` | 0 direct (used internally) |

### `Progress.tsx`
`ProgressBar` (`value`, `tone`, `size`, `accessibilityLabel`), `IndeterminateBar` (`tone`, `size`, `accessibilityLabel`), `StepDots` (`count`, `index`, `tone`). All used.

### `Screen.tsx`
| Export | Props | Sites |
|---|---|---|
| `ScreenScroll` | `title`, `subtitle`, `overline`, `onBack`, `actions`, `footer`, `refreshing`, `onRefresh` | 5 |
| `Section` | `title`, `subtitle`, `action`, `children` | 4 |
| `Disclosure` | `title`, `children`, `defaultOpen` | 3 |
| `ScreenList` | `data`, `renderItem`, `header`, `footer`, … | 2 |
| `ScreenHeaderBar` | `title`, `onBack`, `actions` | 1 |
| `Screen` | `children`, `padded`, `footer` | **0** |
| `ScreenFooter` | `children` | **0** external |
| `SectionHeader` | `title`, `count`, `hint`, `action` | **0** external |

`Screen` — the base screen container the other two are built on — has zero direct call sites. `SectionHeader` has zero external sites and `app/(tabs)/index.tsx:318-321` documents why: "`SectionHeader`'s `action` renders as bare pressable `label` text — an 18pt-tall target — where the `sm` Button is 36pt. Losing half the tap target … is not worth the consistency." The primitive is unused because it is defective (§6). Note the comment's own numbers are now stale — `label` is 13.5/19 so the target is 19pt, and `sm` Button is now 40pt — but the ratio, and the reason for avoiding the primitive, are unchanged.

### `ProvenanceValue.tsx`
| Export | Props | Sites |
|---|---|---|
| `ProvenanceValue` | `label`, `value`, `method`, `confidence`, `source`, `onPress` | **0** |
| `ProvenanceRow` | `label`, `value`, `method`, `source` | **0** |
| `ExtractionSectionHeader` | `title`, `count`, `method` | **0** |

All three dead, in the file whose own docblock calls it "the component the whole design language is built around." Meanwhile `src/features/case/assessment-plate.tsx:19` re-implements its 2pt provenance rule by hand.

### Remaining
| File | Export | Sites |
|---|---|---|
| `Toast.tsx` | `ToastProvider`, `useToast` | provider 1, hook 20+ |
| `Motion.tsx` | `SlideUpIn` 15, `FadeIn` 9, `Shimmer` 9, `Stagger` 7, `AnimatedCounter` 2, `PulseDot` 2, `useReducedMotion` 4 | used |
| `BottomSheet.tsx` | `BottomSheet` | 1 |
| `GlassSurface.tsx` | `GlassSurface` | 1 |
| `ErrorBoundary.tsx` | `ErrorBoundary` | 3 |
| `UserAvatar.tsx` | `UserAvatar` | 2 |
| `AnimatedSplashScreen.tsx` | `AnimatedSplashScreen` | 1 |

### Thin wrappers
- `MonoText` → `<Text mono>` (`Text.tsx:129-135`), 0 sites.
- `SkeletonList` → `Stack` of `SkeletonCard` (`Feedback.tsx:116-124`), 5 lines.
- `ToneDot` → a coloured `View` (`Chip.tsx`), 0 sites.
- `Spacer` → `<View style={{height}}/>` (`Layout.tsx`), 0 sites.
- `ProvenanceValue.tsx:308` — `export { IconButton }`. A re-export of another module's component from an unrelated file, so `IconButton` has two import paths.

### Overlaps
1. **Cards: three implementations.** `Surface variant="raised"` (`Layout.tsx:171-191`), `GlassSurface` (`GlassSurface.tsx`, 1 site), and `SkeletonCard`'s hand-rolled `View` (`Feedback.tsx:94-103`) which duplicates `Surface`'s exact fill/radius/border/padding recipe rather than calling it.
2. **Section headers: three.** `SectionHeader` (`Screen.tsx:633-672`, 0 sites), `Section`'s internal header (`Screen.tsx`, 4 sites), `ExtractionSectionHeader` (`ProvenanceValue.tsx`, 0 sites).
3. **Hairlines: two widths.** `BORDER_WIDTH.hairline = 1` (`tokens.ts:612`) and `StyleSheet.hairlineWidth` (~0.33px at 3x) — see §3.
4. **Dividers: two.** `Divider` (28 sites, 1px) and `ScreenList`'s inline separator (`Screen.tsx:528`, hairlineWidth).
5. **Progress: two families.** `ProgressBar`/`IndeterminateBar` (`Progress.tsx`) and `ProgressChip` (`Chip.tsx`, 0 sites).
6. **Icon buttons: two.** `IconButton` (`Button.tsx`) and `Notice`'s inline dismiss pressable (`Feedback.tsx:379-388`) which rebuilds it at 32×32.

### Missing
| Asked about | Status |
|---|---|
| Empty state | Present — `EmptyState`, 14 sites |
| Skeleton | Present — `Skeleton`/`SkeletonCard`/`SkeletonList` |
| Bottom sheet | Present — `BottomSheet`, 1 site |
| Section header | Present but unusable — `SectionHeader`, 0 external sites, defective action target |
| **Inline field error** | **Missing as a primitive.** `TextField` renders its own error row inline (`Field.tsx:220-226`) with no exported component, so a non-`TextField` control (`SelectField`, a date picker, a checkbox group) has no way to show a validated error in the same shape. `SelectField` has no `error` prop at all (`Field.tsx:248-254`). |

Also genuinely absent, and each one is a place screens are improvising:
- **No `Card` with a header slot.** `Surface` takes `padding`/`gap` but no title/action, so every card header is a hand-built `Row`.
- **No `ListRow` / `MenuRow`.** `LAYOUT.rowHeight = 56` exists (`tokens.ts:643`) and no primitive consumes it. Every tappable list row in the app is assembled from `Pressable` + `Row` + `Icon` + chevron.
- **No `KeyValue` / definition-list primitive.** With `ProvenanceRow` dead, label→value pairs are hand-built everywhere.
- **No `Modal`/`Dialog`.** Only `BottomSheet`.
- **No `Tabs`/`Switch`/`Checkbox`/`Radio`.** `SelectField`'s `SelectRow` is a private radio (`Field.tsx:303-357`) not exported.
- **No `Avatar` group, no `Tooltip`, no `Stepper`.**
- **No focus-ring primitive**, despite `colors.accent` being documented as the colour that paints focus rings (`tokens.ts:444`). Nothing in `primitives/` renders a focus ring except `TextField`'s animated border.

---

## 2. Token bypass inside the primitives

Raw numeric literals in layout/size/duration position, per file, excluding `0`, `1` used as opacity/flex, percentages, and `ErrorBoundary.tsx`:

| File | Raw layout/size literals | Raw hex/rgba | Raw `fontSize` | Inline `fontWeight` |
|---|---|---|---|---|
| `AnimatedSplashScreen.tsx` | **19** | **9** | **3** | **3** |
| `Chip.tsx` | 8 | **3** | 0 | 0 |
| `Button.tsx` | 7 | 0 | 0 | 0 |
| `Feedback.tsx` | 7 | 0 | 0 | 0 |
| `ProvenanceValue.tsx` | 7 | 0 | 0 | 0 |
| `Field.tsx` | 6 | 0 | 0 | 0 |
| `Screen.tsx` | 6 | 0 | 0 | 0 |
| `BottomSheet.tsx` | 3 | 0 | 0 | 0 |
| `Progress.tsx` | 2 | 0 | 0 | 0 |
| `Toast.tsx` | 2 | 0 | 0 | 0 |
| `GlassSurface.tsx` | 1 | 0 | 0 | 0 |
| `UserAvatar.tsx` | 1 | 0 | 0 | 0 |
| `Layout.tsx`, `Motion.tsx`, `Text.tsx` | **0** | 0 | 0 | 0 |

`Layout.tsx` — 584 lines, the most-used file in the system — has zero raw literals. That is the standard the rest of the directory is being measured against, and it proves the standard is reachable.

### The worst file: `AnimatedSplashScreen.tsx`

This is the first thing a user sees, and it is the only file in `primitives/` that does not participate in the design system at all. It imports `Text` from `react-native`, not from `./Text`.

`src/ui/primitives/AnimatedSplashScreen.tsx:225-233`:
```ts
  wordmark: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -1.2,
    color: '#F5F7FF',
  },
  tagline: {
    fontSize: 14,
    fontWeight: '500',
```
and `:260-261`:
```ts
    fontSize: 12.5,
    fontWeight: '600',
```

Three problems compounded. (a) `fontSize: 34` is not a `TYPE` size — `statValue` is 32 (`tokens.ts:726`), `display` is 30. It is a fourth display size that exists only here. (b) `fontWeight: '700'` on a system font, when the whole typographic system is delivered through named font *faces* — `FONT_FAMILY.sansExtraBold` etc. (`tokens.ts:72-81`) — and `UserAvatar.tsx:80-86` contains the codebase's own warning against exactly this. On Android, `fontWeight` with a custom `fontFamily` is unreliable; without one it renders Roboto. So the splash wordmark is **Roboto Bold** and the app it fades into is **Plus Jakarta Sans**. The brand mark is in the wrong typeface. (c) `letterSpacing: -1.2` is copied from `TYPE.statValue`'s tracking (`tokens.ts:726`) but applied to a different size, where it is wrong.

Same file, raw colour, `:46-47` and `:209-210`:
```ts
const SPLASH_BG = '#070D21';
const SPLASH_GOLD = '#BEA860';
```
Both are literal copies of `palette.royal990` and `palette.gold500` (`tokens.ts:87-231`). Unlike `ErrorBoundary`, there is no reason for the copy: the splash renders *inside* the provider tree at `app/_layout.tsx`. Also `Dimensions.get('window')` at module scope (`:13`), so the values are captured at import and never respond to rotation or fold.

### Second worst: `Chip.tsx`

`src/ui/primitives/Chip.tsx:74`:
```ts
  const height = compact ? 26 : 32;
```
Two magic heights, neither in `SPACING`, `RADIUS` nor `LAYOUT`, in the primitive with 43 call sites. The docblock immediately above them (`:70-73`) derives them from the caption line box — good reasoning that stopped one step short of writing the result down as a token, so `ProgressChip` then re-states `26` by hand at `:140`.

`src/ui/primitives/Chip.tsx:82`:
```ts
  const foreground = solid ? '#FFFFFF' : palette.fg;
```
Repeated at `:107` and `:184`. Three raw `#FFFFFF` in a themed component. The dark scheme's `colors.textOnSolid` (or equivalent) exists precisely so a solid chip's foreground is scheme-resolved; hardcoding white means a solid chip in the light scheme cannot ever be dark-on-light.

Also `:103-108` `width: 6, height: 6, borderRadius: 3`; `:111` `size={compact ? 12 : 14}`; `:221` `spinner: { transform: [{ scale: 0.7 }], width: 12, height: 12 }`; `:222-228` `countBadge: { minWidth: 24, height: 22 }`.

### `Button.tsx` — the size table

`src/ui/primitives/Button.tsx:67-71`:
```ts
const DIMENSIONS = {
  sm: { height: 40, paddingHorizontal: SPACING.lg, gap: SPACING.sm, icon: 16 },
  md: { height: 48, paddingHorizontal: SPACING.xl, gap: SPACING.sm, icon: 18 },
  lg: { height: 56, paddingHorizontal: SPACING.xxl, gap: SPACING.md, icon: 20 },
};
```
Half-tokenised: padding and gap come from `SPACING`, heights and icon sizes are literals. `40`, `48` and `56` have no token — and `56` collides with `LAYOUT.rowHeight = 56` (`tokens.ts:643`) without referencing it, so a full-width `lg` button and a list row are the same height by coincidence rather than by declaration. `sm: 40` is still under the 44pt floor (§6). The icon ramp 16/18/20 exists nowhere else; `Icon`'s own default is 18 (`icon.tsx`), and the same file then hardcodes `size={15}` at `:314` for `SegmentedControl` rather than reading `DIMENSIONS`, so the segmented control's glyph matches no entry in its own size table.

**Retracted on re-verification:** an earlier read of this file had `DIMENSIONS` at 36/44/52 with icons 15/17/19, where `md: 44` silently duplicated `HIT_TARGET`. The concurrent session has already re-cut the ramp and that duplication is gone. `md` now clears 44 by 4pt.

Then `:337`, `:342-348`, `:349-355`, `:362-364`:
```ts
  button: { … minHeight: 0 },
  iconButton: { width: HIT_TARGET, height: HIT_TARGET, … minHeight: 0 },
  iconButtonInner: { width: 40, height: 40, borderRadius: 20, … },
  segment: { … height: 40, minHeight: 0 },
```
`minHeight: 0` appears three times, explicitly cancelling `Pressable`'s `HIT_TARGET` guarantee (`Layout.tsx:313`). `iconButton` is the one place that does it correctly — it reads `HIT_TARGET` for the outer target and paints a 40pt visual inside it, which is the right pattern. `segment` does not: `height: 40` with `minHeight: 0` gives `SegmentedControl` a 40pt target with nothing restoring the floor. `borderRadius: 20` is a raw literal where `RADIUS.pill` exists — and `:305` in the same component uses `theme.radius.pill` for the same shape, so the file states one radius two ways.

### `Field.tsx` — missing import

`src/ui/primitives/Field.tsx:37`:
```ts
import { FONT_FAMILY, SPACING } from '../tokens';
```
`BORDER_WIDTH` is not imported, and the consequence is `:365` and `:374`:
```ts
    borderWidth: StyleSheet.hairlineWidth,
```
Also `:176` `minHeight: minHeight ?? (multiline ? 112 : 50)` — `50` is a control height that matches nothing: it sits between the button ramp's `md: 48` and `lg: 56` and below `LAYOUT.rowHeight` 56 (`tokens.ts:643`), so a text field placed beside a `md` button is 2pt taller than it for no stated reason. Also raw icon sizes `17` (`:185`), `13` (`:222`), `18` twice (`:334`, `:352`); and `marginTop: 2` (`:344`) where `SPACING.xxs` exists.

### `Screen.tsx` — a duplicated magic number

`src/ui/primitives/Screen.tsx:402` and `:537`, identical:
```ts
  paddingBottom: insets.bottom + theme.spacing.giant + (footer ? 72 : 0),
```
The footer's height allowance, written as a literal twice in one file. `tokens.ts:619-648` records what happens when a bar height is a literal rather than a token — `tabBarHeight` carries a docblock about content hiding under the bar "because it was 62 against a bar that rendered 66", and the fix was to make the bar read the token "so the two cannot drift apart again". `72` here is that same bug, un-fixed, in the same directory. Also `HANDOVER_START = 18` / `HANDOVER_END = 62` (`:61-62`) and `outputRange: [7, 0]` (`:278`).

### `Progress.tsx`, `BottomSheet.tsx`, `ProvenanceValue.tsx`, `GlassSurface.tsx`, `UserAvatar.tsx`, `Toast.tsx`
- `Progress.tsx:36` — `const TRACK_HEIGHT = { sm: 3, md: 6, lg: 9 }`. Defensible as a local ramp, but 3/6/9 is not the 4pt grid.
- `BottomSheet.tsx:399` — `handle: { width: 36, height: 4, borderRadius: 2 }`.
- `ProvenanceValue.tsx:31` imports `BORDER_WIDTH` and **never uses it**; `:39` then declares `const RULE_WIDTH = 2;`, which is `BORDER_WIDTH.thick` (`tokens.ts:613`) rewritten by hand one line below the unused import. Plus `rule: { minHeight: 20 }` (`:312`), `sourceLine: { minHeight: 24 }` (`:320`), and raw icon sizes 13/12/12/12/14/11 (`:118`, `:161`, `:169`, `:247`, `:253`, `:298`).
- `GlassSurface.tsx:198` — `height: StyleSheet.hairlineWidth` for the top highlight, against a docblock promising "a 1px lit line". The promise and the code disagree.
- `UserAvatar.tsx:99` — `borderWidth: 1` raw; `:56` `transition={200}` raw duration.
- `Toast.tsx:104` — `const TOAST_TRAVEL = 16;` beside `MOTION.enterDistance = 12` (`tokens.ts`). Two enter distances for the same gesture.

### Inline shadow objects
Only one, and it is a real one — `src/ui/primitives/Button.tsx:140-141`:
```ts
        variant === 'primary' ? theme.elevation.medium : null,
        variant === 'primary' ? { shadowColor: theme.colors.cta } : null,
```
The colour is tokenised but it overrides the per-scheme `shadowColor` that `shadowFor()` computed (`tokens.ts:837-927`). `ELEVATION_DARK` is deliberately near-black at higher opacity; swapping in saturated blue at that opacity produces a coloured halo under the primary button on a dark canvas — a glow, which is the single most reliable "cheap" tell. `Field.tsx:15-17` argues against exactly this for inputs: "No outer glow: on a dark canvas a glow reads as a halo … and blurs its edge."

### `SPACING`/`RADIUS` token density, for contrast
`Feedback.tsx` 26, `Button.tsx` 15, `Field.tsx` 13, `Screen.tsx` 14, `ProvenanceValue.tsx` 9, `Chip.tsx` 8, `Toast.tsx` 8, `BottomSheet.tsx` 3, `Progress.tsx` 1, and **0** in `AnimatedSplashScreen.tsx`, `GlassSurface.tsx`, `UserAvatar.tsx`, `ErrorBoundary.tsx`. (`Layout.tsx`, `Motion.tsx`, `Text.tsx` read `theme.spacing`/`theme.radius` off the context instead, which is equivalent.) `GlassSurface` and `UserAvatar` scoring zero on both token density *and* near-zero raw literals means they take all geometry from props — acceptable — but `AnimatedSplashScreen` scoring zero on density with 19 raw literals is the definition of a file outside the system.

---

## 3. Borders and cards

The client's complaint about "unnecessary borders/cards" has one mechanical cause, and it is three lines long.

### The root cause: every `Surface` in the shipped theme is bordered

`src/ui/primitives/Layout.tsx:173-177`:
```ts
  const showBorder =
    bordered ??
    // Dark leads with the hairline; light leads with the shadow, and only falls back to a
    // border when there is no shadow to lead with. `accent` always states its edge.
    (theme.scheme === 'dark' || !raised || variant === 'accent');
```

Three facts make this fire unconditionally:

1. `bordered` is **never passed by any caller.** A repo-wide grep for `bordered` across `app/` and `src/` returns three hits, all of them prose inside docblocks (`app/(tabs)/profile.tsx:41`, `src/features/case/case-ledger.tsx:10`, `src/features/settings/toggle.tsx:8`). No JSX site sets it. So the `??` always falls through to the default expression.
2. `theme.scheme === 'dark'` is the first clause, and dark is the shipped default — `src/ui/theme.tsx:129` sets `initialPreference = 'dark'`.
3. So for all 71 `Surface` call sites, `showBorder === true`, and `elevation` defaults to `'low'` (`Layout.tsx:123`) so `raised === true` as well, so `theme.elevation[elevation]` also applies (`:189`).

**Every card in the app therefore states its edge three times: a fill, a 1px border, and a shadow.** The documented "lifted *or* outlined" rule (`Layout.tsx:95-119`) exists but never executes in the theme users actually see. There is no code path in the shipped configuration that produces a borderless card.

### The border is below the perceptual floor

Dark scheme, `src/ui/tokens.ts:429`:
```ts
  border: 'rgba(150, 178, 232, 0.16)',
```

Composited over `surface` (`#0E1836`, `tokens.ts:421`) that resolves to about `#243152`. Measured:

| Pair | Ratio | WCAG 1.4.11 non-text minimum |
|---|---|---|
| `border` over `surface` vs `surface` | **1.36:1** | 3:1 |
| `border` over `surface` vs `canvas` (`#070D21`) | **1.50:1** | 3:1 |

Less than half the minimum. The docblock at `Layout.tsx:100-104` diagnoses the problem correctly — "`surface` (`#0E1836`) sits only ~1.08:1 from `canvas` (`#070D21`), so on a dim OLED panel the fill alone does not locate the card edge; the border is load-bearing there" — but the remedy does not clear the bar it was chosen to clear. A 1.36:1 hairline does not locate an edge. It is visible enough to read as grime on every rectangle and not visible enough to delimit anything. That combination is the single most recognisable signature of cheap dark UI.

`borderStrong` (`rgba(160, 188, 240, 0.30)`, `tokens.ts:430`) composites to ~`#3A496E` at **1.96:1** — still under 3:1, but 44% better — and has only three consumers in the whole repo: `app/(tabs)/_layout.tsx:67`, `src/features/settings/toggle.tsx:102`, `src/ui/primitives/BottomSheet.tsx:358`. The stronger token exists and cards do not use it.

### Every low-contrast 1px border delimiting a card, in the primitives

| Location | What it outlines | Also has shadow? | Also has fill? |
|---|---|---|---|
| `Layout.tsx:185-186` | every `Surface` — 71 sites | **yes**, `:189` | yes, `:183` |
| `GlassSurface.tsx:121-122` | outer edge of glass panel | **yes**, `:127` | yes, `:120` |
| `GlassSurface.tsx:163`, `:194` | a **second, inner** hairline 1px inside the first | — | — |
| `GlassSurface.tsx:198` | a **third** edge line, top highlight | — | — |
| `Toast.tsx:608` + `:564` | toast card | **yes**, `theme.elevation.high` `:558` | yes, `:563` |
| `BottomSheet.tsx:394-396` | sheet top/left/right | **yes**, `theme.elevation.high` `:329` | yes, `:344` |
| `Feedback.tsx:98-99` | `SkeletonCard` | no | yes, `:96` |
| `Feedback.tsx:161-162` | `EmptyState` icon tile | no | yes |
| `Feedback.tsx:241-242` | `ErrorState` icon tile | no | yes |
| `Feedback.tsx:304-305` | technical-detail box | no | yes |
| `Feedback.tsx:351-353` | `Notice` — 37 sites | no | yes |
| `Field.tsx:365` | `TextField` | no | yes (animated) |
| `Field.tsx:374` | `SelectRow` | no | yes |
| `Button.tsx:151-152` | **every non-ghost button** | primary only, `:140-141` | yes |
| `Button.tsx:245-246` | `SegmentedControl` track | no | yes |
| `Chip.tsx:93-94` | every outline chip — 43 sites | no | yes |
| `Progress.tsx:233-234` | each incomplete `StepDots` segment | no | yes |
| `Screen.tsx:748` | screen footer top edge | no | yes |
| `Screen.tsx:584` | `ScreenFooter` top edge | no | yes |
| `UserAvatar.tsx:99` (raw `1`) | avatar ring | no | yes |
| `AnimatedSplashScreen.tsx:208-209` | splash badge, `rgba(190,168,96,0.45)` | no | yes |

### Where a border *and* a shadow *and* a fill all state the same edge

Six, in order of how many pixels they affect:

1. **`Surface`, all 71 sites** — `Layout.tsx:183` fill + `:185` border + `:189` shadow. Thirteen of those sites also pass an explicit non-default elevation (`app/(tabs)/index.tsx:205`, `:209`, `:368`; `app/(tabs)/cases.tsx:103`; `app/(tabs)/insights.tsx:200`; `app/onboarding.tsx:274`; `app/case/[caseId]/event/[eventId].tsx:246`, `:330`, `:394`, `:461`; `app/case/[caseId]/compare.tsx:251`; `app/case/[caseId]/upload.tsx:351`; `src/features/evidence/media-recorder.tsx:446`), i.e. deliberately asked for depth *and* still got the hairline.
2. **`GlassSurface`** — the extreme case. Fill (`:120`) + outer hairline (`:121`) + sheen gradient (`:142-148`) + tone wash (`:151-156`) + **inner** hairline (`:159-166`, `:194`) + top highlight line (`:173-184`, `:198`) + `theme.elevation[elevation]` (`:127`). **Seven** layers, of which four are edge treatments, on one card. Four separate statements of one boundary.
3. **`Toast`** — `:563` fill + `:564`/`:608` border + `:558` `elevation.high`.
4. **`BottomSheet`** — `:344` fill + `:394-396` three-sided border + `:329` `elevation.high`.
5. **Primary `Button`** — `:151` border where `skinFor` returns `border: theme.colors.cta` (`:167`), i.e. the border is the same blue as the fill, plus `:140-141` `elevation.medium` with `shadowColor` overridden to that same blue. A blue rectangle with a blue outline and a blue glow.
6. **`GlassSurface.tsx:198`** deserves its own line: the top highlight is `height: StyleSheet.hairlineWidth` while the docblock promises "a 1px lit line". At 3x density that renders 0.33px, so the highlight the material design depends on is invisible on most devices — the layer costing a view is not doing the work it was added for.

### Two hairline widths in one system

`BORDER_WIDTH.hairline = 1` (`tokens.ts:612`) versus `StyleSheet.hairlineWidth` (0.33px at 3x, 0.5px at 2x) — a 3× difference, used interchangeably. Twelve `StyleSheet.hairlineWidth` sites repo-wide:

- `src/ui/primitives/Field.tsx:365`, `:374` — because `BORDER_WIDTH` is not imported at `:37`
- `src/ui/primitives/Screen.tsx:528`, `:728`, `:748`
- `src/ui/primitives/GlassSurface.tsx:198`
- `src/ui/primitives/AnimatedSplashScreen.tsx:208`
- `app/(tabs)/insights.tsx:267`, `app/case/[caseId]/audit.tsx:753`, `app/case/[caseId]/compare.tsx:389`, `app/case/[caseId]/event/[eventId].tsx:484`, `app/sign-in.tsx:566`

The visible consequence: `Divider` (28 sites, `Layout.tsx:479`) draws at 1px, while `ScreenList`'s row separator (`Screen.tsx:528`) draws at 0.33px. Two kinds of horizontal rule with different weights, sometimes on the same screen. A `TextField` outlines at 0.33px sitting inside a `Surface` outlined at 1px — the input's edge is a third the weight of the card containing it, which reads as a rendering artefact rather than a decision.

---

## 4. Type usage

### Discipline is good; the *distribution* is the defect

Only two files in the whole repo set `fontSize` outside `TYPE`, and one of them is the excluded `ErrorBoundary.tsx`. The other is `src/ui/primitives/AnimatedSplashScreen.tsx:225` (`34`), `:232` (`14`), `:260` (`12.5`) — covered in §2. Three files carry explicit in-code warnings against inline `fontWeight` (`app/case/[caseId]/graph.tsx:493`, `src/features/navigation/tab-bar.tsx:195-196`, `src/ui/primitives/UserAvatar.tsx:81-83`) and `AnimatedSplashScreen.tsx:226`, `:233`, `:261` do the exact thing they warn against. Everything else routes through `Text` and `TYPE`. That part of the funnel holds.

What does not hold is which end of the scale the app actually uses. Counting every explicit `variant="…"` across `app/` and `src/`:

| Variant | Size | Uses |
|---|---|---|
| `caption` | 12 | **107** |
| `bodySmall` | 14 | **71** |
| `heading` | 22 | 41 |
| `subheading` | 17.5 | 38 |
| `title` | 28 | 22 |
| `monoSmall` | 12 | 20 |
| `label` | 13.5 | 19 |
| `overline` | 11 | 17 |
| `bodyMedium` | 15.5 | 11 |
| `body` | 15.5 | **7** |
| `mono` | 13.5 | 7 |
| `monoOverline` | 11 | 6 |
| `display` | 36 | 2 |
| `monoValue` | 15.5 | 2 |
| `statValue` | 32 | **1** |

371 explicit variants. Three readings of that table, all of them "cheap":

1. **150 of 371 (40%) are set at 11–12pt** — `caption` + `monoSmall` + `overline` + `monoOverline`. `TYPE.caption` (`tokens.ts:717`) is `sansMedium 12/16.5`, defined for metadata, and it is the app's single most-used voice by a factor of 1.5 over the next one. A screen built mostly from 12pt medium grey text reads as a settings pane or an admin console regardless of how good the tokens are.
2. **The reading size is abandoned.** `body` (15.5, "the default body style", `tokens.ts:713`) has 7 explicit uses; `bodySmall` (14) has 71. Ten to one against the size the system designates for prose, in a product whose job is explaining evidence to a non-expert. Every explanation in the app is set one step below the size chosen for explanations.
3. **There is no typographic climax.** `display` + `statValue` + `title` together account for 25 of 371 uses (6.7%), and `statValue` — "the large figure on a summary tile" (`tokens.ts:721-726`) — has exactly **one** call site in the entire product, `app/case/[caseId]/audit.tsx:502`. The scale has a top and nothing goes there. Flat type is the second-most reliable cheapness tell after low-contrast borders, and this is flat by measurement, not by impression.

### Tabular / `fontVariant` numerals: zero, repo-wide

`grep -rn "fontVariant\|tabular" app/ src/` returns **one** hit and it is the word "proportional" in a prose comment (`src/data/local/local-repository.ts:32`). Nothing in the product ever sets `fontVariant: ['tabular-nums']`.

The system's substitute is the monospace faces, and where they are used it works — IBM Plex Mono has fixed advance widths, so these are genuinely aligned:
- `src/features/case/case-ledger.tsx:63` right-aligns a column of figures and defaults `figureVariant = 'monoValue'`.
- `app/case/[caseId]/compare.tsx:350` renders the multi-document comparison column with `variant="mono"` — the one screen whose entire purpose is comparing numbers between documents.

Where it fails is every number set in sans, and one case is live:

`app/case/[caseId]/audit.tsx:502`:
```tsx
          <AnimatedCounter value={chain.length} variant="statValue" tone="accent" />
```
`statValue` is `FONT_FAMILY.sansExtraBold` (`tokens.ts:726`) — proportional. Plus Jakarta Sans ExtraBold digits do not share an advance width, and this value **counts up** through every intermediate integer (`Motion.tsx:487-497` formats a new string per frame). A 32pt proportional figure animating 0→N shifts horizontally on almost every tick, and because it is right of a `Row justify="space-between"` the whole line twitches. This is the app's only stat tile and it jitters.

Latent, not yet live: `AnimatedCounter` declares no `variant` default and spreads `...textProps` into `Text` (`Motion.tsx:441-446`, `:500-508`), whose own default is `variant = 'body'` (`Text.tsx:61`) — proportional sans. Both current call sites happen to pass a variant explicitly. The first one that does not gets a jittering proportional counter with no warning.

Also worth noting: `TYPE.statValue` is `32/36` with `letterSpacing: -1.2`. A 36pt line box on a 32pt extra-bold face with negative tracking is tight even before font scaling; there is no `numberOfLines` or overflow handling at `audit.tsx:502`.

### `allowFontScaling`: never touched anywhere

`grep -rn "allowFontScaling\|maxFontSizeMultiplier" app/ src/` returns **nothing**. React Native defaults `allowFontScaling` to `true` with no cap, so at Android's 200% accessibility setting `display` renders at 72pt and `caption` at 24pt. Neither the `Text` primitive (`Text.tsx:55-90`) nor any consumer sets `maxFontSizeMultiplier`. Combined with the fixed heights inventoried in §6 this is not a theoretical concern — it is the mechanism by which the app clips its own labels at large font sizes.

The system is aware of this in exactly one place, `src/features/case/case-ledger.tsx:98-99`: "`textAlign` rather than a fixed column width: at 200% font scale a hardcoded column…". One file reasoned about it. Nothing else did.

---

## 5. Motion

Stack: React Native `Animated` only. There is no Reanimated — no `babel.config.js` plugin registration, so an import would fail at runtime. `PanResponder` for gestures. `useNativeDriver: true` wherever only opacity/transform move; the two documented exceptions are `Field.tsx:105` (colour cannot be driven natively) and `Motion.tsx:473` (`AnimatedCounter` reads the value back into JS to format a string).

### What animates

| File | What moves | Reduce-motion guarded? |
|---|---|---|
| `Motion.tsx` | `FadeIn`, `SlideUpIn`, `Stagger`, `Shimmer`, `AnimatedCounter`, `PulseDot` | **yes** — `:114`, `:171`, `:324`, `:448`, `:537` |
| `Toast.tsx` | enter/exit, swipe-to-dismiss, queue shuffle | **yes** — `:275`, read at the provider |
| `Progress.tsx` | determinate fill, indeterminate sweep | **yes** — `:56`, `:133` |
| `BottomSheet.tsx` | present/dismiss, drag | **yes** — `:115`, `:156`, `:176` |
| `onboarding.tsx` | card/icon/text entrance | **yes** — `:347` |
| `assessment-plate.tsx` | plate entrance | **yes** — `:86` |
| `settings/toggle.tsx` | thumb travel, track colour | **yes** — `:73` |
| **`Layout.tsx`** | **`Pressable` press scale + dim** | **NO** |
| **`Feedback.tsx`** | **`Skeleton` infinite opacity pulse** | **NO** |
| **`AnimatedSplashScreen.tsx`** | **logo, content, progress, fade-out** | **NO** |
| `Field.tsx` | focus border colour + background | no (defensible) |
| `Screen.tsx` | scroll-linked header handover | no (defensible) |

Seven of twelve honour it. `Field.tsx` and `Screen.tsx` are defensible exclusions — a focus ring responding to focus and a header responding 1:1 to the user's own scroll are not the kind of motion WCAG 2.3.3 is about. The other three are not defensible, and they are ordered by reach.

**1. `Pressable` — `src/ui/primitives/Layout.tsx`.** `useReducedMotion` is never imported into this file. Press-in runs a scale timing and press-out runs a spring (`:281-288`):
```ts
        Animated.spring(scale, {
          toValue: 1,
          damping: theme.motion.spring.snappy.damping,
```
This is the app's universal press interaction — 34 direct `<Pressable>` sites plus every `Button` (48), `Chip` (43), `IconButton` (8) and `SegmentedControl` (3), because all of them are built on it. It is by far the most-executed animation in the product and it is the one animation with no reduce-motion path. A user who has turned motion off still gets every tap in the app squashing and springing back. The reduce-motion contract documented in `Motion.tsx:61-88` is implemented carefully everywhere except the single place it fires most often.

**2. `Skeleton` — `src/ui/primitives/Feedback.tsx:47-66`.** An `Animated.loop` with no guard and no token:
```ts
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
```
Three defects in one block. (a) No `useReducedMotion` — an *infinite* loop is precisely the category reduce-motion exists to stop, and this runs behind every list that is loading. (b) `duration: 900` written twice as a literal when `MOTION.ambient` (`tokens.ts:788-799`) exists for exactly this — "Ambient loop durations, for motion that never stops." (c) `Easing.inOut(Easing.ease)` instead of `Easing.bezier(...MOTION.easeInOut)`, so the skeleton's curve is not the app's curve. Compare `Progress.tsx:142-148`, in the same directory, which gets all three right.

**3. `AnimatedSplashScreen.tsx:71-114`.** Unguarded, and on the legacy spring API — `:80-85`:
```ts
        Animated.spring(logoScale, {
          toValue: 1,
          friction: 6,
          tension: 50,
```
`MOTION.spring` is expressed as `{ damping, stiffness, mass }` (`tokens.ts:766-774`), so a `friction`/`tension` spring cannot consume the tokens even in principle — it is a different physics config family. Hardcoded durations 260 (`:64`), 380 (`:77`), 300 (`:90`, `:95`), 700 (`:100`), plus `setTimeout` literals 1100 (`:110`) and 650 (`:120`). The `useEffect` closes over `safeFinish` with `[]` deps (`:114`). This is the first motion a user ever sees and it shares nothing with the system that follows it.

### `MOTION` tokens: three are dead

Every sub-token, with its consumer count across `app/` and `src/`:

| Token | Value | Consumers |
|---|---|---|
| `duration.fast` | 150 | 10 |
| `stagger` | 45 | 13 |
| `enterDistance` | 12 | 6 |
| `easeOut` | `[0.16,1,0.3,1]` | 5 |
| `easeIn` | `[0.7,0,0.84,0]` | 5 |
| `duration.normal` | 220 | 5 |
| `spring.snappy` | — | 5 |
| `staggerCap` | 300 | 4 |
| `duration.instant` | 90 | 3 |
| `duration.slow` | 320 | 3 |
| `ambient.shimmer` / `shimmerGap` | 1450 / 420 | 3 |
| `duration.deliberate` | 480 | 2 |
| `ambient.pulse` | 1600 | 2 |
| `easeInOut` | `[0.65,0,0.35,1]` | 1 |
| **`spring.gentle`** | `{20,180,0.9}` | **0** |
| **`spring.bouncy`** | `{14,260,0.8}` | **0** |
| **`ambient.drift`** | 4200 | **0** |

`tokens.ts:764-771` describes three springs with three distinct jobs; one exists in the app. `spring.bouncy`'s docblock (`:769`) says "For the compose button and anything that should feel light" — the compose button exists (`src/features/case/composer-sheet.tsx`) and does not use it. `ambient.drift = 4200` (`tokens.ts:798`), "the slowest tier … deliberately near the edge of perception", has never been consumed: there is no ambient drift anywhere in the product, which is the one thing that would make a dark surface feel alive rather than printed.

### Raw curves used where a token exists

Eight sites bypass `MOTION`'s beziers for RN's stock easings. `MOTION.easeOut` is `[0.16, 1, 0.3, 1]` — a strong deceleration; `Easing.out(Easing.cubic)` is a materially different, softer curve, so these animations do not feel like the rest of the app:

- `src/ui/primitives/Motion.tsx:131` — `FadeIn`
- `src/ui/primitives/Motion.tsx:187` — `SlideUpIn`
- `src/ui/primitives/Motion.tsx:338` — `Shimmer`
- `src/ui/primitives/Motion.tsx:472` — `AnimatedCounter`
- `src/ui/primitives/Motion.tsx:554` — `PulseDot`
- `src/ui/primitives/Feedback.tsx:53`, `:59` — `Skeleton`
- `src/features/settings/toggle.tsx:87`

That `Motion.tsx` — the file that owns the entrance vocabulary, imports `MOTION`, and correctly uses `MOTION.enterDistance`, `MOTION.stagger` and `MOTION.staggerCap` — nevertheless eases all five of its animations on `Easing.out(Easing.cubic)` means `FadeIn` (9 sites) and `SlideUpIn` (15 sites) do not use the app's easing curve. The tokens are declared, imported into the right file, and then not applied to the curve itself.

### Two enter distances

`src/ui/primitives/Toast.tsx:104`:
```ts
const TOAST_TRAVEL = 16;
```
beside `MOTION.enterDistance = 12` (`tokens.ts:781`), whose docblock argues specifically for how far an entering element should travel. A toast entering 16pt while every `SlideUpIn` enters 12pt is a 33% difference in the same gesture.
### Naming collision
`app/onboarding.tsx:212` and `:672` declare `const motion = useMemo(...)` holding interpolated `Animated.Value`s (`motion.cardScale`, `motion.iconShift`, `motion.textOpacity`). `motion` is also the name of the theme's token bag (`theme.motion.duration.fast`). Two different things called `motion` in files that use both.

---

## 6. Accessibility floor

Roles, labels and states are better than most codebases: `accessibilityState` appears at seven correct sites (`Button.tsx:134`, `:235`, `:299`; `Feedback.tsx:290`; `Field.tsx:317`; `Layout.tsx:323`; `ProvenanceValue.tsx:183`), `Toast` announces properly on both platforms (`:452`, `:553`), `BottomSheet` sets `accessibilityViewIsModal` (`:338`) and hides its backdrop (`:311`), `Icon` opts itself out (`icon.tsx`), and `Progress` carries `accessibilityValue` (`:86`). The failures are concentrated and mechanical.

### The 44pt floor is advisory, not enforced

`src/ui/primitives/Layout.tsx:311-313`:
```ts
      // 44pt is the platform minimum. Applying it here means no screen has to remember.
      style={[{ minHeight: HIT_TARGET, justifyContent: 'center' }, style]}
```
The caller's `style` is spread **second**, so any caller passing `minHeight` or `height` silently wins. The comment states a guarantee the array order does not provide, and three primitives in the same directory already defeat it — `minHeight: 0` is written four times across `Button.tsx` (`:337`, `:347`, `:364`) and `Feedback.tsx` (`:405`), always for the express purpose of getting under the floor.

This is the single highest-leverage fix in the whole audit: swapping the array order, or clamping with `Math.max`, converts a documented intention into an actual invariant and closes four of the five violations below at once.

### Touch targets under 44pt

| Target | Size | Reach |
|---|---|---|
| `SectionHeader` action — `Screen.tsx:650-659`, a bare `Text` with `onPress` at `variant="label"` (13.5/19) | **~19pt** | 0 sites, *because* of this |
| `Notice` dismiss — `Feedback.tsx:400-406`, `width: 32, height: 32, minHeight: 0` | **32pt** | `Notice` has 37 sites |
| `ErrorState` detail toggle — `Feedback.tsx:398`, `minHeight: 32` | **32pt** | 2 sites |
| `SegmentedControl` segment — `Button.tsx:362-364`, `height: 40, minHeight: 0` | **40pt** | 3 sites |
| Splash skip — `AnimatedSplashScreen.tsx:252-258`, `paddingVertical: 7` around a 12.5pt line | **~30pt** | every cold start |

The splash skip button is the worst of the five because it also has **no `accessibilityRole` and no `accessibilityLabel`** (`:183-185`):
```tsx
      <TouchableOpacity activeOpacity={0.7} onPress={safeFinish} style={styles.skipButton}>
        <Text style={styles.skipButtonText}>Skip ›</Text>
```
A 30pt unlabelled `TouchableOpacity` at a hardcoded `top: 52` (`:253`), which ignores safe-area insets entirely — on a device with a taller status bar or a punch-hole it sits under the system UI. The `›` in the label will also be read aloud by TalkBack as "single right-pointing angle quotation mark".

**Retracted on re-verification:** `IconButton` previously painted a 40pt target. `Button.tsx:342-348` now reads `width: HIT_TARGET, height: HIT_TARGET` for the outer target with a 40pt visual inside it (`:349-355`), which is the correct pattern. Already fixed by the concurrent session.

### Text that cannot scale: `height` where `minHeight` was needed

§4 established that `allowFontScaling` is never capped anywhere in the repo, so Android's 200% setting applies in full. These are the fixed boxes it will clip, worst first:

| Location | Box | Text inside | Reach |
|---|---|---|---|
| `Chip.tsx:74` | `height: compact ? 26 : 32` | `caption` 12/16.5 → 33pt line box at 200% | **43 sites** |
| `Button.tsx:67-71` | `height: 40 / 48 / 56` | `label` 13.5/19 → 38pt line box at 200% | **48 sites** |
| `Chip.tsx:224` | `countBadge height: 22` | `caption` | 0 (dead) |
| `Chip.tsx:140` | `ProgressChip height: 26` | `caption` | 0 (dead) |
| `Feedback.tsx:396` | `stateIcon 56×56` | icon only — fine | 16 |

The two live entries are the two most-used interactive primitives in the product. Both use `height`, not `minHeight`, so at large accessibility font scales every chip and every `sm` button in the app clips its own label — and a chip's label is frequently the only thing distinguishing one tone from another (see below).

The correct form exists in the same directory and is used twice: `Field.tsx:176` (`minHeight: minHeight ?? (multiline ? 112 : 50)`) and `ProvenanceValue.tsx:312`, `:320` (`minHeight: 20`, `minHeight: 24`). Nothing needed inventing.

One file reasoned about this explicitly, `src/features/case/case-ledger.tsx:98-99`: "`textAlign` rather than a fixed column width: at 200% font scale a hardcoded column…". It is the only one.

### `accessibilityRole` / `accessibilityLabel` on views that are not accessibility elements

`accessible={true}` appears **zero** times in `primitives/`; the only `accessible` prop anywhere is `accessible={false}` (`BottomSheet.tsx:311`). Four places set a role or label on a plain `View` whose children are themselves focusable, so the label is not what gets read:

1. **`Field.tsx:315-329`** — the worst, because it is also not a `Pressable`:
```tsx
    <View
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={option.label}
      …
      onStartShouldSetResponder={() => true}
      onResponderRelease={onPress}
```
A raw responder pair instead of `Pressable`, so `SelectRow` has no 44pt floor, no `android_ripple`, no press feedback, no `disabled` handling, and `onResponderRelease` fires even when the finger has dragged off the row — a mis-tap commits a choice. And because the `View` is not `accessible`, TalkBack focuses the inner `Text` nodes individually and never announces the `radio` role or the selected state, so a screen-reader user cannot tell which option is chosen. This is the app's only radio group.
2. **`Feedback.tsx:359`** — `accessibilityRole="summary"` on the `Notice` container (37 sites). The role is not exposed; the title and message are read as two unrelated fragments with no indication they belong to an explanatory notice, which for `tone="danger"` matters.
3. **`UserAvatar.tsx:76`** — an `accessibilityLabel` of the form "NAME's avatar" on a non-accessible `View`, so the initials `Text` is focused instead and TalkBack reads "AB". The image branch (`:56`) puts the same label on the `ExpoImage` and works correctly, so the component announces itself two different ways depending on whether a photo loaded.
4. **`Chip.tsx:120`** — `accessibilityLabel={label}` on the inner `Text` whose child is already `label`. Harmless but a no-op; the docblock's stated intent ("the chip is a single readable unit") is not achieved because the container is not `accessible`.

### No live region on validation errors

`src/ui/primitives/Field.tsx:220-226` renders the error row with an icon and `tone="danger"` text and **no `accessibilityLiveRegion`**. The error is folded into the field's `accessibilityHint` at `:214` (`accessibilityHint={rest.accessibilityHint ?? error ?? hint}`), so it is readable *if the user navigates back to the field*, but nothing is announced when it appears. A sighted user sees red arrive; a screen-reader user gets silence and has to go looking. `Toast.tsx` already implements the correct pattern twice (`:452`, `:553`) — the mechanism exists in the codebase and was not applied to the one component where validation happens.

### Colour as the sole carrier of meaning

Largely well handled, and deliberately so: `src/ui/semantics.ts` (339 lines) maps every domain enum to a tone/icon/label triple, so severity, status, extraction method and provenance all ship a glyph and a word alongside the hue. That is the right architecture and it is used consistently.

Two exceptions:

1. **`ToneDot` — `Chip.tsx:200-215`.** Colour is the *only* carrier: no label, no icon, no `accessibilityLabel`, no `accessibilityRole`. The docblock says it is "used in dense lists where a full chip would dominate the row, and as the leading marker on a timeline entry" — i.e. it is designed to encode status by hue alone. Currently harmless because it has zero call sites; it would be a WCAG 1.4.1 failure the moment it were adopted, which its own docblock invites.
2. **`Chip` with `emphasis="outline"` and no `icon`.** The tone changes `borderColor` and text colour and nothing else, so `warn` and `danger` outline chips differ only by hue — and `tokens.ts` documents that gold sits 2.6° from `warn`. The `label` normally disambiguates, which is why this is second on the list rather than first, but it is also the label that clips at large font scale per the table above. The two defects compound: at 200% font scale a `warn` chip and a `danger` chip can be reduced to two similar-hued pills with truncated text.

---

## 7. Dead code

Verified by grepping `app/`, `src/` **and `tests/`** for `<Name`, `Name(` and bare-identifier use, excluding the defining file and the `src/ui/index.ts` barrel. Eleven exported primitives have zero call sites anywhere in the repository.

| Export | File | Lines it costs |
|---|---|---|
| `ProvenanceValue` | `src/ui/primitives/ProvenanceValue.tsx` | |
| `ProvenanceRow` | `src/ui/primitives/ProvenanceValue.tsx` | 327 total for the file |
| `ExtractionSectionHeader` | `src/ui/primitives/ProvenanceValue.tsx` | |
| `Screen` | `src/ui/primitives/Screen.tsx` | |
| `ScreenFooter` | `src/ui/primitives/Screen.tsx` | |
| `SectionHeader` | `src/ui/primitives/Screen.tsx:633-672` | |
| `ProgressChip` | `src/ui/primitives/Chip.tsx:131-155` | |
| `CountBadge` | `src/ui/primitives/Chip.tsx:165-190` | |
| `ToneDot` | `src/ui/primitives/Chip.tsx:200-215` | |
| `MonoText` | `src/ui/primitives/Text.tsx:129-135` | 7 |
| `Spacer` | `src/ui/primitives/Layout.tsx` | |

Three of these matter more than the rest:

**`ProvenanceValue.tsx` — the whole file is dead.** All three of its exports have zero call sites, in the file whose docblock calls `ProvenanceValue` "the component the whole design language is built around". The design language's stated centrepiece ships in the bundle and renders nowhere. Worse, the pattern it encodes *is* in use — it has been re-implemented by hand: `src/features/case/assessment-plate.tsx:19` documents re-creating the 2pt provenance rule. So the system has one canonical provenance component that nobody calls and at least one hand-rolled copy that everybody sees. This is the clearest single piece of evidence that the design system and the shipped product have diverged.

**`SectionHeader` is dead because it is broken, not because it is unwanted.** `app/(tabs)/index.tsx:318-321` explicitly records the decision to avoid it over the 19pt tap target (§6). The app wants a section header; three exist; the canonical one is rejected on a defect that is one style property to fix.

**`Screen` is dead but is the base of the two that are used.** `ScreenScroll` (5) and `ScreenList` (2) are built on it; nothing calls it directly. Fine as an internal, but it is exported from the barrel as though it were public API.

### Dead tokens

| Token | File | Value |
|---|---|---|
| `MOTION.spring.gentle` | `src/ui/tokens.ts:766` | `{ damping: 20, stiffness: 180, mass: 0.9 }` |
| `MOTION.spring.bouncy` | `src/ui/tokens.ts:770` | `{ damping: 14, stiffness: 260, mass: 0.8 }` |
| `MOTION.ambient.drift` | `src/ui/tokens.ts:798` | `4200` |
| `RADIUS.xxl` | `src/ui/tokens.ts:606` | `32` |

Two of the three declared springs and the slowest ambient tier have never been consumed (§5). `RADIUS.xxl = 32` has zero consumers; the radius scale is effectively four values, with `lg: 18` carrying 37 of the 71 uses.

### Unused import

`src/ui/primitives/ProvenanceValue.tsx:31` imports `BORDER_WIDTH` and never references it. Eight lines later, `:39`:
```ts
const RULE_WIDTH = 2;
```
which is exactly `BORDER_WIDTH.thick` (`tokens.ts:613`), hand-written one line below the unused import of the module that defines it. Both the import and the constant are in the same 10-line span.

### Not dead, but near it

`GlassSurface` (1 site), `Gradient` (1 site, `app/onboarding.tsx:472`), `ScreenHeaderBar` (1 site), `BottomSheet` (1 site), `TextField` (8 sites), `SelectField` (1 site), `LAYOUT.tileSizeLarge` (1 consumer). `GlassSurface` is the notable one: 200 lines implementing a seven-layer material (§3) for a single call site, and it is also the most expensive card in the system to render.

---

## Ranked

The ten things that most make this look cheap, worst first.

1. **Every card in the shipped theme states its edge three times — fill, hairline, and shadow — because `showBorder` short-circuits on `theme.scheme === 'dark'` and no caller ever passes `bordered`.** `src/ui/primitives/Layout.tsx:173-177`
2. **That hairline is `rgba(150, 178, 232, 0.16)`, which composites to 1.36:1 against the card it outlines — under half of WCAG's 3:1 non-text minimum — so it reads as grime on every rectangle rather than as an edge.** `src/ui/tokens.ts:429`
3. **40% of all typed elements in the app are set at 11–12pt and `statValue` has exactly one call site, so the type scale has a top that nothing ever reaches — the product is typographically flat by measurement.** `src/ui/tokens.ts:726`
4. **`GlassSurface` stacks four separate statements of one boundary (outer hairline, inner hairline, top highlight, shadow) plus a sheen and a tone wash — seven layers on one card — and its "1px lit line" renders at 0.33px.** `src/ui/primitives/GlassSurface.tsx:198`
5. **The splash screen — the first thing a user ever sees — renders the brand wordmark in Roboto Bold via `fontWeight: '700'` on a bare RN `Text`, while the app it fades into is Plus Jakarta Sans.** `src/ui/primitives/AnimatedSplashScreen.tsx:225-226`
6. **The primary button carries `elevation.medium` with `shadowColor` overridden to saturated `cta` blue, producing exactly the coloured halo that `Field.tsx:15-17` argues against — a blue rectangle with a blue border and a blue glow.** `src/ui/primitives/Button.tsx:140-141`
7. **`Pressable` — the universal press interaction behind all 48 buttons, 43 chips and 34 direct sites — is the one animation in the codebase with no `useReducedMotion` guard, and `Skeleton` loops forever unguarded at a hardcoded 900ms.** `src/ui/primitives/Feedback.tsx:47-66`
8. **The 44pt touch floor is defeated by its own array order — caller `style` is spread after `minHeight: HIT_TARGET` — so `minHeight: 0` appears four times in the same directory and the `Notice` dismiss button used at 37 sites is 32pt.** `src/ui/primitives/Layout.tsx:313`
9. **`ProvenanceValue.tsx` — 327 lines the docblock calls "the component the whole design language is built around" — has zero call sites, while the pattern it encodes is re-implemented by hand in the feature layer.** `src/ui/primitives/ProvenanceValue.tsx:308`
10. **`Chip` and `Button` size themselves with fixed `height` rather than `minHeight`, so with `allowFontScaling` uncapped everywhere in the repo, every chip and every small button clips its own label at large accessibility font sizes.** `src/ui/primitives/Chip.tsx:74`

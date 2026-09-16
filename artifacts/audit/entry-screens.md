# Entry & creation flow — screen audit

Read-only audit. Scope: the routes a new user meets before they have a single piece of
evidence in the app. Token references are to `src/ui/tokens.ts`.

**Calibration held throughout:** `colors.accent` (gold) = structure, `colors.cta` (blue) =
primary button, `tones.accent` (blue) = chips. That three-way split is deliberate
(`tokens.ts:438-487`) and is not reported as a bug. What *is* reported is a screen picking
the wrong one of the three for the job an element is doing.

---

## `app/_layout.tsx`

The provider assembly and the splash contract. Structurally the soundest file in scope —
`ErrorBoundary` wraps the root, the navigator and the splash separately (`_layout.tsx:128`,
`188`, `210`), and the unconditional module-scope failsafe (`_layout.tsx:88-90`) is genuinely
correct. The defects are in the *timing* it hands to the screens below it.

**Loading and error states**

- `_layout.tsx:68` — `SPLASH_FAILSAFE_MS = 1400`, but the docblock immediately above it
  (`_layout.tsx:60-67`) justifies the number against a three-second budget: "Those finish well
  inside three seconds on a mid-range Android device. Past that…". The constant is less than
  half the budget it is documented against. On a cold radio the Firestore handshake it names
  will *not* be done at 1400ms, so the documented safe path is the path that never happens.
- `_layout.tsx:107` — the boot deadline is `1000`ms while the comment on `_layout.tsx:102-104`
  says "Fonts that have not decoded in two seconds are not going to". Same drift. The
  consequence is real and visible: past 1000ms the app renders in the system font
  (`_layout.tsx:113`, `ready` is true on `deadlinePassed` alone), and when Plus Jakarta Sans
  lands a frame later **every string on the first screen reflows**. `TYPE` pins
  `fontSize`/`lineHeight`/`letterSpacing` per variant (`tokens.ts:705-738`) but the metrics of
  the fallback differ, so the masthead, the onboarding card and the sign-in form all resize.
  This is the app's first frame.
- `_layout.tsx:178-182` — `AppShell` calls `hideSplash()` and arms `setTimeout(finish, 1400)`
  on mount, **unconditionally**. `finish` tears down `AnimatedSplashScreen` whether or not
  `status === 'restoring'` has resolved. The screen underneath is `app/index.tsx`, which for
  `restoring` renders a bare coloured `View` (see below) — so a slow session restore produces
  a featureless navy screen with no spinner, no text and no way to act. That is the "nothing
  feels finished" failure in its purest form.

**Duplicated information**

- `_layout.tsx:72` + `_layout.tsx:209-213` — the user sees the logo **twice** on every launch:
  the native splash (`preventAutoHideAsync`, then a 260ms cross-fade at `_layout.tsx:77`) and
  then `AnimatedSplashScreen` re-animating the same mark. Two brand animations back to back
  for one launch is the single cheapest-feeling moment in the app, and it is guaranteed rather
  than occasional, because `hideSplash()` at `_layout.tsx:179` fires as soon as `AppShell`
  mounts while the overlay is still up.

**Dead ends**

- `_layout.tsx:196-206` — `app/previous-cases.tsx` exists on disk but is not registered here.
  It inherits default stack options, i.e. it is reachable by deep link/`push` with no
  `presentation` and no back guarantee. Given `(tabs)/cases.tsx` already exists, a second
  case-list route is either dead code or a second front door with different chrome.

**Hardcoded styling** — none. `theme.colors.canvas` is threaded correctly to both the
container and `contentStyle` (`_layout.tsx:185`, `192`).

**Leaked internals** — none user-visible. "Firestore"/"Firebase" appear only in comments
(`_layout.tsx:31`, `_layout.tsx:64`).

---

## `app/index.tsx`

A 68-line dispatcher. The routing logic is right; the one thing it renders is wrong.

**Layout defects / loading states**

- `index.tsx:53-55` — the entire loading state of the application is
  `<View style={[styles.container, { backgroundColor: theme.colors.canvas }]} />`. An empty
  flex box. The comment at `index.tsx:24-28` and `_layout.tsx:122-124` both justify this on
  the grounds that "the splash covers the wait" — but `_layout.tsx:180` guarantees the splash
  is gone at 1400ms regardless of `restoring`. So the two files each assume the other is
  showing something, and past 1400ms **neither is**. There is no `Spinner`, no `Skeleton`, no
  `Notice`; `src/ui/primitives/Feedback.tsx` exports all of them.
- This branch is also entered for `!onboardingChecked` — an AsyncStorage read — so a slow
  disk on a cold boot shows the same blank navy.

**Dead ends**

- `index.tsx:36-41` — if `hasSeenOnboarding()` rejects, the failure is swallowed and treated
  as *seen*, sending a genuine first-run user straight to `/sign-in` with no introduction and
  no explanation. Defensible (the comment argues it), but there is no telemetry and no second
  chance: the flag is never re-read, so onboarding is lost for that install.
- There is no `signedOut`-with-error branch. If `useSession()` settles into any status other
  than `restoring`/`signedIn`, the user lands on `/sign-in` (`index.tsx:61`) with no
  indication that anything failed — a session that expired mid-use looks identical to a fresh
  install.

**Copy** — none rendered. **Leaked internals** — none. **Hardcoded styling** — none.

---

## `app/onboarding.tsx`

The carousel machinery is genuinely good — one scroll offset drives every interpolation, and
the reduced-motion path is honoured. Everything *around* the pager is hand-rolled, and this is
the screen with the highest density of raw numbers in the whole scope.

**Layout defects**

- `onboarding.tsx:171` — `const PAGE_PADDING = 20;` reimplements `LAYOUT.screenPadding`, which
  *is* 20 (`tokens.ts:629`, `SPACING.xl`). It is then used at `onboarding.tsx:249`, `504`,
  `505`, `588`, `589` — five places where `theme.layout.screenPadding` was the token. The
  numbers agree today, so the screen looks aligned; the moment the gutter moves, onboarding is
  the one screen that does not follow.
- `onboarding.tsx:749` `maxWidth: 380` on the card vs `sign-in.tsx:576` `maxWidth: 440` on the
  form card vs `sign-in.tsx:586` `maxWidth: 380` on the footnote. Three raw content widths
  across the two screens a user sees consecutively, and `LAYOUT.maxContentWidth` (720) is
  never consulted. On a tablet the onboarding card is 380 wide and the sign-in card 440 — a
  60pt jump on `router.replace` at `onboarding.tsx:401`.
- `onboarding.tsx:719-731` vs `sign-in.tsx:562-573` — the *same wordmark badge* is
  36×36/radius 10/border 1 with a 28×28 image on onboarding, and 50×50/radius 14/hairline
  border with a 38×38 image on sign-in. Consecutive screens, same asset, different chrome,
  and neither size or radius is on the `RADIUS` scale (`RADIUS.sm` is 10, so onboarding
  accidentally lands on it; 14 is `RADIUS.md`, so does sign-in — but both are written as
  literals, so the agreement is luck).
- **Dead vertical space in the footer.** `onboarding.tsx:598` puts `marginBottom: xl` (20)
  under the dots, `onboarding.tsx:621` puts another `marginBottom: xl` (20) under the step
  caption, and `onboarding.tsx:590` adds `insets.bottom + spacing.xxxl` (32) below the button.
  That is 40pt of gap spent separating two elements that say the same thing, plus 32pt under
  the CTA, on top of `paddingTop: 12` (`onboarding.tsx:771`). On a 360×640 device the card is
  squeezed by ~72pt of footer chrome; on a tall device the card floats mid-screen with the
  footer stranded at the bottom.
- `onboarding.tsx:769` — `subtitle: { lineHeight: 22 }` hard-overrides `TYPE.body`'s
  `lineHeight: 23.5` (`tokens.ts:713`). A raw line height *below* the token's is exactly what
  breaks at a large system font size: the text scales, the leading does not, and slide 3's
  40-word subtitle (`onboarding.tsx:120`) collides with itself. Same pattern at
  `sign-in.tsx:588` (`lineHeight: 18` against `TYPE.caption`'s 16.5 — over, but still raw).
- `onboarding.tsx:714` — `height: '46%'` for the gradient wash. A percentage of the window,
  so at a large font size the wash no longer ends above the prose, which is the one thing its
  own comment (`onboarding.tsx:707-708`) says it must do.

**Duplicated information**

- `onboarding.tsx:604-613` (three `PageDot`s) and `onboarding.tsx:623`
  (`Step {activeIndex + 1} of {SLIDES.length}`) encode the identical fact, stacked vertically,
  20pt apart. This is the textbook case. The code even knows it — `onboarding.tsx:600-602`
  hides the dots from screen readers *because* the caption duplicates them. The fix is to
  delete one, not to hide one from assistive tech.
- A third encoding of the same fact: the CTA label flips `'Next'` → `'Get started'` at
  `onboarding.tsx:627` and its icon `'arrow-right'` → `'check'` at `onboarding.tsx:628`. Four
  signals for "which of three slides am I on".

**Hardcoded styling**

- `onboarding.tsx:717` `paddingBottom: 4` → `SPACING.xs`.
- `onboarding.tsx:733-734` `paddingHorizontal: 12` → `SPACING.md`; `borderRadius: 8` is **not
  on the `RADIUS` scale at all** (`xs` 6, `sm` 10).
- `onboarding.tsx:745` `paddingVertical: 12` → `SPACING.md`.
- `onboarding.tsx:754-755` `paddingVertical: 32` / `paddingHorizontal: 24` → `SPACING.xxxl` /
  `SPACING.xxl`. `GlassSurface` takes a padding prop; these bypass it via `contentStyle`.
- `onboarding.tsx:757-763` `width/height: 84`, `borderRadius: 42`, `borderWidth: 1.5`. 1.5 is
  not in `BORDER_WIDTH` (`hairline` 1, `thick` 2) — and `tokens.ts:428-431` is explicit that
  in dark mode a border is tuned as a light source, so a 1.5px full-opacity `colors.accent`
  ring is the "bright border reads as cheap" case named at `tokens.ts:279`.
- `onboarding.tsx:766` `marginTop: 20` → `SPACING.xl`.
- `onboarding.tsx:304` `size={42}` on the `Icon` — a raw glyph size, and 42 is not a step in
  any scale in `tokens.ts`.
- `onboarding.tsx:155-168` — `ICON_LAG`, `TEXT_LAG`, `CARD_RECEDE`, `CARD_DIM`,
  `ICON_ENTER_SCALE`, `DOT_SIZE`, `DOT_WIDTH_ACTIVE`, `DOT_OPACITY_IDLE` are all file-local
  motion constants. `MOTION` (`tokens.ts:751-809`) is the home for these; the file-local block
  means the app's one carousel animates to numbers no other screen can reach.

**Copy quality**

- `onboarding.tsx:113` — "Review extracted text and **processing limits** before comparing the
  evidence." "Processing limits" is the system's vocabulary for its own constraints. The
  reader is a person with a bank statement; they have no model of what a processing limit is,
  and this is slide 2 of 3.
- `onboarding.tsx:120` — 40 words, three sentences, one semicolon and one em-dash clause:
  "…Consistency checks run on every case; AI readings are optional and always need your review
  — they are not a verdict." Written from the system's side ("checks run", "readings are
  optional"). The hedging is correct and important; the placement — final slide of a
  first-run intro, at `TYPE.body` inside a 380pt card — is not.
- `onboarding.tsx:105` "Start with a claim" / `onboarding.tsx:111` "Bring the **sources**
  together" — the app's own noun for this is *evidence* (`(tabs)/_layout.tsx:110` "Add evidence
  to…", `upload.tsx` throughout). "Sources" appears here and in `sign-in.tsx:353`, "evidence"
  everywhere else. Two names for the one thing the product is about, on the first two screens.
- `onboarding.tsx:541` — `Skip ›` renders a raw `›` character as a chevron next to
  `TYPE.caption` (12pt) text. The app has `Icon` and uses `chevron-right` for exactly this
  (`Screen.tsx:688`). A typographic glyph will not match the icon font's weight or optical
  centre, and it is the escape hatch on the first screen.

**Loading, error states, dead ends**

- No loading or error state is needed and none is present — correct.
- `onboarding.tsx:400` — `markOnboardingSeen()` failure is swallowed. Documented and
  defensible.
- The `Skip` target is safe: `Pressable` enforces `minHeight: HIT_TARGET` itself
  (`Layout.tsx:313`), so the comment at `onboarding.tsx:532` is accurate.

---

## `app/sign-in.tsx`

Technically the most careful screen in the flow: per-button `busy` keyed by name
(`sign-in.tsx:136`) so one spinner belongs to one button, field errors that wait for a blur
(`:178-182`), and **`readableAuthError` on all four failure paths** (`:224`, `:257`, `:277`,
`:292`) — the only screen in the audit that maps every error it can receive. That matters for
the rest of this report: the raw-`caught.message` leaks on `new-case.tsx` and `upload.tsx` are
omissions, not the absence of a tool.

Its defects are copy and one dead end.

**Dead ends**

- `sign-in.tsx:489` — `disabled={!canSubmit}`, and `canSubmit` (`:301-302`) requires
  `!emailProblem && !passwordProblem`. Both fields start empty, so both problems are non-null,
  so **the first screen of the app opens with its primary button greyed out** — while
  `showProblem` (`:180`) correctly suppresses every message as untouched. The result is a
  disabled call to action with no sentence anywhere explaining what would enable it. The file's
  own reasoning at `:248-249` — "a disabled control with no stated reason is a dead end,
  whereas this puts the reason under the field it is about" — is applied to the reset button and
  not to the submit.
- `sign-in.tsx:275` — a dismissed Google account chooser produces no message of any kind. This
  is argued for at `:273-274` and the argument is sound for a deliberate dismissal; an
  accidental one looks like the button did nothing.
- `sign-in.tsx:103` — the "Continue with Google" button exists only when
  `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` is set. The reasoning at `:58-60` is right, but it means
  the sign-in screen has two different shapes across builds with nothing to reconcile them, so
  any support instruction that names that button may describe a control the user does not have.

**Leaked internals**

- `sign-in.tsx:353` — "Multi-source evidence consistency and cross-verification", set directly
  under the wordmark as the subtitle of the first screen anyone sees. This is the internal
  positioning line. `(tabs)/index.tsx:166-168` explicitly deleted the equivalent string from
  Home — "Dispute Verification & Forensics sat here and said nothing a person on their own home
  screen needs told" — and the same call was not carried back one screen.
- `sign-in.tsx:547` — the 40-word footnote: "Evidence is cross-referenced with **deterministic
  consistency checks**. **AI suggestions** are optional: they run only with **a provider key you
  connect in Settings**, and each one cites the source it came from." "Provider key" is
  developer vocabulary and "deterministic consistency checks" is the engineering name for the
  feature. It is the same leak as the `Groq` line in `upload.tsx:340`, one abstraction level up,
  and it is placed before the user even has an account.
- `sign-in.tsx:404` — placeholder "e.g. Alex Morgan": generated-name filler, and a *different*
  fake person from `new-case.tsx:312`'s "Rahul Sharma, or ABC Bank".

**Duplicated information**

- `sign-in.tsx:369-370` and `:484` — the segmented control's two options are "Sign in" and
  "Create account", and the primary button's label is **the same two strings**, chosen by the
  same `mode`. The selected segment already states which mode is active; the button restates it
  115 lines later. Same failure as `onboarding.tsx:623` — one piece of state encoded twice in
  one viewport.
- `sign-in.tsx:353` and `:547` — the product's positioning claim is made at the top of the
  screen and again at the bottom, in two different phrasings, and neither is an instruction.

**Copy quality**

- `sign-in.tsx:523` "Continue without an account" — the most consequential choice on the screen,
  and its only explanation lives in `accessibilityHint` (`:529`, "Keeps your cases on this
  device only, with no email or password"), which never renders visually. A sighted user is
  offered a ghost button with no stated consequence, next to a paragraph about provider keys.
- `sign-in.tsx:472` "Forgot your password?" — the only interrogative button label in the app;
  every other label is a verb phrase.

**Colour token misuse**

- `sign-in.tsx:388` — the reset-sent `Notice` is `tone="ok"` while its message is explicitly
  hedged: "**If** {email} has a password account, a reset link is on its way." `tokens.ts:44-47`
  is unambiguous that `ok` "is the only tone that reads as settled" and that "nothing uncertain
  is ever given the `ok` green". The green here asserts an outcome the sentence beside it
  refuses to assert — the same misuse as the `ok` chip on an `OPEN` case
  (`(tabs)/index.tsx:216`). `tones.info` is the tone for a statement in progress.

**Hardcoded styling**

- `sign-in.tsx:563-565` `width: 50, height: 50, borderRadius: 14` — `LAYOUT.tileSizeLarge` is
  **48** and `RADIUS.md` is **14**, so the badge is 2pt off a token it is otherwise quoting.
  `:572-573` `width: 38, height: 38` raw.
- `sign-in.tsx:576` `maxWidth: 440` and `:586` `maxWidth: 380` — two different content widths in
  one stylesheet, so at tablet width the footnote is inset 30pt inside the card above it for no
  reason a reader can infer. Neither is `LAYOUT.maxContentWidth`.
- `sign-in.tsx:582` `marginTop: 4` → `SPACING.xs`; `:585` `marginTop: 24` → `SPACING.xxl`;
  `:588` `lineHeight: 18` overrides the line height `TYPE.caption` already carries; `:461`
  `size={19}` — a raw icon size that is not on any scale.

**Layout defects**

- `sign-in.tsx:375-395` — both notices render **above** the fields inside the card, so a failed
  sign-in pushes the email field, the password field and the submit button down by the banner's
  height. The button moves out from under the finger that just pressed it. (`new-case.tsx:181`
  has the inverse problem: the banner is so far from the button that it is never seen at all.)
- `sign-in.tsx:314-321` — the third screen in the entry flow to hand-roll its own scroll
  geometry rather than use `ScreenScroll` (`index.tsx`, `onboarding.tsx`, then this). Here it is
  justified by the keyboard handling, but it is also why `paddingTop: insets.top + spacing.xxl`
  differs from every other screen's opening offset.
- `sign-in.tsx:319-320` `flexGrow: 1, justifyContent: 'center'` — correctly centred, which
  makes the top-pinned empty states on `(tabs)/index.tsx:356` and `(tabs)/cases.tsx:171` look
  like oversights rather than choices.

---

## `app/(tabs)/_layout.tsx`

143 lines, and it hand-builds a bottom sheet that the design system already ships.

**Layout defects**

- `(tabs)/_layout.tsx:51-56` — a raw `Modal` with `animationType="fade"` and two
  `TouchableWithoutFeedback` layers, when `src/ui/primitives/BottomSheet.tsx` is exported from
  `@ui` precisely for this (`src/ui/index.ts:38-40`, whose comment says "a primitive that is
  awkward to import is a primitive that gets reimplemented inline" — this is that). A bottom
  sheet that **fades** rather than slides is the single clearest "assembled, not built" tell in
  the flow.
- `(tabs)/_layout.tsx:129-134` — `padding: 16`, `paddingBottom: 40` on the backdrop, with **no
  `useSafeAreaInsets` anywhere in the file**. The sheet's distance from the bottom of the
  screen is a fixed 40pt, so on a gesture-navigation device it sits under the home indicator
  and on a device with a hardware nav bar it floats. Every other surface in the app threads
  `insets.bottom` (`Screen.tsx:569`, `sign-in.tsx:318`, `onboarding.tsx:590`).
- `(tabs)/_layout.tsx:136-140` — `shadowOffset: { width: 0, height: -4 }`,
  `shadowOpacity: 0.3`, `shadowRadius: 16`, `elevation: 8`, and **no `shadowColor`**. That
  means iOS draws pure black. `tokens.ts:816-822` is explicit: "A neutral-black shadow … reads
  as dirt", which is why `ELEVATION`/`ELEVATION_DARK` tint to `#16224A`/`#01040C` and why
  `shadowFor()` exists (`tokens.ts:922`). `Surface` already accepts an `elevation` token; this
  overrides it with untinted, unthemed values.
- `(tabs)/_layout.tsx:69` — `borderWidth: 1` → `BORDER_WIDTH.hairline`. Combined with
  `borderColor: theme.colors.borderStrong` (`(tabs)/_layout.tsx:67`) this paints the sheet with
  the app's *strongest* hairline at full width, against a `borderStrong` token documented as a
  0.30-alpha light source (`tokens.ts:430`).
- `(tabs)/_layout.tsx:110` — `label={`Add evidence to ${truncate(activeCase.title, 24)}`}` is up
  to 40 characters in a button. Inside a sheet that is `360 - 32` wide with `padding="xl"` (20
  each side), that is ~268pt of usable width for 40 characters of `TYPE.label` plus a leading
  icon. At 360dp, or at any increased font scale, this label wraps or clips.

**Duplicated information / copy quality**

- Three names for one action in twelve lines: the sheet is titled **"Add to a case"**
  (`(tabs)/_layout.tsx:73`), the body offers to **"Start a new case"**
  (`(tabs)/_layout.tsx:86`), and the button says **"Start a case"**
  (`(tabs)/_layout.tsx:92`). The heading also promises *adding* while the primary action on the
  empty path is *creating*.
- `(tabs)/_layout.tsx:87` — "Start a case to begin. You can add evidence once it exists." "Once
  it exists" describes the lifecycle of a database record. The user's version is "you can add
  evidence as soon as you have a case".
- `(tabs)/_layout.tsx:86` — "add evidence to the case you worked on last" is **not true**. The
  code takes `cases[0]` (`(tabs)/_layout.tsx:17`), i.e. whatever order the repository emitted,
  not a recency sort. The copy makes a specific claim about ordering that the data does not
  guarantee.

**Loading and error states**

- `(tabs)/_layout.tsx:14` — `const { cases } = useCaseList(user?.id ?? null)` destructures
  `cases` and drops both `loading` and `error`, which that hook does return
  (`src/services/use-case-store.ts:33-34`, `82`). Before the first emission `cases` is `[]`, so
  a returning user with twelve cases who taps compose immediately sees the **empty-state**
  sheet — "Start a case to begin. You can add evidence once it exists." — and then watches the
  copy and a whole extra button appear underneath their finger when the subscription lands
  (`(tabs)/_layout.tsx:108-116`). Layout shift inside a modal, on the app's primary action.
- A repository `error` renders as "you have no cases", which is a different and much worse
  statement to make to someone whose evidence is temporarily unreachable.

**Dead ends**

- `(tabs)/_layout.tsx:57-59` — the backdrop and the sheet-body blocker are both bare
  `TouchableWithoutFeedback` with no `accessibilityRole`, no `accessible={false}` on the inner
  one and no `accessibilityViewIsModal` on the sheet. TalkBack can focus content behind the
  scrim, and the dismiss gesture is announced as nothing at all.

---

## `app/(tabs)/index.tsx`

The home screen. The reasoning in the comments is careful and the token discipline is the best
in the flow — and it still has the two worst defects in the audit, both in how it handles its
own data arriving.

**Loading and error states**

- `(tabs)/index.tsx:201` — `casesLoading ? <SkeletonList count={3} />` replaces **the entire
  screen body**. `useCaseList`'s `reload()` bumps a nonce which re-runs the effect and calls
  `setLoading(true)` (`src/services/use-case-store.ts:60`, `77`, `79`). So **every
  pull-to-refresh throws away the hero panel, the case cards and the footer button and paints
  three grey skeleton cards**, then rebuilds. The hook's own docblock
  (`use-case-store.ts:41-43`) states the rule this breaks: "replacing a populated list with a
  spinner on every background refresh is the single most common way an app feels unstable."
  The screens gate on `loading` instead of on `cases.length === 0 && loading`.
- The skeleton is also the wrong shape. `SkeletonCard` (`Feedback.tsx:91-113`) is a
  three-bar card ~110pt tall, ×3 with `gap="lg"` ≈ 370pt. What arrives is one glass hero panel
  with an overline, a chip, a two-line title, a `heading` sentence, an optional deadline row, a
  divider and two buttons — 300-400pt on its own — plus up to three `CaseCard`s and a ghost
  button. `Feedback.tsx:85-89` states the contract the call site is breaking: "A skeleton shaped
  like the content it replaces."
- `(tabs)/index.tsx:234` — inside the hero, the workspace's loading state is a bare
  `<Text colorToken="textSecondary">Loading the latest case review…</Text>`: one line of prose
  where a `Skeleton` belongs. When the workspace lands it is replaced by a `heading` (22/29) plus
  an optional `bodySmall` detail plus, possibly, the whole deadline row — so the hero grows by
  60-140pt and everything under it jumps, *after* the screen already looked finished.
- `(tabs)/index.tsx:178` and `(tabs)/index.tsx:201` fire **together**. On a load failure the user
  is shown "Your cases could not be refreshed" in the header subtitle and "Your cases could not
  be loaded" in the `ErrorState` ~30pt below it — two different sentences, two different verbs,
  for one failure. Same doubling for loading: "Loading your cases…" above a skeleton.

**Leaked internals**

- `(tabs)/index.tsx:201` `detail={casesError.message}` and `(tabs)/index.tsx:234`
  `detail={workspaceError.message}`. `ErrorState` puts this behind a disclosure labelled
  **"Show technical details"** (`Feedback.tsx:291-312`) — so a raw
  `FirebaseError: Missing or insufficient permissions` / `[firestore/unavailable] …` string is
  one tap from the home screen, behind a control that invites the tap. `src/features/settings/auth-errors.ts:83`
  already defines `INTERNAL_MARKERS = ['firebase', 'firestore', 'auth/', …]` and exports
  `looksInternal()` for exactly this decision; neither call site uses it.
- `(tabs)/index.tsx:179` — the zero-case subtitle is **"Your case workspace"**. `Workspace` is
  the internal domain aggregate (`useWorkspace`, `emptyWorkspace()`,
  `src/services/use-case-store.ts:88-144`). It is the data model's name for a shard, surfaced as
  user-facing copy.

**Copy quality**

- `(tabs)/index.tsx:212` — the panel is titled **"Where you left off"**, but the case it shows is
  `cases[0]` (`(tabs)/index.tsx:43`) — the repository's emission order, with no recency sort
  anywhere in `useCaseList` (`use-case-store.ts:81`). The screen makes a specific promise about
  *which* case this is and cannot keep it. `(tabs)/_layout.tsx:86` makes the same false promise
  ("the case you worked on last") from the same `cases[0]`.
- **Five names for one action**, all reaching `/new-case`: "Start another case"
  (`(tabs)/index.tsx:344`), "Create your first case" (`(tabs)/index.tsx:384`), "Create a case"
  (`(tabs)/cases.tsx:151` and `:203`), "Start a case" (`(tabs)/_layout.tsx:92`), "Start a new
  case" (`(tabs)/_layout.tsx:86`). A user cannot learn one verb for the product's central action.
- `(tabs)/index.tsx:234` "Loading the latest case **review**…" — "review" appears nowhere else as
  a noun for this; the screen otherwise says summary/analysis/case status.
- `(tabs)/index.tsx:163` — the fallback greeting when there is no display name is the bare
  wordmark, `'Ddetect'`. An offline-account user (`continueOffline`, `sign-in.tsx:523`) has no
  `displayName`, so their home screen's largest text is the app's own name — the app greeting
  itself.

**Hardcoded styling**

- `(tabs)/index.tsx:378` `maxWidth: 340` — the **fourth** raw content width in the flow (380 in
  `onboarding.tsx:749`, 440 in `sign-in.tsx:576`, 380 in `sign-in.tsx:586`).
  `LAYOUT.maxContentWidth` exists (`tokens.ts:631`).
- `(tabs)/index.tsx:158` `size={44}` on `UserAvatar` — should be `HIT_TARGET` or
  `LAYOUT.tileSize`/`tileSizeLarge` (40/48, `tokens.ts:646-647`); 44 is on neither scale.
- `(tabs)/index.tsx:370` `size={36}` and `(tabs)/index.tsx:279` `size={18}` — raw glyph sizes.
  `Disclosure()` (`Screen.tsx:686-689`) is the shared 18pt chevron in exactly the same
  role as line 279 and is not used.

**Layout defects**

- `(tabs)/index.tsx:162` — the greeting is `variant="title"` (28pt). Every other screen's
  masthead is `variant="display"` (36pt, `Screen.tsx:232`). Home is one full rank quieter than
  the screens it leads to, so entering `Your cases` from `Hello, Alex` feels like the header grew.
- `(tabs)/index.tsx:356-393` — the first-run empty state is a single card pinned to the **top** of
  the viewport with no vertical centring and nothing beneath it. On a 640pt-tall phone that is
  ~320pt of card and ~250pt of bare canvas below it; on a modern tall phone, more. This is the
  literal "card floating in emptiness" case, and it is the screen every new install lands on.
  `EmptyState` (`Feedback.tsx:141`) is the primitive for this and is not used here.
- `(tabs)/index.tsx:286-310` — "Add evidence" and "Open case", both with icons, side by side in
  `Row gap="sm" wrap` inside a `padding="lg"` card. At 360dp that is `(360 - 40 - 32 - 8) / 2` =
  140pt per button for an icon plus 13 characters of `TYPE.label`. At any increased font scale
  these truncate or the row wraps to two full-width buttons with an 8pt gap — which then reads
  as two unrelated stacked CTAs.
- `(tabs)/index.tsx:142-199` — search and notifications scroll away with the content (documented
  at `:122-141`), so on a populated home screen there is no route to search without scrolling
  back to the top. Every `ScreenScroll` screen keeps its actions pinned (`Screen.tsx:419-428`).

**Wrong token for the job**

- `(tabs)/index.tsx:216` — `tone={activeCase.status === 'OPEN' ? 'ok' : 'neutral'}`. `ok` is the
  settled-green, and `tokens.ts:44-47` is explicit that it is load-bearing: "`ok` is the only
  tone that reads as settled … nothing uncertain is ever given the `ok` green." An **open** case
  is the definition of unsettled. It should be `tones.accent` (blue, in-progress) or `neutral`,
  with `ok` reserved for `CLOSED`. As written, the status chip on the home hero tells the user
  their unfinished case is fine.

**Duplicated information**

- `(tabs)/index.tsx:41` re-filters by `ownerId` and `deletedAt` over a list `useCaseList` has
  already filtered by `ownerId` (`use-case-store.ts:81`). Harmless visually, but it means the
  screen does not trust its own data source, and `(tabs)/cases.tsx:78` repeats the same filter a
  third time.
- The case count is stated at `(tabs)/index.tsx:182` ("3 saved cases") and again at
  `(tabs)/index.tsx:330` ("All 3") in the section header directly below.

---

## `app/(tabs)/cases.tsx`

Uses `ScreenList` properly, reads every status label from `CASE_STATUS_LABELS`
(`(tabs)/cases.tsx:119-141`) so no enum value can leak, and is the most token-clean file in
scope. Its problems are all consequences of one decision: the control panel is the hero, and it
is enormous.

**Layout defects**

- `(tabs)/cases.tsx:103-157` — the header panel holds a search field, **five** wrapping filter
  chips, a divider and a full-width primary button, at `padding="xl"`, plus
  `marginBottom: spacing.xl`. Measured at 360×640: `insets.top` + `headerHeight` (52) ≈ 76, the
  `display` masthead with its `paddingTop: xl` / `paddingBottom: xxxl` ≈ 94
  (`Screen.tsx:720-723`), and the panel ≈ 250 with the chips on two rows. The **first case card
  starts around y=440 of a 640pt viewport** — the screen named "Your cases" shows most of one
  case. At a large system font the chips take three rows and no card is visible at all.
- `(tabs)/cases.tsx:112` — `Row gap="xs" wrap` for the filter chips. `xs` is 4pt
  (`tokens.ts:583`), documented as a *drawing* value ("a dot inset, a hairline offset",
  `tokens.ts:562-566`), not a gap between tap targets. Five chips 4pt apart is the cramped
  rhythm `tokens.ts:546-566` was re-cut to eliminate.
- `(tabs)/cases.tsx:177` `size={48}` — raw icon size (the only raw number on the screen).

**Duplicated information**

- **"Create a case" is on screen twice at once** — `(tabs)/cases.tsx:151` in the hero panel and
  `(tabs)/cases.tsx:203` in the empty state — separated by about 40pt, because `empty` renders as
  `ListEmptyComponent` *below* `listHeader` (`Screen.tsx:507-508`). The comment at
  `(tabs)/cases.tsx:147-149` congratulates the two for sharing wording; the actual defect is that
  a first-run user sees the same blue primary button twice, in one viewport.
- The same doubling applies to the filters: on an empty account the panel offers a search box and
  five status filters for zero cases, above a card that says "No cases yet".

**Loading and error states**

- `(tabs)/cases.tsx:96` — `data={error || loading ? [] : filteredCases}`. Because `reload()`
  sets `loading` true again (`use-case-store.ts:60`, `79`), **every pull-to-refresh empties the
  list and swaps in `SkeletonList count={3}`** (`(tabs)/cases.tsx:161-162`). Same defect as Home,
  same cause.
- `(tabs)/cases.tsx:99` — `refreshing={loading}`. `loading` is set true synchronously inside the
  effect and cleared on the first emission, which for the on-device repository is effectively
  immediate; the `RefreshControl` therefore snaps closed before the user's finger has left the
  glass, so the gesture reads as having done nothing while the list underneath flashes skeletons.
- The skeletons render *below* the ~250pt control panel, i.e. below the fold on a small phone. On
  first launch the user sees a fully-composed search-and-filter panel and no evidence that
  anything is loading.

**Dead ends**

- On `error`, `listHeader` still renders (`ScreenList` always draws it, `Screen.tsx:488-499`), so
  the search field, all five filter chips and "Create a case" sit live above "Your cases could not
  be loaded". Typing in the search box filters `[]` and reports nothing; the chips toggle their
  selected state and change nothing. Enabled controls wired to nothing, in the failure state.
- `(tabs)/cases.tsx:167` `detail={error.message}` — the same one-tap "Show technical details"
  disclosure over a raw provider string as on Home.

**Copy quality**

- `(tabs)/cases.tsx:108` placeholder "Search cases or participants" against
  `(tabs)/cases.tsx:109` label "Search your cases by title, category or participant". The
  visible string omits two of the three fields the code actually searches
  (`(tabs)/cases.tsx:83-86`), so nobody discovers category search.
- `(tabs)/cases.tsx:179` "No cases yet" — states a fact. `(tabs)/cases.tsx:189` "Create a case,
  add a claim and start gathering relevant evidence." is a three-step recipe in a
  `bodySmall`; the invitation is doing the work the title should.
- `(tabs)/cases.tsx:95` "Your cases" vs the tab label "Cases" (`(tabs)/_layout.tsx:45`) vs
  "Your other cases" (`(tabs)/index.tsx:327`) vs the orphan route `app/previous-cases.tsx`.

---

## `app/new-case.tsx`

The best-written screen in the flow at the copy level — the presets carry worked examples
instead of templates (`new-case.tsx:8-17`), and it is the **only** screen in scope that
explains its own disabled button. Three things undo that.

**Leaked internals**

- `new-case.tsx:151-159` — the catch handles exactly one code (`permission-denied`) and
  otherwise renders **`caught.message` verbatim** into a `Notice` at the top of the form. Two
  concrete leaks follow:
  - `new-case.tsx:134` calls `caseSchema.parse(createdCase)`. A `ZodError`'s `.message` is a
    **JSON array of issue objects** — `[{"code":"invalid_type","path":["incidentDate"],…}]`.
    The user's error banner would contain a JSON blob with camelCase field names and an
    internal path array. The same applies to `claimSchema.parse` (`new-case.tsx:144`).
  - Any Firestore/storage rejection without a `code` reaches the banner as the SDK wrote it.
  `readableAuthError` / `looksInternal` (`src/features/settings/auth-errors.ts:92`, `:114`)
  exist for precisely this and are not imported here.
- `new-case.tsx:127` — `priority: 'NORMAL'` is written into every case from a literal in the
  screen, with no control anywhere in the creation flow. Every case the user makes carries a
  field they were never asked about and cannot see or change here.

**Duplicated information**

- The word "optional" appears **six times** on one screen: the subtitle already says it globally
  ("A title is all you need to begin. Everything else can be added later.",
  `new-case.tsx:170`), then `Chip label="Optional"` at `:243`, `:264` and `:289`,
  `labelHint="optional"` at `:228` and `:277`, and the sentence "Optional. Pick the closest
  one, or write your own below." at `:207`. Three of those chips are visually identical grey
  pills in the top-right of three consecutive cards, which is the same fact stated three times
  in the same place with the same shape.
- `new-case.tsx:201` `hint="Required. A short name you will recognise later."` and
  `new-case.tsx:376` "Add a title above to create this case." are the same fact — and the
  second one is at the *bottom* of a four-card form, so it says "above" about a field that is
  well over a screen away.
- `new-case.tsx:350` `label={busy ? 'Creating…' : 'Create case'}` **and** `:355`
  `loading={busy}`. The button changes its own label and shows a spinner for the same state.

**Layout defects**

- `new-case.tsx:175` `maxWidth: 780` — the fifth raw content width in the flow, and it
  **exceeds `LAYOUT.maxContentWidth` (720)** (`tokens.ts:631`), so on a tablet this form is
  wider than the width the design system declares readable.
- `new-case.tsx:178` `paddingBottom: theme.spacing.giant` (48) is added *inside* a
  `ScreenScroll` whose content already ends with `insets.bottom + spacing.giant`
  (`Screen.tsx:402`). The longest form in the app therefore ends with ~120pt of empty canvas
  under its last control.
- `new-case.tsx:242`, `:263`, `:287` — card headings are `variant="title"` (28pt). `title` is a
  *screen* rank; `SectionHeader` sets a section at `heading` (22pt) and documents why
  (`Screen.tsx:596-615`). Three 28pt headings inside cards, under a 36pt `display` masthead,
  flattens the hierarchy the type scale was re-cut to create — and `SectionHeader`/`Section`,
  the primitives for this exact job, are not used anywhere on the screen.
- `new-case.tsx:348-364` — "Create case" and "Cancel" are in a `Row gap="md" wrap` with **no
  `fullWidth` and no `flex: 1`**, so both shrink to their text. The app's primary CTA is
  full-width on every other screen (`sign-in.tsx:488`, `onboarding.tsx:631`,
  `(tabs)/cases.tsx:154`). Here the screen's only submit is a small pill in the bottom-left of
  a 780pt-wide column with dead space to its right.
- `new-case.tsx:254` `minHeight={80}` and `:271` `minHeight={100}` — raw, off-scale, and two
  different heights for two adjacent multiline fields.
- `new-case.tsx:281` — placeholder "14 March 2026, or October 2025 to January 2026" is 46
  characters in a single-line field. At 360dp it is clipped mid-example, so the user sees
  "14 March 2026, or October 202…" and never learns a range is allowed.

**Copy quality**

- The screen is titled **"Start a case"** (`new-case.tsx:168`) and its submit button says
  **"Create case"** (`:350`). Two verbs for one action, 200 lines apart, on the same screen —
  and both differ from "Create a case" on `(tabs)/cases.tsx:151`.
- `new-case.tsx:181` — the error banner's title is "Check this first" for *all* errors,
  including "This case could not be saved to your account" (`:155`). A server failure is not
  something the user can "check first"; the title contradicts the message under it.
- `new-case.tsx:375` "Getting your **storage** ready." — the storage adapter is an
  implementation detail (`useRepository().ready`).
- `new-case.tsx:242` "The first thing to check" as a card title, containing a field labelled
  "Statement to check" (`:250`) — "check" twice, and neither says the word *claim*, which is
  what the record is called everywhere else in the product.
- `new-case.tsx:312` placeholder "Rahul Sharma, or **ABC Bank**" — "ABC Bank" is
  placeholder-generator filler, on a screen a real user fills in about a real bank.

**Dead ends**

- `new-case.tsx:181` puts the error `Notice` at the **top** of the form while
  `new-case.tsx:349` is the submit at the **bottom**. After a failed save the button
  re-enables, nothing near the user's finger changes, and the explanation is off-screen. There
  is no scroll-to-error and no toast, although `ToastProvider` is mounted at the root
  (`_layout.tsx:142`) and `useToast()` resolves anywhere.

---

## `app/case/[caseId]/upload.tsx`

The functional heart of the product and the least finished screen in the audit. The logic is
careful — per-file retry, honest abort messaging, hash-based duplicate flagging — and none of
that reaches the user, because the screen is one 95-line JSX expression with no sections, six
raw spacing values, five different nouns for the thing being added, and a vendor name in body
copy.

**Leaked internals** (highest concentration in the app)

- `upload.tsx:340-341` — "…audio or video through transcription, which needs a **Groq** key set
  up in Settings. A file **this build** cannot read is kept unchanged…". A model-provider name
  and the word "build" in user-facing body copy, plus "on-device OCR" and "their own text
  layer" in the same paragraph. Every item on the client's removal list in four lines.
- `upload.tsx:316` — `message={(loadError?.message ?? error)!}` renders the **raw repository
  error inline in a `Notice`**, with no "technical details" disclosure to hide behind. This is
  the one place in the flow where an SDK string is displayed unconditionally.
- `upload.tsx:93`, `:112`, `:226`, `:301` — four more `caught.message` passthroughs. `:226`
  writes the raw message onto the per-file error line, so `Network request failed` or
  `storage/unauthorized` becomes the label under a user's document.
- `upload.tsx:209` — `error: receipt.failureReason ?? undefined`. The processing pipeline's
  own failure string is rendered as user copy with no mapping layer.
- `upload.tsx:352` — `<Text variant="subheading">{item.name}</Text>`. The card's largest text
  is the **raw filename** (`Screenshot_2026-09-15-22-36-01_com.whatsapp.jpg`,
  `IMG_20240914_120233.jpg`), set in the *human* sans at 17.5pt, directly above the "Source
  title" field the user is asked to fill in. This inverts the product's central typographic
  claim — `tokens.ts:54-70` and `ProvenanceValue` exist so machine strings are monospace and
  human text is sans. Here the machine string is the human-voice headline and the human title
  is a form field below it.

**Copy quality — five nouns for one thing**

On this single screen the thing the user is adding is called:
**evidence** (`upload.tsx:314`, title "Add evidence"), **sources** (`:392` "Save selected
sources", `:236` "N sources are saved", `:353` "Source title", `:329` "Source or contributor"),
**records** (`:328` "Add original records from each perspective"), **files** (`:338` "Files are
stored and read on this device", `:387` "Read this file again"), and **statements** (`:403`).
A person cannot tell whether "Save selected sources" is the button that saves the evidence they
just chose.

- `upload.tsx:316` — the error banner is titled **"Action needs attention"** for both a load
  failure and an operation failure. It names no action, no object and no remedy.
- `upload.tsx:328` "Their content stays separate from what someone claims happened." and
  `:403` "Typed statements are **attributed accounts**. They are not treated as independent
  proof." — the product's epistemics stated in the product's own vocabulary rather than the
  user's.
- `upload.tsx:352` "Size checked during upload" — the system narrating its own bookkeeping.
- `upload.tsx:311` — a bare `'Failed'` status for a file that was never stored, with no verb
  and no next step; every other status string on the screen is a sentence or a compound.
- `upload.tsx:53` and `:338` both hardcode **"100 MB"** as prose while
  `MAX_EVIDENCE_UPLOAD_BYTES` is imported at `:12` and `formatBytes` at `:14`. If the limit
  moves, the copy lies in two places.

**Hardcoded styling**

- `upload.tsx:315` `gap: 24` → `SPACING.xxl`; `maxWidth: 800` — the **sixth** raw content
  width, 80pt over `LAYOUT.maxContentWidth`.
- `upload.tsx:324` and `:351` `gap: 10` — **10 is not on the 4pt scale at all**. `tokens.ts:552-566`
  documents the re-cut specifically to remove off-grid values like the old `sm: 6`; this
  reintroduces one, in the card that repeats once per uploaded file.
- `upload.tsx:402` `gap: 16` → `SPACING.lg`. `upload.tsx:405` `minHeight={140}` — raw.

**Layout defects**

- `upload.tsx:331-336` — four sibling actions ("Choose files", "Take photo", "Photos or
  videos", "Record audio") in a `Row` with `flexWrap`, none of them `flex: 1`. They size to
  their labels, so at 360dp they wrap into two ragged rows of unequal pills with a jagged right
  edge. This is the first thing the user sees on the screen they came to the app to use.
- `upload.tsx:337-342` — a **90-word paragraph at `TYPE.caption` (12pt)** in `textSecondary`,
  above the fold, explaining OCR, PDF text layers, transcription and provider keys. It is the
  densest and smallest block of text in the product.
- The screen has no `Section`/`SectionHeader` anywhere and exactly one `heading`
  ("Record a statement", `:403`), so the upper two-thirds — intro, two metadata fields, four
  pickers, the caption, the file cards — is an unstructured column.
- `upload.tsx:314` — `subtitle={record?.title}`. While the workspace loads, the subtitle is
  `undefined` and `Masthead` omits the node entirely (`Screen.tsx:235-240`); when the record
  lands the subtitle appears and **pushes the whole screen down** by a `body` line plus
  `spacing.sm`.

**Loading and error states**

- There is no loading state. `loading` from `useWorkspace` (`upload.tsx:62`) is used only
  inside `disabled={busy || loading || !record}` (`:332-335`). So on entry the user gets the
  complete screen with all four pickers greyed out, no skeleton, no spinner and **no
  sentence explaining why nothing is tappable**.
- `upload.tsx:354-356` — the status line's tone is chosen with three nested ternaries and the
  `warn`/`danger` split on `:377` is a *second* rendering of the same failure, so a stored-but-
  unread file shows "Saved · Could not be read" and then its error message immediately below.
- `upload.tsx:262-275` and `:292-300` — a failed `requestCaseAnalysis` is swallowed on both
  paths. The comment argues the upload succeeded, which is true; the consequence is that the
  deterministic comparison this product *is* can silently not run, and the user's notice says
  only "saved". They are never told the analysis did not happen.

**Dead ends**

- `upload.tsx:135` — `if (lock.current || !user || !record) return;`. A deep link or a stale
  `caseId` leaves `record` undefined, every control disabled forever, and **no message at all**:
  `loadError` covers a repository failure, not "this case does not exist".
- `upload.tsx:406` — "Save statement" is disabled until both the title and the body are
  non-empty, with no explanation. `new-case.tsx:372-378` solves this exact problem 30 lines of
  code away and the solution is not reused.
- `upload.tsx:408` "Return to case" (`router.replace`) duplicates the header's back chevron
  (`back` on `:314`, which calls `router.back()`, `Screen.tsx:136`). Two exits, different
  wording, different history semantics, one screen.
- `upload.tsx:317` — the success `notice` renders at the **top** of the screen while
  "Save selected sources" (`:392`) is far down the list. Pressing it produces no visible
  confirmation anywhere near the button.

---

## `app/search.tsx`

Well-reasoned (the in-memory index, the deferred value, the `!ready` handling) and the chrome
is mostly tokenised. Two things are damaging: the internal type is the UI copy, and opening a
result destroys the search.

**Leaked internals**

- `search.tsx:33` — `const FILTERS: readonly ('All' | SearchKind)[] = ['All', 'Cases',
  'Evidence', 'Claims', 'Entities', 'Events'];` and `:316` `<Chip label={kind} …>`. The
  internal `SearchKind` union is painted directly as chip labels, and again as the row's kind
  line at `:377` (`{item.kind} · {item.context}`). **"Entities"** is data-model vocabulary — the
  user's word is "people" or "names". There is no label map, although the codebase has the
  pattern for exactly this (`CASE_STATUS_LABELS`, `enums.ts:229`, used correctly by
  `(tabs)/cases.tsx:119-141`).
- `search.tsx:405` `detail={error}` where `error` is `caught.message` (`:185`) — the same
  one-tap "Show technical details" route to a raw repository string.
- `search.tsx:412` "Your search is limited to your own **workspace**." and `:418` "Your
  **workspace** is empty" — the domain aggregate's name, twice, as user copy.

**Layout defects**

- `search.tsx:449` — `result: { paddingVertical: 20, borderBottomWidth: 1 }`. Every other
  separator in the app is `StyleSheet.hairlineWidth` (`Screen.tsx:512`, `:712`, `:732`), so
  search rows carry a visibly heavier rule than any other list — at 1px against `colors.border`
  it is the "bright border reads as cheap" case from `tokens.ts:279`. `20` should be
  `SPACING.xl`, `1` should be `BORDER_WIDTH.hairline`.
- `search.tsx:387` — `marginTop: 6`. **6 is the exact value `tokens.ts:552-556` was re-cut to
  eliminate** ("`sm` was *6* — off the 8pt grid — and was the single most-used value in the
  codebase"). `search.tsx:379` `marginTop: 4` should be `SPACING.xs`.
- `search.tsx:446` `header: { paddingTop: 12 }` → `SPACING.md`.
- `search.tsx:448` `filter: { minHeight: 44 }` duplicates `HIT_TARGET` and is redundant —
  `Pressable` already applies `minHeight: HIT_TARGET` itself (`Layout.tsx:313`).
- `search.tsx:373` `size={22}` and `:394` `size={18}` — raw icon sizes; the 18pt chevron is
  `Disclosure()` (`Screen.tsx:686`), unused again.
- **Two implementations of one control.** `search.tsx:307-318` renders filter chips with only
  the `tone` changing between states; `(tabs)/cases.tsx:274-299` renders the same control with
  `emphasis={active ? 'soft' : 'outline'}` *and* `haptic` *and* `pressScale={0.96}`. The same
  filter row looks and feels different on the two screens that have one, and neither uses a
  shared component.

**Duplicated information**

- `search.tsx:359-361` — one string carries a live count and a permanent instruction joined by
  a middot: `${results.length} matching records · Names, document text and dates are
  searchable`. The instruction is then repeated in the no-results state (`:426` "Try another
  name, date, phrase or document title").
- `search.tsx:283` placeholder "Search your evidence and cases" against `:284` label "Search
  cases, evidence, claims, entities and events" — the visible string covers two of the five
  kinds the chips offer.

**Copy quality**

- `search.tsx:420` — `label: 'Create case'`: the **seventh** distinct name for the same action
  in this flow.
- `search.tsx:359` "matching **records**", `:403` "load your **records**", `:425` "No matching
  **records**". "Records" is a fourth noun for the material, alongside evidence, sources and
  files.
- `search.tsx:333` — a `Notice` titled "Recent searches" whose message is "Recent searches
  could not be loaded." The title is a noun phrase that repeats the message's subject instead
  of saying what happened.

**Loading and error states**

- `search.tsx:400` `SkeletonList count={4}` — card-shaped three-bar skeletons standing in for
  borderless icon+three-line rows. Wrong shape, so the list visibly re-rhythms when results
  land (`Feedback.tsx:85-89`).
- `search.tsx:164` — `if (!ready) return;` leaves `loading` true with **no deadline and no
  escape**. If the storage adapter never becomes ready the search screen shows shimmering
  skeletons indefinitely: no error, no retry, no message. Compare `_layout.tsx:88`, which exists
  because that failure mode was already understood at boot.

**Dead ends**

- `search.tsx:216-256` — every result opens with `router.replace`, so **the search screen is
  destroyed by using it**. Back from the case/claim/evidence screen returns to whatever was
  under the modal, not to the results. A user checking three matches has to re-open search and
  re-type each time; `router.push` is what a modal search wants.
- `search.tsx:413` — the signed-out `EmptyState` action also `replace`s, so a user who signs in
  from here loses the query they came with.

---

## `app/+not-found.tsx`

57 lines, and the only screen in the flow that centres its content properly
(`+not-found.tsx:45-50`).

**Leaked internals / copy quality**

- `+not-found.tsx:34` — **"Return to Dashboard"**. Two defects in one label: "Dashboard" is a
  name the UI uses nowhere (the tab is "Home", `(tabs)/_layout.tsx:44`, and the screen itself
  greets by first name), and it is Title Case where every other button in the app is sentence
  case ("Create a case", "Add evidence", "Save statement").
- `+not-found.tsx:21` "This **page** is not here" — the comment at `:16-18` correctly removed
  the "404" but kept "page", which is web vocabulary in a native app. The records this screen
  is actually reached for are cases, claims and evidence items.

**Duplicated information**

- `+not-found.tsx:13` — `<Stack.Screen options={{ title: 'Page not found' }} />` is dead:
  `_layout.tsx:190` sets `headerShown: false` for the whole stack. So the file carries a second,
  differently-worded title ("Page not found" vs "This page is not here") that can never render.

**Hardcoded styling**

- `+not-found.tsx:49` `padding: 20` → `theme.layout.screenPadding`.
- `+not-found.tsx:53` `maxWidth: 400` — the **seventh** raw content width in the flow. Full
  set: 380 (`onboarding.tsx:749`), 440 (`sign-in.tsx:576`), 380 (`sign-in.tsx:586`), 340
  (`(tabs)/index.tsx:378`), 780 (`new-case.tsx:175`), 800 (`upload.tsx:315`), 400 here.
  `LAYOUT.maxContentWidth` (720) is referenced by none of them.

**Dead ends**

- `+not-found.tsx:37` — `router.replace('/(tabs)')`. For a signed-out user who followed a stale
  link this drops them into the tab shell, which by design renders empty workspaces for a
  missing session (`_layout.tsx:38-45`) rather than routing to `/sign-in`. The escape hatch
  lands them in an app that looks like it lost their data.
- Presented as a `modal` with `headerShown: false` (`_layout.tsx:205`), so there is no close
  affordance other than that one button, and it discards the history rather than dismissing.

---

## Ranked

1. **Every pull-to-refresh throws away loaded content and paints grey skeletons** — `reload()`
   re-sets `loading` (`src/services/use-case-store.ts:60`), and both tab screens gate their
   whole body on it, so refreshing the app's two main screens wipes them:
   `app/(tabs)/cases.tsx:96` (and `app/(tabs)/index.tsx:201`).
2. **Raw SDK and validation strings are shown to the user as error copy** — a `ZodError`'s JSON
   issue array or a bare Firestore message goes straight into the form's banner at
   `app/new-case.tsx:157`, and the repository's message is rendered inline with no disclosure at
   `app/case/[caseId]/upload.tsx:316`.
3. **A model-provider name and build vocabulary in body copy** — "which needs a Groq key set up
   in Settings. A file this build cannot read…" at `app/case/[caseId]/upload.tsx:340-341`,
   alongside "on-device OCR" and "their own text layer".
4. **The search screen paints an internal type union as its UI** — `SearchKind`'s members,
   including **"Entities"**, are the chip labels and the row kind line, with no label map:
   `app/search.tsx:33`.
5. **The screen every new install lands on is one card stranded at the top of an empty
   viewport** — the first-run state has no vertical centring and hundreds of points of bare
   canvas beneath it: `app/(tabs)/index.tsx:356-393`.
6. **The case list buries the cases** — a search field, five wrapping filter chips, a divider
   and a full-width button in one `padding="xl"` hero push the first case card to roughly
   y=440 on a 360×640 device: `app/(tabs)/cases.tsx:103-157`.
7. **The product's central action has seven names** — "Start a case", "Create a case", "Create
   case", "Start another case", "Create your first case", "Start a new case", "Create case"
   again; anchor: `app/(tabs)/index.tsx:344`.
8. **The upload screen calls the thing being added five different nouns** — evidence, sources,
   records, files, statements, with the title saying one and the primary button another:
   `app/case/[caseId]/upload.tsx:392` against `:314`.
9. **The upload card headlines a raw filename in the human typeface** — `item.name` at
   `subheading` rank above the field where the user is asked for a title, inverting the
   sans/mono provenance rule the product is built on: `app/case/[caseId]/upload.tsx:352`.
10. **The compose sheet is hand-built and unfinished** — a `Modal` that *fades* instead of
    sliding, no safe-area inset anywhere in the file, and an untinted pure-black shadow, while
    `BottomSheet` and `ELEVATION_DARK` both exist: `app/(tabs)/_layout.tsx:136-140`.
11. **Onboarding states the user's position three times in one 100pt footer** — page dots, a
    "Step 1 of 3" caption 20pt below them, and a CTA that relabels itself:
    `app/onboarding.tsx:623`.
12. **The first screen's primary button is disabled on first paint with nothing saying why** —
    `disabled={!canSubmit}` while every field error is still suppressed as untouched:
    `app/sign-in.tsx:489`.


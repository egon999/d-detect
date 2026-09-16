# Case workspace + remaining screens — read-only UI audit

Scope: the `app/case/**` workspace, `app/(tabs)/insights.tsx`, `app/previous-cases.tsx`,
`app/notifications.tsx`, `app/about.tsx`. Read in full, against `src/ui/tokens.ts` and the
primitives re-exported from `src/ui/index.ts`.

## Calibration used (not reported as bugs)

- `colors.accent` = gold (`palette.gold500`), for **structure**: icon tints, selection and focus
  borders, quote rules, the refresh spinner, the caret. `tokens.ts:438-449`.
- `colors.cta` = blue `#2B5FD9`, for the **primary button** only. Gold cannot carry white text
  (2.34:1). `tokens.ts:452-455`.
- `tones.accent` = blue, for **chips/tiles** that sit in a row beside `warn`/`ok`/`danger`, because
  gold is 2.6° from `warn`. `tokens.ts:471-487`.

What *is* reported below: a screen reaching for the wrong one of those three for what the element
is actually doing, and every raw value that bypasses `SPACING` / `RADIUS` / `TYPE` /
`BORDER_WIDTH` / `LAYOUT` / `colors`.

Reference values quoted throughout: `SPACING` = xxs 2, xs 4, sm 8, md 12, lg 16, xl 20, xxl 24,
xxxl 32, huge 40, giant 48 (`tokens.ts:580-593`); `RADIUS` = xs 6, sm 10, md 14, lg 18, xl 24
(`tokens.ts:599-608`); `LAYOUT.screenPadding` = 20, `maxContentWidth` = 720, `tileSize` = 40
(`tokens.ts:619-648`); `TYPE.body.lineHeight` = 23.5 (`tokens.ts:713`); `HIT_TARGET` = 44.

---

## `app/case/_layout.tsx`

Thirteen lines, no content. Nothing to fault, and one thing to note.

1. **Layout.** n/a — a bare `Stack`.
2. **Hardcoded styling.** None. Note it does *not* set
   `contentStyle: { backgroundColor: theme.colors.canvas }`, which the nested layout does
   (`app/case/[caseId]/_layout.tsx:33`). On this navigator the transition between `case/index` and
   `case/[caseId]` therefore animates over the default (white on Android) navigator background
   rather than the canvas — a white flash on a dark-first product, at
   `app/case/_layout.tsx:6-11`. Small, and the most visible "cheap" tell in a file this size.
3. **Copy.** n/a.
4. **Leaked internals.** None.
5. **Loading/error.** n/a.
6. **Dead ends.** None.

## `app/case/index.tsx`

Six lines: `<Redirect href="/(tabs)/cases" />`.

1-6. Nothing to report. The redirect target is a group-qualified path (`/(tabs)/cases`) while every
   other redirect-style fallback in the app uses the unqualified `/cases`
   (`src/ui/primitives/Screen.tsx:137`, `app/case/[caseId]/index.tsx:333`). Cosmetic only — both
   resolve — but worth unifying so a reader of the route table sees one spelling.

---

## `app/case/[caseId]/_layout.tsx`

Clean, documented, and the reasoning in the docblock is correct. Nothing to report except one
consequence the file itself does not mention:

6. **Dead ends.** `export` is declared `presentation: 'modal'` (line 40-41) and so is `upload`. The
   export *route* is also offered as an ordinary row inside the case screen's "Go further" list
   (`app/case/[caseId]/index.tsx:158-163`), i.e. the same destination is presented as a pushed page
   in one place and a modal in the other. The user gets a different dismissal gesture depending on
   which of the two entry points they used (header icon vs. the row). Not a bug in this file, but
   this is where the mismatch is decided.

---

## `app/case/[caseId]/index.tsx` — the case screen

The best screen in this scope by a wide margin: skeleton shaped like the content, error state,
empty states with actions, `maxContentWidth`, tokens throughout, copy written from the user's side.
Findings are small and mostly about consistency with the rest of the app.

### 1. Layout defects

- `app/case/[caseId]/index.tsx:432` — `<View style={{ marginTop: theme.spacing.huge }}>` wraps
  `CaseAnalysisPanel`, which is dropped *between* two `Section`s that already carry
  `marginTop: huge` themselves (`Screen.tsx:670`). The panel therefore sits 40pt below the sources
  list and 40pt above "Events you recorded", but with no section header of its own — it reads as a
  card floating in emptiness between two labelled groups. Every other block on the screen is
  introduced by a `Section`.
- `app/case/[caseId]/index.tsx:522-530` — the closing disclaimer is `marginTop: huge` after the
  last section, in `caption`/`textTertiary`, with `paddingBottom: insets.bottom + giant` under it
  (`Screen.tsx:402`). At 360dp that is ~88pt of near-empty canvas at the end of the scroll.
- `app/case/[caseId]/index.tsx:805-806` — rows are `paddingVertical: SPACING.lg` (16) with no
  `minHeight`. A single-line destination row lands at ~51pt, under `HIT_TARGET` 44 only for the
  text but well under `LAYOUT.rowHeight` 56 which the tokens define as "a single-line row in a
  dense list" (`tokens.ts:644`). The evidence/event/destination rows in this screen and the rows in
  `timeline.tsx` therefore do not measure the same.
- `app/case/[caseId]/index.tsx:481-490` — the participants row is `Row gap="lg"` with
  `<Text variant="bodyMedium" style={styles.flex}>` for the name and an unflexed
  `variant="caption"` role beside it. A long role ("Relationship manager, retail branch") on a
  360dp screen squeezes the name; the role has no `numberOfLines`.
- `app/case/[caseId]/index.tsx:635-644` — `Row gap="sm"` holding the date and the
  "could be read either way" caption does not wrap. At 360dp with a large system font the caption
  is clipped rather than moved to a second line (`Row` needs `wrap`, as used at
  `event/[eventId].tsx:265`).

### 2. Hardcoded styling

Almost none — this screen is the model. Two items:

- `app/case/[caseId]/index.tsx:579`, `:590` — `size={13}` on the two `Icon`s in `CaseMeta`, and
  `:683` — `size={19}` on the destination icon. Raw icon sizes, and 19 is unique in the codebase's
  vicinity (`Disclosure` is 18, `Screen.tsx:688`). No icon-size token exists, which is the real
  gap, but these three literals are what a reader sees as "the icons are all slightly different
  sizes".
- `app/case/[caseId]/index.tsx:733` — `Shimmer width={BORDER_WIDTH.thick}` uses a *border width*
  token as a *width* for the skeleton's accent rule. It produces the right number (2) for the wrong
  reason; `SPACING.xxs` is the token for a 2pt drawing dimension (`tokens.ts:583`).

### 3. Copy quality

- `app/case/[caseId]/index.tsx:337` — `title="What you asked us to check"`. "us" is the only place
  in the app that gives the product a first-person plural voice; everywhere else it is "the
  analysis" / "the checks" (e.g. `:499`, `:527`). It also mis-describes the section, which lists
  claims the user wrote, not a request they made.
- `app/case/[caseId]/index.tsx:342` vs `:363` vs `:441` — "Add claim", "Add the first claim",
  "Add event". Three shapes for two actions. The header action beside them is
  `'Add a source'` (`:302`) while the empty state's is `'Add a source'` (`:413`) and the section
  action is `'Compare'` (`:379`) against the destination row's `'Compare sources'` (`:133`).
- `app/case/[caseId]/index.tsx:463-468` — the events empty state is a bare paragraph of
  `bodySmall`/`textSecondary` with **no action**, while the two empty states above it are
  `EmptyState compact` with an "Add…" button (`:358-364`, `:407-420`). The section header does
  carry an `action` (`:441`), so the affordance exists — but the empty state itself states a fact
  ("Nothing recorded.") where its two siblings invite an action.
- `app/case/[caseId]/index.tsx:688` — `'Not available yet — this case has too little in it.'`
  replaces the destination's own specific `hint`. The docblock two lines above promises the row
  "still shows its precondition" and that `available` exists "so each destination states its own
  precondition next to itself" (`:96-101`, `:654-657`) — but the rendered string is generic for all
  six. The one thing the reader needs ("needs more than one source") is exactly what is dropped.
- `app/case/[caseId]/index.tsx:596` — `checked 2 hours ago · records changed since`. Lowercased mid
  sentence and glued with `·` to a second clause; the same staleness is stated as a full-sentence
  `Notice` title on the claim screen ("The case has changed since this was assessed",
  `claim/[claimId].tsx:242`).
- `app/case/[caseId]/index.tsx:332` — `'…Nothing was loaded.'` and `:305`
  `'Nothing has been changed.'` are good; but `:329-334` titles it `'Case unavailable'` where the
  error above says `'This case could not be loaded'`. Two different registers for two states the
  user cannot distinguish.

### 4. Leaked internals

- `app/case/[caseId]/index.tsx:777` — `item.status === 'OPEN'` is a `SCREAMING_SNAKE` comparison
  (fine, internal) but its label surfaces as `'Findings still open'` (`:796`) — the only ledger line
  whose wording is derived from an enum value rather than from the user's vocabulary. Borderline;
  no raw token reaches the screen.
- Nothing else. No ids, no model names, no confidence decimals, no `case_a1b2`. `record.category`
  goes to the masthead `overline` (`:292`) — worth a spot-check that `category` is a display string
  and not an enum key, because `Masthead` uppercases it (`Screen.tsx:227`) and a
  `BANK_DISPUTE`-shaped value would render as-is.

### 5. Loading and error states

- Correct and the best in the app: `CaseSkeleton` (`:708-747`) is shaped like the content, is
  `accessibilityRole="progressbar"`, and reuses `theme.type.*.lineHeight` for block heights so the
  layout does not shift when the real text lands.
- One gap: `loading && !record` chooses the skeleton (`:326`), so a *refresh* of an already-loaded
  case shows only the `RefreshControl`. Correct. But `error` takes priority over `record`
  (`:319`), so a transient reload failure on a case that is already on screen replaces the whole
  page with `ErrorState` and the user loses their scroll position and the content they were
  reading.

### 6. Dead ends

- `app/case/[caseId]/index.tsx:503-517` — `onPress` on a disabled `DestinationRow` still fires
  `router.push` if `caseId` is set; the guard is `disabled={!enabled}` on the `Pressable`
  (`:673`), which is correct, but the row also drops its `Disclosure` chevron when disabled
  (`:690`) so the only feedback for a tap on a disabled row is nothing at all — no toast, no
  reason. Combined with the generic string at `:688`, a user tapping "Connections" on a
  one-document case learns nothing.
- `app/case/[caseId]/index.tsx:333` — `router.replace('/cases')` from the "Case unavailable" state,
  while `Screen.tsx:137` falls back to `router.replace('/cases')` too. Consistent. No dead end.

---

## `app/case/[caseId]/claim/[claimId].tsx` — claim review

### 1. Layout defects

- `claim/[claimId].tsx:194-200` — no `contentStyle={{ maxWidth: LAYOUT.maxContentWidth }}`. The
  case screen sets it and documents why (`index.tsx:313-317`); this screen sets long claim
  sentences and `assessment.explanation` prose to the full tablet/web width.
- `claim/[claimId].tsx:212` — the whole column is one `gap: theme.spacing.xl` (20) stack. Every
  block is spaced identically: the claim card, the stale warning, the assessment, the run button,
  the links heading, the disclaimer, the destructive button. There is no grouping, so "Links you
  recorded" (a section, `:350`) is separated from the assessment card above it by exactly the same
  20pt as two notices are from each other. This is the flatness the token docblock describes
  (`tokens.ts:559-566`) reproduced by hand at one call site.
- `claim/[claimId].tsx:321-340` — `Row gap="sm" style={styles.wrap}` with a `loading` primary
  button labelled `'Comparing sources…'` and a secondary `'Add evidence'`. At 360dp those two
  labels wrap to two lines and the primary button changes width as its label changes between
  `'Assess this case'` / `'Assess again'` / `'Comparing sources…'`, so the secondary button jumps
  to the next row and back mid-interaction.
- `claim/[claimId].tsx:225-236`, `:379-407`, `:502-512` — `flexWrap: 'wrap'` on `Row` is applied via
  `styles.wrap` (`:585`) rather than `Row`'s own `wrap` prop, which exists and is used at
  `event/[eventId].tsx:265`. Same result, but it means three of the four wrap sites in this scope
  are hand-rolled.
- `claim/[claimId].tsx:465-533` — the "Connect evidence" modal renders **one full-width `Button`
  per source** (`:485-492`), each labelled with `item.title`. A case with 30 sources produces 30
  stacked buttons; a source titled with a filename overflows the label. A selection list is not a
  stack of primary/secondary buttons.
- `claim/[claimId].tsx:263` — `Saved {new Date(report!.createdAt).toLocaleString()}` inside a
  `caption`. The locale string is 20+ characters and unwrapped next to other captions.
- `claim/[claimId].tsx:535-563` — the destructive confirm is a `transparent` `Modal` with
  `styles.overlay` = `{ flex: 1, padding: 24, justifyContent: 'center' }` (`:584`). No max width,
  so on a tablet the dialog is as wide as the screen minus 48.

### 2. Hardcoded styling

Quoted exactly, `claim/[claimId].tsx:582-588`:

```
sheet: { flexGrow: 1, padding: 24, gap: 20 },
overlay: { flex: 1, padding: 24, justifyContent: 'center' },
wrap: { flexWrap: 'wrap' },
dot: { width: 4, height: 4, borderRadius: 2 },
flex: { flex: 1 },
```

- `padding: 24` ×2 → `SPACING.xxl`. Also *wrong value*: every screen's gutter is
  `LAYOUT.screenPadding` 20 (`tokens.ts:629`), so both modals are inset 4pt further than the screen
  behind them.
- `gap: 20` → `SPACING.xl`.
- `dot: { width: 4, height: 4, borderRadius: 2 }` → `SPACING.xs` / `SPACING.xxs`, which the token
  docblock says exist for exactly this ("`xxs` 2 and `xs` 4 … exist for drawing — a dot inset",
  `tokens.ts:566-567`). `RADIUS.pill` would be the honest radius.
- `claim/[claimId].tsx:431-432`, `:471-472` — `paddingTop: insets.top + theme.spacing.lg`,
  `paddingBottom: insets.bottom + theme.spacing.xl`. Tokenised, but different from
  `evidence/[evidenceId].tsx:253` which uses `insets.top + 16` / `insets.bottom + 24` raw for the
  same modal shape. Two spellings of one layout.

### 3. Copy quality

- **The same action, three names, across three screens.** `'Connect evidence'` (`:235`, `:478`),
  `'Add evidence'` (`:338`), `'Add a source'` (`index.tsx:302`, `:413`), `'Connect this source'`
  (`evidence/[evidenceId].tsx:261`), `'Link to a claim or event'`
  (`evidence/[evidenceId].tsx:201`). The product's own noun is split between "evidence" and
  "source" — the case screen's section is titled `'Sources'` (`index.tsx:373`), this screen's
  buttons say "evidence".
- `claim/[claimId].tsx:137` — `'That could not be completed.'` The generic fallback for *every*
  failed write on the screen: save, link, unlink, delete, analyse. The user cannot tell which.
- `claim/[claimId].tsx:214` — `title="That did not work"`. Written from the system's side and says
  nothing; the same screen manages a specific title in its modals
  (`'The claim could not be saved'`, `:455`).
- `claim/[claimId].tsx:216` — `<Notice tone="info" title="Saved" …>` is reused for messages that are
  not about saving: `'Assessment finished on this device.'` (`:331`) is announced under the title
  "Saved".
- `claim/[claimId].tsx:323` — `'Assess this case'` on a screen titled "Claim review", next to a
  claim. The user pressed a button on one claim and the label tells them the whole case is being
  assessed (true, but the pairing reads as a mistake). `'Comparing sources…'` then describes a
  third thing.
- `claim/[claimId].tsx:357` — `'You have not linked any sources to this claim.'` A fact, no
  invitation, and the "Connect evidence" button that would resolve it is ~140pt higher up the page
  at `:235`.
- `claim/[claimId].tsx:169` — `'Saved. This link is recorded as your judgement, not as a finding.'`
  Good sentence; but `evidence/[evidenceId].tsx:145` states the same thing as
  `'Your relationship was saved as a user assertion.'` — data-model vocabulary for the same event.
- `claim/[claimId].tsx:185` — `'Try again'` where `evidence/[evidenceId].tsx:174` uses
  `'Refresh'` and `index.tsx:319-324` uses `ErrorState`'s `onRetry`. Three names for retry.
- `claim/[claimId].tsx:317` — `'Try again once the sources have finished processing.'` as the
  *fallback* for a failed job, i.e. shown when the real reason is unknown. It guesses a cause.

### 4. Leaked internals

- `claim/[claimId].tsx:40-41` — `report.model === 'deterministic-rule-engine'` and
  `report.promptVersion === 'no-prompt-deterministic'`. **Not rendered** — the function converts
  them to `'Checked by rules'` / `'AI-assisted'`. This is the right pattern; noted only so it is
  clear the model name and prompt version are *read* here and must never be surfaced.
- `claim/[claimId].tsx:26` — `LINK_TYPES = ['RELEVANT_TO_CLAIM', 'SUPPORTS', 'CONTRADICTS']` is
  mapped through `RELATIONSHIP_LABELS` before display (`:505`), so the reader sees
  "Relevant to claim". Clean.
- `claim/[claimId].tsx:263` — `new Date(...).toLocaleString()` is the only raw machine formatting a
  reader sees on this screen (`"15/09/2026, 23:41:07"`), against `formatRelativeTime` used on the
  case screen (`index.tsx:596`) and the event screen (`event/[eventId].tsx:338`).
- No UUIDs, no `case_a1b2`, no bare confidence decimals, no "V1", no "PROOF", no
  "Firebase Connected", no demo data. Clean on the client's removal list.

### 5. Loading and error states

- **No skeleton anywhere.** While `loading` is true and the claim has not arrived, the screen is the
  not-found branch (`:173-189`) showing a `Notice` whose title is the single word `'Loading'`
  (`:177`) with a **`'Try again'` button under it** — a retry offered for an operation still in
  flight. When data lands, the entire page swaps from a 2-line notice to a 900pt column: maximum
  layout shift.
- `claim/[claimId].tsx:183` — `tone={error ? 'danger' : 'info'}`, so "Loading" is painted as an
  informational notice with an icon. A `Shimmer`/`SkeletonCard` (both exported from `@ui`) is what
  belongs here; `SkeletonCard` is already used by the event screen (`event/[eventId].tsx:199`).
- `claim/[claimId].tsx:213-216` — error and success notices are stacked at the top of the column,
  so a failure inside the "Links you recorded" section 600pt down the page reports itself off
  screen. `failure` is a single state shared by five different operations and three modals; the
  modals re-render it locally (`:455`, `:524`, `:543`), which means one failed delete shows the
  same red notice in up to four places at once.

### 6. Dead ends

- `claim/[claimId].tsx:326-334` — `disabled={busy || running || !ready}` on the assess button. The
  `!ready` case is explained (`:342-347`); the `running` case is explained by the label; **`busy`
  is not** — during any unrelated write (removing a link, saving a correction) the primary action
  greys out with no reason given.
- `claim/[claimId].tsx:420` — `Button label="Remove claim" variant="ghost"` opens the confirm; the
  confirm's own primary button is also `'Remove claim'` (`:544`) in the default (blue CTA) variant.
  A destructive action rendered in the primary-action colour, and the same label on the trigger and
  the confirmation, so the dialog does not read as a second step.
- `claim/[claimId].tsx:494-498` — `'This case has no sources yet. Add one first, then come back to
  link it.'` inside the link modal: the user is told to go somewhere else, with no button to get
  there, from inside a modal they must dismiss first. The screen has a working
  `router.push('/case/[caseId]/upload')` 160 lines up (`:338`).
- `claim/[claimId].tsx:424`, `:465`, `:535` — three raw RN `Modal`s. `@ui` exports `BottomSheet`
  (`src/ui/index.ts:40`) and the case screen uses a sheet for the same job
  (`index.tsx:535-543`, and its docblock argues the point at `index.tsx:34-38`). The result is that
  composing a claim is a sheet and editing the same claim is a full-screen slide-up.

---

## `app/case/[caseId]/evidence/[evidenceId].tsx` — source detail

The least finished file in the scope. 274 lines, most of them single-line JSX statements holding
several components each, and the styling is raw throughout.

### 1. Layout defects

- `evidence/[evidenceId].tsx:181` — the whole page is `<View style={{ gap: 22 }}>`. 22 is not on the
  scale at all (`SPACING.xl` 20, `xxl` 24), and as with the claim screen every block — status card,
  AI reading, extracted passages, corrections, links, two ghost buttons — is separated by the
  identical gap, so nothing groups.
- `evidence/[evidenceId].tsx:173` — `const panel = { gap: 14 };` is then applied to eight
  containers (`:184`, `:189`, `:205`, `:222`, `:233`, `:234`, `:243`, `:248`, `:270`). One
  off-scale number defines the internal rhythm of the entire screen.
- `evidence/[evidenceId].tsx:198-202` — three buttons in one wrapping `Row`: `View original`,
  `Reprocess original`, `Link to a claim or event`. At 360dp the third label alone is ~200pt, so
  this renders as 2–3 ragged rows of buttons directly under the status text.
- `evidence/[evidenceId].tsx:263-264` — the link modal renders **one full-width `Button` per claim
  labelled with `item.statement`** and one per event labelled `item.title`. A claim is up to 500
  characters (`claim/[claimId].tsx:445`); as a button label it wraps to a ten-line control.
- `evidence/[evidenceId].tsx:226-229` — every extracted passage is its own `Surface padding="lg"`.
  A 200-segment PDF becomes 40 stacked cards (`visibleSegments` starts at 40, `:93`), each with its
  own border and shadow. A document's text set as 40 separate cards is the "cheap" reading: this
  wants one bordered block with hairline-separated passages.
- `evidence/[evidenceId].tsx:254` — `style={{ flex: 1, width: '100%', minHeight: 300 }}` on the
  original-image `Image`, inside a `View` with `flexGrow: 1` and `padding: 24`. On a tall
  screenshot the image is letterboxed with large empty bands; there is no zoom or pan, so an
  evidence photo cannot be examined — which is the one thing this modal exists for.
- `evidence/[evidenceId].tsx:176` — no `contentStyle` / `maxWidth: LAYOUT.maxContentWidth`, so
  extracted source text sets to the full width on tablet and web.
- `evidence/[evidenceId].tsx:237-240` — the correction list renders label, value, and a
  `Correct <Field>` ghost button per field, up to 50 of them (`:237` `slice(0, 50)`), with
  `gap: 6`. Fifty three-element groups at 6pt spacing is a wall.

### 2. Hardcoded styling

Quoted:

- `evidence/[evidenceId].tsx:173` — `const panel = { gap: 14 };` → `SPACING.lg` (16) or `md` (12).
- `evidence/[evidenceId].tsx:181` — `<View style={{ gap: 22 }}>` → `SPACING.xxl`.
- `evidence/[evidenceId].tsx:184` — `style={{ ...panel, borderWidth: 2, borderColor: theme.colors.accent }}`
  → `BORDER_WIDTH.thick`. (The gold border itself is correct — this is a selection/structure edge.)
- `evidence/[evidenceId].tsx:210`, `:226` — `style={{ gap: 8 }}` → `SPACING.sm`.
- `evidence/[evidenceId].tsx:226` — `{ borderWidth: 1, borderColor: theme.colors.accent }` →
  `BORDER_WIDTH.hairline`.
- `evidence/[evidenceId].tsx:237` — `style={{ gap: 6 }}`. 6 is the value the token docblock
  specifically calls out as the old off-grid `sm` that was removed (`tokens.ts:551-556`).
- `evidence/[evidenceId].tsx:253`, `:261` — `paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24`
  → `theme.spacing.lg` / `xxl`. The identical modal on the claim and timeline screens uses the
  tokens (`claim/[claimId].tsx:431`, `timeline.tsx:269`), so the same layout is spelled two ways.
- `evidence/[evidenceId].tsx:254` — `minHeight: 300`; `:255` — `{ border: 0, width: '100%', flex: 1, minHeight: 420 }`;
  `:256` — `{ width: '100%', maxHeight: '75vh' }`; `:257` — `{ color: theme.colors.accent, padding: 16 }`.
- `evidence/[evidenceId].tsx:273` — `modal: { flexGrow: 1, padding: 24, gap: 20 }, overlay: { flex: 1, padding: 24, justifyContent: 'center' }`
  → `SPACING.xxl` / `xl`, and 24 is again 4pt wider than `LAYOUT.screenPadding` 20.
- `evidence/[evidenceId].tsx:187`, `:191`, `:227` — field separators written as a literal
  `' | '` (`` `Page ${page} | ` ``, `` ` | ${formatBytes(...)}` ``). Everywhere else the app
  separates metadata with `·` (`app/case/[caseId]/index.tsx:596`). A pipe reads as a table
  artefact.

### 3. Copy quality

- **"Evidence" vs "source".** This screen says evidence: `'Evidence'` (`:174`),
  `'Evidence unavailable'` (`:174`), `'Process evidence'` (`:200`), `'Remove evidence from case'`
  (`:249`), `'Keep evidence'` (`:270`), `'Remove this evidence?'` (`:270`),
  `'Evidence could not be removed'` (`:270`). The case screen calls the same records **Sources**
  (`index.tsx:373`, `'Add a source'`, `'Compare sources'`) and this screen's own modal says
  `'Connect this source'` (`:261`) and `'The source was processed on this device.'` (`:137`). Both
  nouns inside one file.
- `evidence/[evidenceId].tsx:197` — `'Return to Add evidence and choose the original file to retry
  the upload.'` names a screen called "Add evidence" that the user has never seen — the entry point
  is labelled `'Add a source'` (`index.tsx:302`). And it is an instruction with no button: the
  screen knows `caseId` and pushes to `/case/[caseId]/upload` nowhere in this branch.
- `evidence/[evidenceId].tsx:120` — `'The action could not be completed.'` The single fallback for
  open-original, reprocess, link, unlink, correct and delete.
- `evidence/[evidenceId].tsx:182` — `<Notice tone="danger" title="Action needs attention" …>`.
  Written from the system's side and content-free; the message below it may be a repository stack
  message.
- `evidence/[evidenceId].tsx:183` — every success is titled `'Saved'`, including
  `'The source was processed on this device.'` (`:137`), which is not a save.
- `evidence/[evidenceId].tsx:200` — `label={processing ? 'Processing...' : …}` uses three ASCII
  dots; the same state elsewhere is a real ellipsis (`'Comparing sources…'`,
  `claim/[claimId].tsx:323`; `'Assessing…'`, `graph.tsx:323`).
- `evidence/[evidenceId].tsx:247` — `label={showMetadata ? 'Hide file details' : 'File details'}`.
  The two halves of one toggle are not parallel ("Show file details").
- `evidence/[evidenceId].tsx:145` — `'Your relationship was saved as a user assertion. Run a case
  assessment to compare the sources.'` — "relationship" and "user assertion" are both from the data
  model. The claim screen says the same thing in English (`claim/[claimId].tsx:169`).
- `evidence/[evidenceId].tsx:174` — the retry control here is `'Refresh'`; the claim screen's is
  `'Try again'`; the case screen's is `ErrorState`'s retry. Three names.
- `evidence/[evidenceId].tsx:230` — `'Show more passages'` with no count, where `timeline.tsx:254`
  manages `` `Show ${n} more` ``.
- `evidence/[evidenceId].tsx:265` — `'Add a claim or event to the case first.'` A fact and an
  instruction, no control.

### 4. Leaked internals

- `evidence/[evidenceId].tsx:244` — `<Text variant="caption" colorToken="textSecondary">User
  assertion</Text>` printed under every link the reader themself created. This is `origin: 'USER'`
  from the schema, rendered as a badge. Also at `graph.tsx:103`.
- `evidence/[evidenceId].tsx:248` — `'Original file SHA-256'` followed by the full 64-character
  hash in `monoSmall`, plus `Added {new Date(evidence.createdAt).toLocaleString()}`. It is behind a
  "File details" toggle and it is captioned honestly ("Identifies the stored bytes; it does not
  prove the record is authentic"), so this is the mildest case — but it is a raw identifier on
  screen, and the raw `toLocaleString()` beside it is machine formatting where the rest of the app
  uses `formatRelativeTime`/`describeDate`.
- `evidence/[evidenceId].tsx:16` — `timestamp()` renders media offsets as `m:ss`; fine.
- Clean of: UUIDs, `case_a1b2` ids, model names, prompt versions, "V1", "PROOF",
  "Firebase Connected", "Cloud Firestore", "Evolution Tools", demo data. Confidence is banded
  through `CONFIDENCE_LABELS[confidenceBand(...)]` (`:214`), never a bare `0.82` — that line is the
  pattern the rest of the app should copy.
- `evidence/[evidenceId].tsx:190` — `PROCESSING_STATE_LABELS[evidence.state]` is mapped
  ("Needs review", `enums.ts:218-227`), so no enum leaks; but it is rendered as the *heading* of the
  status card, so the most prominent line on the card is a pipeline state ("Extracted") rather than
  anything about the document.

### 5. Loading and error states

- **No skeleton, and the not-found branch is a one-liner** (`:174`):
  `<Notice title={loading ? 'Loading evidence' : 'Evidence unavailable'} … /><Button label="Refresh" …/>`.
  A `Notice` titled "Loading evidence" with a "Refresh" button under it, on an `info` tone, is what
  the user sees for the whole first paint; then the entire page replaces it.
- `evidence/[evidenceId].tsx:174` — the two `Notice`/`Button` children are not wrapped in any
  container, so they sit flush against each other with no gap (no `View style={{ gap }}` as the
  claim screen manages at `claim/[claimId].tsx:176`).
- `evidence/[evidenceId].tsx:196` — `'The original is being processed. You can leave this screen and
  return later.'` is a plain sentence where a progress affordance belongs; there is no
  indeterminate bar and nothing polls visibly, so a user watching a 30-second extraction sees a
  static page.
- One `failure` state is shared by every operation and is rendered in up to four places at once
  (`:182`, `:258`, `:268`, `:270`), so a failed *delete* also paints an error inside the
  open-original modal.

### 6. Dead ends

- `evidence/[evidenceId].tsx:200` — `disabled={busy || processing || (!evidence.storagePath && evidence.kind !== 'NOTE')}`.
  The third clause — no stored original — has **no explanation anywhere on screen**; the button is
  simply dead for a record whose upload never completed, and the `Notice` that would explain it
  (`:197`) only renders when `state === 'UPLOADING'`.
- `evidence/[evidenceId].tsx:249` — `disabled={processing || busy}` on "Remove evidence from case",
  unexplained.
- `evidence/[evidenceId].tsx:216-217` — `Accept` / `Dismiss` on an AI reading write only a review
  status; the accompanying text says so (`:207`, `:167-168`), but the buttons give **no feedback at
  all** on success — no toast, no notice (`reviewReading` sets no `notice`), and the chip that
  appears (`:211`) is easy to miss 40pt away. `useToast` is exported from `@ui`
  (`src/ui/index.ts:39`) and unused here.
- `evidence/[evidenceId].tsx:245` — "Remove this link" deletes immediately with no confirmation,
  while removing the *evidence* gets a full confirm dialog (`:270`).
- `evidence/[evidenceId].tsx:257` — on native, `'Open or share original file'` throws
  `new Error('File sharing is unavailable on this device.')` into the shared `failure` banner at the
  top of the *modal*; on web the same action is a bare `<a>` styled with
  `{ color: theme.colors.accent, padding: 16 }` — an unbordered gold text link, the only control in
  the app that looks like that.

---

## `app/case/[caseId]/timeline.tsx`

### 1. Layout defects

- **It is not a timeline.** `timeline.tsx:220-250` renders each entry as a free-standing
  `Surface padding="lg" radius="lg"`, stacked with a gap. There is no rail, no spine, no date
  gutter, nothing that orders the eye — the only cue that this is chronological is that the cards
  happen to be sorted. The docblock (`:24-46`) argues carefully about two sequences being kept
  apart, and then draws both as the same generic card. This is the single biggest "unfinished"
  signal in the case workspace, because the screen's whole reason to exist is the shape of time.
- `timeline.tsx:132` — one flat `gap: theme.spacing.xl` column again: the intro paragraph, the
  action row, the stale notice, a heading, cards, filters, more cards — all 20pt apart.
- `timeline.tsx:201-214` — three filter `Button`s (`All records` / `Events` / `Evidence`) wrap at
  360dp, and the *selected* one is `variant="primary"`, i.e. the blue `colors.cta` reserved for the
  screen's primary action (`tokens.ts:452`). A selected filter is selection state, which is
  `colors.accentSurface` ("Tinted accent surface, for selected rows and active nav items",
  `tokens.ts:315-316`) or a `Chip` with `tones.accent`. Three primary-blue buttons plus the real
  primary button `'Record an event'` (`:141`) puts four CTA-coloured controls in one screenful.
- `timeline.tsx:237-248` — a ghost `View event` / `View source` button inside every card, bottom
  left, instead of making the card pressable with a `Disclosure` chevron as the case screen's rows
  do (`index.tsx:646`). Every card therefore carries a stray control and 30 cards carry 30.
- `timeline.tsx:296-313` — one full-width `Button` per claim, labelled with the claim statement, in
  the "Related claim (optional)" picker. Same defect as the claim and evidence screens.
- `timeline.tsx:189-196` — the "no events read yet" block is a `Surface` with a `subheading` +
  paragraph, while the sibling empty case at `:216-218` is a bare `Text`. Two empty states, two
  shapes, one screen.
- No `maxWidth: LAYOUT.maxContentWidth` on the content.

### 2. Hardcoded styling

- `timeline.tsx:330` — `sheet: { flexGrow: 1, padding: 24, gap: 20 }` → `SPACING.xxl` / `xl`, and
  24 ≠ `LAYOUT.screenPadding` 20.
- `timeline.tsx:331` — `wrap: { flexWrap: 'wrap' }` where `Row`'s own `wrap` prop exists
  (`src/ui/primitives/Layout.tsx:498-499`) and is used on the graph screen (`graph.tsx:308`).
- Otherwise this screen is token-clean, and it is the only one in the scope besides the case screen
  that is.

### 3. Copy quality

- `timeline.tsx:54` — filter labelled `'Evidence'`, whose own cards then say
  `'Read from a source'` (`:227`), inside a screen whose second button says `'Add evidence'`
  (`:143`) and whose sibling screen says `'Sources'`. The noun changes three times in one viewport.
- `timeline.tsx:141` — `'Record an event'` for the action the case screen calls `'Add event'`
  (`index.tsx:441`) and the composer sheet calls something else again.
- `timeline.tsx:217` — `` `No ${activeFilter.empty} have been recorded in this case.` `` produces
  "No dated records or events have been recorded in this case." — a fact, no invitation, no action,
  set in plain secondary body text with no icon or frame, immediately under the filters.
- `timeline.tsx:181` — `'Time not established'`; `event/[eventId].tsx:322` — `'No date recorded'`;
  `index.tsx:618` — `'no date given'`. Three phrasings of undated, all visible within two taps.
- `timeline.tsx:231` — `Chip label="Date needs review"`; `index.tsx:641` —
  `'could be read either way'`; `event/[eventId].tsx:272` — `'Reads two ways'`. Three phrasings of
  the same ambiguity flag, and the same underlying `date.ambiguous` boolean.
- `timeline.tsx:190-194` — `'Once your sources have been processed, run an assessment.'` The screen
  provides no way to run one; the control is on the case screen, the claim screen and the graph
  screen, but not here.
- `timeline.tsx:281` — `'When? (optional)'` — the only field label in the app that puts
  "(optional)" in the label rather than the hint, and `:298` `'Related claim (optional)'` repeats it.

### 4. Leaked internals

None. `FILTERS` (`:51-55`) carries display labels; `entry.displayDate` and
`entry.kind === 'event' ? 'Recorded event' : 'Read from a source'` (`:227`) are both prose; the
`report!.id` at `:179` is a React key only. Clean.

### 5. Loading and error states

- **No skeleton, and the empty state renders during loading.** `timeline.tsx:216-218` is guarded
  only by `!entries.length`. On first paint `timeline` is `null` (`:69-72`, gated on `caseRecord`),
  so a user opening a full case is told *"No dated records or events have been recorded in this
  case."* before their data arrives, and it then silently becomes 30 cards. The screen already
  knows how to do this properly 60 lines up — `:155-161` has an explicit
  `loading ? 'Loading this case…' : …` branch for the button explanation — so the omission is
  inconsistent even with itself.
- `timeline.tsx:188-196` — same problem for the cited-events branch: during load it asserts
  "No events have been read from the evidence yet".
- Layout shift is therefore maximal: two paragraphs become two lists.
- `timeline.tsx:133` — the load error is a `Notice` above the content, and the stale-report warning
  is a second `Notice` below it; both can show at once with the intro paragraph between them.

### 6. Dead ends

- `timeline.tsx:141` — `disabled={!caseRecord}` **is** explained, in place, with a loading-aware
  message (`:149-161`). This is the pattern the rest of the app should copy; call it out as the
  positive example.
- `timeline.tsx:262` — raw RN `Modal` again rather than `BottomSheet` from `@ui`.
- The screen has no route to `compare`, `graph` or the assessment it keeps recommending; the only
  exits are back and the two record detail screens.

---

## `app/case/[caseId]/graph.tsx` — "Connections"

### 1. Layout defects

- **There is no graph.** The file is named `graph.tsx`, builds `buildGraph(...)` with nodes and
  edges (`:178-184`), and then renders them as a wrapping grid of cards (`:511-573`) and a list of
  `from → type → to` rows (`:576-640`). Nothing is drawn. The case screen sells this destination as
  *"Which documents, claims and events the analysis linked, and on what grounds"*
  (`index.tsx:147`) and the `Screen` primitive documents a "graph canvas" that pans and zooms
  (`Screen.tsx:326-328`) which nothing here uses. For a product whose differentiator is showing how
  records relate, the relationship view being two lists is the clearest "nothing feels finished"
  finding in the scope.
- `graph.tsx:296` + `:310` + `:578` — the word "Connections" is the screen title (`display` 36), the
  compact header title, the panel `title` 28 (`:310`), and a section `heading` 22 (`:578`). Four
  times, three type ranks, one screenful.
- `graph.tsx:658` — `paddingBottom: 60` on the content, on top of `ScreenScroll`'s own
  `insets.bottom + SPACING.giant` (`Screen.tsx:402`). ~108pt of dead canvas below the last card.
- `graph.tsx:350-372` — five filter `Button`s with counts in the labels
  (`All (12)`, `Claims (3)`, `Sources (5)`, `Conflicts (0)`, `Links (9)`). At 360dp that is three
  wrapped rows, and the selected one is again `variant="primary"` — the CTA blue used for filter
  state, 40pt below a real secondary CTA (`:322`).
- `graph.tsx:612-635` — three controls per connection card: `Inspect details`, `Focus source`,
  `Focus target`. At 360dp they wrap to two rows, so every connection card ends in a 2-row button
  block taller than its content.
- `graph.tsx:682-688` — `card: { minWidth: 260, flex: 1, padding: 14, borderRadius: 12 }` in a
  `flexWrap` grid with `gap: SPACING.lg`. Usable width at 360dp is 320, so two cards never fit and
  the "grid" is a single column on every phone — the `minWidth` and the wrap only take effect on
  tablet.
- `graph.tsx:380-393` — a hand-rolled empty state (`Surface` + 40pt `Icon` + `title` + centred text)
  instead of the `EmptyState` primitive the case screen uses (`index.tsx:329-334`), so it has a
  different icon size, a different title rank and a different max width (`:665` `maxWidth: 440`).
- `graph.tsx:598-606` — `label → Supports → label` inside a wrapping `Row`. The arrows are drawn on
  both sides of the relationship name, and at narrow widths the three `Text` nodes wrap between the
  arrows and their labels.

### 2. Hardcoded styling

The file's own docblock concedes it (`graph.tsx:646-651`):

```
 * Values off the spacing scale (14, 10) are kept as-is rather than snapped —
 * this is a refactor of structure, not a re-design of rhythm.
```

Instances: `:658` `paddingBottom: 60`; `:664` `empty: { gap: 14 }`; `:665` `maxWidth: 440`;
`:666` `inspectorNode: { gap: 14 }`; `:670-672` `edgeRow: { padding: 10, borderRadius: 8,
borderLeftWidth: 4 }`; `:683-686` `card: { minWidth: 260, padding: 14, borderRadius: 12 }`;
`:690` `connectionsSection: { marginTop: 10 }`; `:691` `connectionCard: { borderLeftWidth: 4 }`;
`:382` `Icon size={40}` (→ `LAYOUT.tileSize`); `:404` `size={24}`; `:545` `size={18}`.
`borderRadius: 8` and `12` are between `RADIUS.xs` 6, `sm` 10 and `md` 14; `padding: 10`/`14` and
`gap: 14` are off the 4pt scale that `tokens.ts:551-578` was re-cut to enforce.

### 3. Copy quality

- `graph.tsx:303` — `title="Graph could not load"`. "Graph" is the internal name; the user is on a
  screen called "Connections".
- `graph.tsx:304` — `title="Analysis issue"`, `tone="warn"` — a content-free, system-side title, and
  `warn` for what is a failure (`danger`).
- `graph.tsx:288` — `'Analysis could not be generated.'` Passive and vague.
- `graph.tsx:621`, `:629` — `'Focus source'` / `'Focus target'`. Graph vocabulary; "source" here
  means *edge origin*, which collides head-on with "source" meaning *a document* everywhere else in
  the product.
- `graph.tsx:614` — `'Inspect details'`, `:475` `'Open full record'`, against `'View source'` /
  `'View event'` on the timeline (`timeline.tsx:238`) and `'View source'` on the claim screen
  (`claim/[claimId].tsx:382`).
- `graph.tsx:323` — `'Run case assessment'` / `'Assessing…'`, against `'Assess this case'` /
  `'Assess again'` / `'Comparing sources…'` (`claim/[claimId].tsx:323`). One operation, five labels.
- `graph.tsx:502` — `'Origin: {…}'`. A field name as a visible prefix.
- `graph.tsx:461-464` — `'Nothing is connected to this record yet. A case assessment can identify
  links between the sources.'` The button that does it is on the same screen, 400pt up; the text
  does not link to it.

### 4. Leaked internals — the worst offender in the scope

- **Raw ids rendered when a node lookup misses**, five sites:
  `graph.tsx:455` `{otherNode?.label || otherNodeId}`; `:492` `Chip label={nodesMap.get(selectedEdge.from)?.label || selectedEdge.from}`;
  `:498` the same for `.to`; `:600` `{fromNode?.label || edge.from}`; `:605` `{toNode?.label || edge.to}`.
  Every one of those fallbacks puts a record id in front of the user — in a `Chip`, at
  `label` weight — and an edge to a soft-deleted or out-of-case record hits it in normal use.
- **Raw SCREAMING_SNAKE enum rendered when a label lookup misses**, four sites:
  `graph.tsx:449` `{RELATIONSHIP_LABELS[edge.type] || edge.type}`; `:443` the same inside an
  `accessibilityLabel`; `:496`; `:603`. The fallback prints `ATTACHED_TO_EVENT`.
- `graph.tsx:525` — `accessibilityLabel={`Select ${node.kind}: ${node.label}`}` announces the raw
  internal kind (`evidence`, `entity`) to a screen-reader user, where `nodeKindLabel(node)` is
  defined two lines away (`:145`).
- `graph.tsx:102-106` — `ORIGIN_LABEL.USER = 'User assertion'`, rendered at `:452`, `:502` and as a
  `Chip` at `:607`. Data-model vocabulary shown to the person who made the assertion.
- Clean of UUID-shaped case refs, model names, prompt versions, "V1", "PROOF", "Firebase
  Connected", "Evolution Tools" and demo data. The docblock notes the marketing copy ("Dispute
  Evidence Topology", "AI Grounded Cross-Verification") was already removed (`:14-19`) — confirmed
  gone.

### 5. Wrong token for the job (the calibration check)

- `graph.tsx:253-259` — `nodeColor()` returns `theme.colors.accent` (gold) for a **claim** node,
  alongside `tone('danger').fg` for a conflict, `tone('info').fg` for a source and `tone('ok').fg`
  for a person. That puts gold into a set of *semantic category* colours, which is precisely what
  `tokens.ts:471-487` forbids: gold is 2.6° from `warn`, so in the card grid (`:546`) a claim's gold
  overline sits beside amber and red cards and reads as a caution. The correct token is
  `theme.tone('accent').fg` (blue). Same misuse at `:250` — `edgeColor()` falls back to
  `colors.accent` for every relationship type that is not `CONTRADICTS`/`SUPPORTS`, and that colour
  is then used as text (`:448`, `:495`, `:602`) and as a 4pt left rule (`:445`, `:592`), i.e. as
  meaning.
  By contrast `:535` and `:593` use `colors.accent` for the *selected* card border, which is exactly
  right — the same file gets it right and wrong 40 lines apart.
- `graph.tsx:340-345` — the count row paints tallies in the epistemic tone scale:
  `${claimsCount} claims` in `tones.accent`, `${evidenceCount} sources` in `tones.info`,
  `${entityCount} people` in `tones.ok`, `${conflictCount} conflicts` in `tones.danger`. `ok` is
  documented as "the only tone that reads as settled" (`tokens.ts:44-45`) and `info` as
  "for information" — spending them on head-counts is what makes the tone scale stop meaning
  anything. Only `neutral` belongs on a count.
- `graph.tsx:382` — the empty-state icon is tinted `theme.colors.accent`, i.e. 40pt of brand gold as
  decoration in the middle of the canvas. `accent` is structure, not illustration.

### 6. Loading and error states

- No skeleton, and worse: during first load the summary panel renders real-looking zeros —
  `0 records`, `0 claims`, `0 sources`, `0 links` (`:340-343`) — because `graph` is computed from an
  empty workspace. A case with 40 records displays as a case with none, then jumps. The empty-state
  block is correctly gated on `!loading` (`:380`), which shows the author knew; the chips are not.
- `graph.tsx:299-300` — pull-to-refresh only. Nothing indicates the assessment's progress beyond
  the button's own spinner.

### 7. Dead ends

- `graph.tsx:390` — `Button label="Go to case"` calls `router.push({ pathname: '/case/[caseId]' })`
  from a screen that was itself pushed *from* the case screen. It pushes a second copy of the case
  onto the stack, so back then goes Case → Connections → Case. `router.back()` is what is meant.
- `graph.tsx:269-278` — `openRecord` returns silently for conflict, person and report-derived
  nodes, and `:474` correctly hides the button for them — but that makes a **conflict** card
  terminal: the most important node type on the screen can be selected, shows a reason, and offers
  no route to the finding, the claim or the sources it came from.
- `graph.tsx:331-335` — `{!user && <Text>Sign in to run an assessment.</Text>}` next to the disabled
  button, with the reasoning in a comment above it. Correct, and the model for every other disabled
  control in this scope.

---

## `app/case/[caseId]/event/[eventId].tsx`

The content model is right — source reading and normalized date side by side, never collapsed — and
three of the app's best comments live here (`:57-60`, `:174-177`, `:228-230`). The chrome is the
problem: this screen is built by hand and looks like a different app.

### 1. Layout defects

- `event/[eventId].tsx:178-239` — the screen does not use `ScreenScroll`/`Masthead` at all. It
  hand-rolls `View` + `ScrollView` + a header row, so it gets none of the shared behaviour: no
  large-title treatment, no `contentStyle` max width, no `onRefresh`, and no back fallback (`:225`
  is a bare `router.back()`, where `Screen.tsx:137` falls back to `router.replace('/cases')` when
  there is no history — this screen is reachable from a notification `push`, so a cold deep link
  leaves the arrow inert).
- `event/[eventId].tsx:482` — `paddingHorizontal: 16` in the header and `:487` `padding: 16` in the
  body, against `LAYOUT.screenPadding = 20` (`tokens.ts:621-624`). Navigate from the case screen to
  an event and every edge moves in by 4pt. It is the single most visible inconsistency in the case
  workspace because it happens on a push transition.
- `event/[eventId].tsx:242` — `paddingBottom: insets.bottom + 40` where `ScreenScroll` uses
  `SPACING.giant`; a fourth different bottom inset in the scope.
- `event/[eventId].tsx:490-493` — `card: { padding: 18, borderRadius: 16 }`. Neither number is a
  token: `SPACING` has 16 and 20 but not 18 (`tokens.ts:580-593`), and `RADIUS` has `md` 14 and `lg`
  18 but not 16 (`:599-608`). Every card on this screen is therefore 2pt off the app's padding and
  2pt off its corner radius — small enough that nobody can name it, large enough that the screen
  reads as not-quite-right next to the case screen.
- `event/[eventId].tsx:494-500` — `iconPill: { width: 38, height: 38, borderRadius: 12 }`. There is
  a token for this exact object: `LAYOUT.tileSize` is 40 (`tokens.ts:644-647`) and `IconTile` is the
  primitive — used on the audit screen (`audit.tsx:488`, `:657`) and by `Masthead`. 38 is 40 minus
  two, so the pills on this screen are visibly smaller than the tiles on every other.
- `event/[eventId].tsx:265-273` — the normalized date `Row` is `title` + a precision `Chip` + a
  "Reads two ways" `Chip`, with `wrap`. Good that it wraps; but `Text variant="title"` (an
  unclamped, ~24pt string) plus two chips means a long normalized date at 360dp pushes both chips to
  their own line, and the card's own heading `When this happened` sits beside a 38pt pill, so the
  card top is 3 lines tall before any date appears.
- `event/[eventId].tsx:412` — `<Chip … style={{ marginTop: 10 }} />` above each linked evidence row;
  10 is off the 4pt scale.

### 2. Hardcoded styling

```
header: { paddingHorizontal: 16, paddingBottom: 12, … },
scrollContent: { padding: 16, gap: 16 },
card: { padding: 18, borderRadius: 16 },
iconPill: { width: 38, height: 38, borderRadius: 12, … },
quoteBox: { padding: 14, borderRadius: 12, borderWidth: 1 },
```

(`event/[eventId].tsx:473-506`.) Plus inline: `paddingTop: insets.top + 8` (`:181`, `:220`),
`marginBottom: 12` (`:247`, `:331`, `:351`, `:437`), `marginBottom: 4` (`:262`, `:277`, `:297`,
`:395`), `gap: 12` (`:260`), `marginTop: 8` (`:304`, `:430`), `marginBottom: 12` on the notice
(`:366`, `:380`), and `style={{ lineHeight: 22 }}` on the description body (`:342`) — which
overrides the `body` line height the type scale sets to 23.5 for a documented reason
(`tokens.ts:705-738`), tightening the one long-form paragraph on the screen.
`quoteBox.borderWidth: 1` should be `BORDER_WIDTH.hairline`; the header two lines up correctly uses
`StyleSheet.hairlineWidth` (`:484`), so the two rules on the same screen are different weights.

### 3. Copy quality

- `event/[eventId].tsx:185` — `'Loading Event...'` and `'Event Not Found'`: Title Case, and three
  ASCII dots instead of an ellipsis. Directly beside them the same expression produces
  `'Event could not be loaded'` in sentence case, so the file disagrees with itself inside one
  ternary.
- `event/[eventId].tsx:290` — `'Reading Could Go Either Way'` / `'Limited Precision'`; `:400`
  `'Linked Evidence ({n})'`; `:439` `'Claims In This Story ({n})'`; `:203` `'Missing record'`;
  `:504` `'Recorded Entry'`. Title Case again, on a screen whose sibling states the rule out loud:
  "Sentence case, which is what every other screen title in the app uses" (`audit.tsx:334-336`).
- `event/[eventId].tsx:263`, `:278`, `:298` — `NORMALIZED`, `AS WRITTEN IN THE SOURCE`,
  `PROVENANCE`: hand-uppercased string literals. `Text variant="overline"` takes an `uppercase` prop
  (used correctly at `audit.tsx:549`), so these three are shouting even in a locale or accessibility
  mode where the overline variant would not.
- `event/[eventId].tsx:263` — `NORMALIZED` is a system word for "the date as we read it"; `:298`
  `PROVENANCE` is a domain-expert word. The card's own subtitle already says it better: "The source
  reading and the normalized date, kept separate" (`:254`). "Where this came from" would do for the
  third.
- `event/[eventId].tsx:439` — `'Claims In This Story'`. "Story" appears nowhere else in the product;
  the case screen calls these "Claims" and the graph calls the same edge set "Connections".
- `event/[eventId].tsx:204` — `'This event may have been removed, or it belongs to another case.'`
  Two possibilities, neither actionable, and no way to get to the other case.

### 4. Leaked internals

- Clean at the value level: `RELATIONSHIP_LABELS` (`:97`), `DATE_PRECISION_LABELS` (`:269`) and
  `describeProvenance` (`:301`) all convert. No ids, no model names, no decimals.
- `event/[eventId].tsx:263`/`:298` are the residue: `NORMALIZED` and `PROVENANCE` are internal
  vocabulary rendered as UI labels even though no enum value leaked.

### 5. Loading and error states

- Correct and better than most: `error` is separated from not-found with a comment explaining why
  (`:57-60`), `SkeletonCard lines={4}` while loading (`:199`), `ErrorState` with `detail` and
  `onRetry` (`:192-197`).
- The loading header says `'Loading Event...'` while the loaded header shows an overline plus a
  heading, so the header changes height when data arrives and the skeleton below jumps.
- No `RefreshControl` anywhere (hand-rolled `ScrollView`, `:241`), so this is one of two case screens
  with no pull-to-refresh.

### 6. Dead ends

- `event/[eventId].tsx` has **no edit and no delete**. An event is the one record in the app the user
  authored by hand (per this file's own opening docblock), and its detail screen offers no way to
  correct the title, the date or the description. Every other detail screen in the scope has at
  least one write action.
- `event/[eventId].tsx:426-431` — `'No evidence attached'` … `'Attach evidence from the evidence
  screen to link it here.'` The instruction names another screen and provides no route to it; the
  `Notice` has no action slot filled and `EmptyState`'s `action` is not used.
- `event/[eventId].tsx:461-465` — `'This event is not part of any claim yet.'` A bare centered
  sentence in a `Surface`, with no action and not even an `EmptyState`; the third distinct empty-state
  treatment on one screen (`Notice` at `:320`, `Notice` at `:426`, bare `Text` here).
- `event/[eventId].tsx:358` — `<Chip label={String(findings.length)} tone="danger" size="sm" />`. A
  count painted in the epistemic danger tone. `tones.danger` means *contradicted* in this product;
  "3" is not a contradiction, it is a quantity. The same misuse appears at `graph.tsx:340-345`.

---

## `app/case/[caseId]/compare.tsx`

Copy, empty states and loading states are the best in the scope. The defects are all in the raw
geometry.

### 1. Layout defects

- `compare.tsx:384` — `documentRow: { paddingVertical: 7 }` on a `Pressable` row
  (`:254-277`). 7 is not on any scale, and 7 + 7 + a `bodySmall` line box (21) ≈ **35pt of touch
  target** against the documented `HIT_TARGET = 44` (`tokens.ts:617`). These rows are the screen's
  only navigation.
- `compare.tsx:394` — `cellOrdinal: { width: 12 }` holding a `monoSmall` (12pt) digit. The tenth
  document's "10" does not fit in 12pt, and at a large system font every ordinal clips or wraps. The
  ordinal chips it refers to are 22pt wide (`:386`), so the two columns do not even align.
- `compare.tsx:271-275` — the document row is `title (numberOfLines=1, flex)` + a kind `Chip` + a
  chevron in one non-wrapping `Row`. At 360dp a filename title is truncated to roughly 12 characters
  before the chip.
- `compare.tsx:333-366` — a value cell is `ordinal (12) + gap 12 + mono value (flex) + gap 12 +
  method Chip`. With a long extraction-method label the monospace amount — the thing the screen
  exists to show — is the element that gives up width, and it is capped at `numberOfLines={2}`.
- `compare.tsx:142-143` — `overline={targetCase?.title ?? 'Case'}` puts the **user's case name into
  the overline slot, which `Masthead` renders `uppercase`** (`Screen.tsx:227`). The event screen
  fixed exactly this mistake and left a comment about it — "This was `.toUpperCase()`d, which
  shouted their own case name back at them" (`event/[eventId].tsx:228-230`) — and this screen still
  does it. It also inverts the hierarchy used on the case screen, where the case name is the
  `display` title and the *category* is the overline (`index.tsx:290-292`).
- `compare.tsx:143` — the `subtitle` is two sentences, ~180 characters, where `MastheadProps`
  documents it as "One line under the title" (`Screen.tsx:213`). At 360dp it is four lines of
  `body`, so the masthead alone is ~180pt before any comparison is visible.
- `compare.tsx:222` — `/** One comparison: … */function ComparisonCard({` — the docblock and the
  declaration are on one line. Not a UI defect; a marker of how this file was last edited.

### 2. Hardcoded styling

```
card: { padding: 16, borderRadius: 16 },
groundsRow: { marginBottom: 10, paddingHorizontal: 2 },
documentRow: { paddingVertical: 7 },
ordinal: { width: 22, height: 22, borderRadius: 11, … },
cells: { marginTop: 10, gap: 8 },
cellOrdinal: { width: 12 },
note: { marginTop: 10 },
incomplete: { marginTop: 16 },
footnote: { marginTop: 32 },
```

(`compare.tsx:382-397`.) `padding: 16` and `borderRadius: 16` should be `Surface`'s own
`padding="lg" radius="lg"` props — which this same file's sibling screens do use
(`timeline.tsx:221`) — and 16 is not a radius token at all (`RADIUS.md` 14, `lg` 18). `10`, `7`, `2`,
`22`, `11`, `12` are all off the 4pt scale; `marginTop: 32` and `marginTop: 16` have exact tokens
(`SPACING.xxxl`, `SPACING.lg`). Icon sizes `15` (`:323`), `16` (`:275`, `:208`) are raw.

### 3. Copy quality

- `compare.tsx:187` — `label: 'Add evidence'` on the empty state's action, on a screen that calls
  the same records "documents" throughout its own copy (`:143`, `:168`, `:178`, `:181`) and whose
  entry point calls them "sources" (`index.tsx:373`). Three nouns for one thing across one
  navigation hop.
- `compare.tsx:141` — screen title `'Compare'`; the row that leads here says `'Compare sources'`
  (`index.tsx:133`) and the section action says `'Compare'` (`index.tsx:379`).
- `compare.tsx:182` — `'…Correcting a misread date or amount on the evidence screen often reveals
  the link.'` Tells the user to go to another screen, in the one branch of the empty state that
  offers **no action** (`:184-191` attaches the action only when `evidenceCount < 2`).
- Everything else is genuinely well written — `:169` ("This does not mean your documents
  disagree"), `:299`, `:210-213` and `:345-347` are the standard the rest of the app should be held
  to.

### 4. Leaked internals

None. Every enum passes through a label map (`EVIDENCE_KIND_LABELS` `:274`, `CONFIDENCE_LABELS`
`:243`, `EXTRACTION_METHOD_LABELS` `:361`), confidence is banded not decimal, and ordinals stand in
for ids so no id is ever printed. This is the file to copy.

### 5. Loading and error states

- Correct: `SkeletonList count={2}` (`:174`), `ErrorState` with `detail` and `onRetry` (`:167-172`),
  and an empty state that distinguishes *"nothing to compare with"* from *"nothing links these
  yet"* (`:178-183`).
- One layout shift: `meta` renders only `tables.length > 0` (`:147-148`), so three chips appear in
  the masthead the moment data lands and push the entire page down ~30pt after the skeleton has
  already drawn in the old position.

### 6. Dead ends

- `compare.tsx:289-302` — the "values could not be compared" notice explains the gap well but
  offers no route to the document that holds the lone value.
- No route to run an assessment, and the screen depends on one having been run.

---

## `app/case/[caseId]/letter.tsx` — escalation letter

The strongest screen in the product: the copy, the tone choices for the limitation window
(`:489-497`, `:551-559`), and the source byline under every fact are all right. The defects are
loading state and a handful of literals.

### 1. Layout defects

- `letter.tsx:251-266` — the masthead `meta` carries up to four icon chips
  (`"412 days unanswered"`, `"Window open to 12 February 2027"`, `"6 to write"`, `"3 to check"`).
  At 360dp that wraps to three rows; with the `display` title, the subtitle and the masthead's
  `paddingBottom: SPACING.xxxl` (`Screen.tsx:723`) the user scrolls ~240pt before reaching the
  letter on the screen whose entire purpose is the letter.
- `letter.tsx:267-280` — this is the only screen in the scope that uses `ScreenScroll`'s `footer`,
  and `Screen.tsx:402` reserves a **hard-coded `72`** of bottom padding for it while
  `ScreenFooter` actually renders `insets.bottom + SPACING.lg + SPACING.lg +` a `Button` (≈ 44), i.e.
  76pt before insets. The last line of "Before you send it" therefore sits under the share bar. This
  is precisely the drift `tokens.ts:632-641` documents for the tab bar and fixes with a token; the
  footer has no equivalent.
- `letter.tsx:313-314` — `<Section first …>` on the questions section, which is not first (three
  notices precede it, `:286-310`). When `questions.length === 0` the next section renders *without*
  `first`, so the gap above the letter changes by 40pt depending on whether the draft has blanks.
- `letter.tsx:479` — `minHeight: question.slot === 'relief' ? 110 : 80`. Raw box heights for the two
  fields that matter most.
- `letter.tsx:695` — `byline: { paddingVertical: 4, paddingRight: 8, alignSelf: 'flex-start' }` with
  a comment claiming it fixes the touch target. It yields ~23pt against `HIT_TARGET` 44
  (`tokens.ts:617`), and this byline is the screen's only way to check a fact against its source.

### 2. Hardcoded styling

- `letter.tsx:691` — `unanswered: { fontStyle: 'italic' }`. **There is no italic face loaded.**
  `FONT_FAMILY` (`tokens.ts:72-81`) registers eight upright faces and no italics, and the tokens
  file states the rule for exactly this situation — "Weight lives in `fontFamily` because RN
  synthesises fake bold for custom fonts" (`tokens.ts:661`), the same argument the graph screen
  repeats for `fontWeight` (`graph.tsx:493-494`). So every unanswered blank in the letter is drawn
  in a synthetic oblique of Plus Jakarta Sans, which is the single most recognisable "cheap" text
  artefact there is — on the one screen the user prints and sends.
- `letter.tsx:341-343` — the letter's own section headings are `variant="monoOverline"`. Monospace is
  reserved, as a product decision, for machine-extracted values: "A reader can therefore see,
  without any legend or badge, which parts of a case came out of a document and which a person
  typed" (`tokens.ts:60-64`). "SUBJECT" / "FACTS" are template prose, so setting them in the machine
  face tells the reader the opposite of the truth.
- `letter.tsx:408` — `Icon size={15}`; `:610` — `size={12}`. Raw.
- `letter.tsx:479`, `:695` — see above.
- `letter.tsx:677-684` — the printed page is styled with raw CSS: `@page { margin: 22mm 18mm }`,
  `font-family: Georgia, "Times New Roman", serif`, `font-size: 11.5pt`, `color: #111`. Reasonable
  for print and outside the token system by necessity, but it means the artefact the user actually
  sends shares nothing with the product's typography, and nothing pins those values.

### 3. Copy quality

- `letter.tsx:282` — `<Notice title="Something went wrong" message={failure} tone="danger" />`. The
  only content-free, system-side string on the screen, and it is the one the user sees when the
  share or the PDF fails. The same screen writes `'This case could not be read'` 60 lines earlier
  (`:221`).
- `letter.tsx:234` — `label: 'Add a document'`. A fourth name for one action, after
  `'Add a source'` (`index.tsx:302`), `'Add evidence'` (`claim/[claimId].tsx:338`,
  `timeline.tsx:143`, `compare.tsx:187`) and `'Add the first claim'`.
- `letter.tsx:478` — `placeholder={editable ? 'Not yet written' : 'Loading…'}`. A field placeholder
  used as a loading indicator; the field is simultaneously `editable={false}`, so the user's first
  impression of the questions block is six greyed-out boxes.
- `letter.tsx:441` — `disabled={readiness.blanks === questions.length}` on "Clear what I wrote",
  with no explanation. It is correct behaviour (nothing to clear) and silent.
- Everything else is exemplary, in particular `:292-295`, `:391-393`, `:401`, `:424` and the
  limitation wording at `:543-572`, which names the provision instead of asserting a rule.

### 4. Leaked internals

None. `question.slot` and `annexure.serial` are keys and ordinals; the file hash is called
"a fingerprint" in prose (`:391`) rather than "SHA-256"; no ids, no model names, no prompt versions,
no bare decimals.

### 5. Loading and error states — the worst gap on this screen

- **There is no loading state at all.** The guard at `:213` is `if (!loading && !draft)`, so while
  `loading` is true and `draft` is still null, control falls through to the main return where the
  body is `{draft ? … : null}` (`:284`, `:446`), `meta` is `null` (`:252`) and `footer` is `null`
  (`:268`). The user gets a bare masthead — a title, a subtitle, and an empty canvas — for the whole
  load, then the entire letter, four chips and a pinned footer appear at once.
- `letter.tsx:246-250` — neither `ScreenScroll` on this screen passes `onRefresh`/`refreshing`, so
  the letter is the one case screen with no pull-to-refresh and no refresh indicator.
- `letter.tsx:92`, `:325` — `loaded` from `useDraftAnswers` disables every field until the saved
  answers arrive, signalled only by the placeholder text.

### 6. Dead ends

- `letter.tsx:441` — the disabled "Clear what I wrote" (above).
- `letter.tsx:156` — `'This browser will not let the app copy or share the letter. Use Print
  instead.'` names a control that on web is labelled `'Print'` (`:272`) — correct, and worth noting
  as the one cross-reference in the app that actually matches its target's label.

---

## `app/case/[caseId]/export.tsx`

159 lines, and the shortest screen in the scope. Token discipline inside the component is good
(`theme.spacing.*`, `padding="lg" radius="lg"`); the defects are the container width, the absent
loading state and the total absence of feedback after the only action.

### 1. Layout defects

- `export.tsx:156` — `column: { maxWidth: 760, width: '100%', alignSelf: 'center' }`.
  `LAYOUT.maxContentWidth` is **720** (`tokens.ts:626-630`) and is imported by name on the case screen
  (`index.tsx:802`) and the letter screen (`letter.tsx:689`). 760 is a raw literal 40pt wider, so on a
  tablet or on web the export column does not line up with the screen the user arrived from. See the
  cross-screen note below: there are five different content widths in this scope.
- `export.tsx:92-133` — the whole screen is four elements: a paragraph, one card, a button, and a
  conditional line. With `ScreenScroll`'s masthead and `SPACING.giant` bottom padding, content ends
  roughly halfway down a modern phone and the rest is empty canvas with the primary button floating
  in the middle of it. This is the clearest instance of "cards floating in emptiness" in the scope,
  and the fix already exists: `ScreenFooter` (used at `letter.tsx:267`) pins the action and lets the
  explanation own the page.
- `export.tsx:120-126` — the primary `Button` sits inline between two blocks of text, so the
  explanation at `:128-132` renders *below* the button it is explaining.

### 2. Hardcoded styling

```
column: { maxWidth: 760, width: '100%', alignSelf: 'center' },
bullet: { width: 4, height: 4, borderRadius: 2 },
```

(`export.tsx:155-158`.) The bullet is defensible — `tokens.ts:551-578` documents `xxs` 2 and `xs` 4
as existing "for drawing" — but it is written as literals, and the identical dot is redeclared at
`claim/[claimId].tsx:588`. `maxWidth: 760` is not defensible.

### 3. Copy quality

- Genuinely good throughout: `:96-99` describes the artefact in the reader's terms, `:111` says
  "a fingerprint for each file" instead of naming SHA-256, `:115-117` states the sensitivity instead
  of reassuring, and `:122` changes the button label by platform.
- `export.tsx:82` — screen title `'Export case report'`; the row that leads here is labelled
  `'Export'` (`index.tsx:160`) and the artefact is called "the report" here but "the case report" in
  `dialogTitle` (`:66`) and "a readable copy of the case" at `:96`.
- `export.tsx:111` — `'An index of the sources'`, while the same screen says "each source" (`:97`),
  and the case screen says "Sources" but the empty-state actions elsewhere say "Add evidence". Same
  noun drift as the rest of the workspace.
- `export.tsx:130` — `'This case could not be loaded, so there is nothing to export yet.'` Rendered
  as plain `bodySmall` secondary text under a disabled button, where the rest of the app would use a
  `Notice tone="warn"`. It is also the only branch that explains the disabled button, and it never
  fires during `loading`.

### 4. Leaked internals

None. No ids, no model name, no prompt version, no "V1", no storage-vendor tag. The report's contents
are described functionally.

### 5. Loading and error states

- **No loading state.** There is no skeleton and no spinner; during load the screen renders as if it
  were ready. Worse, the contents card asserts a fact about the user's case while it does so:
  `report` is null until the workspace lands, so `:107-110` prints **"No assessment has been saved
  yet, so every claim will be marked as not assessed"** to a user whose case has an assessment, then
  silently swaps the sentence. This is the same defect class as `timeline.tsx:216-218` and
  `audit.tsx:517-521`, and here it makes a false statement rather than an empty one.
- `export.tsx:125` — `disabled={busy || loading || !record}`, so the primary button is dead during
  load with nothing on screen saying why.
- `export.tsx:40` — `useWorkspace(...)` destructures `loading` and `error` but **not `reload`**, so
  the `Notice tone="danger"` at `:93` for a *load* failure has no retry. Every sibling screen uses
  `ErrorState … onRetry={reload}` (`audit.tsx:353-358`, `event/[eventId].tsx:192-197`,
  `compare.tsx:167-172`).

### 6. Dead ends

- **The screen's only action produces no confirmation of any kind.** After
  `Print.printToFileAsync` + `Sharing.shareAsync` resolve (`:59-68`), `busy` goes false and nothing
  else changes: no toast, no "saved", no filename, no way to re-open what was produced. If the user
  cancels the share sheet, the result is identical to success. `useToast` exists and the letter screen
  uses it for exactly this (`letter.tsx:149`, `:201`).
- `export.tsx:70` — the print fallback is a good decision, but it is silent: the user who asked to
  share ends up in a print dialog with no explanation, on a screen whose button said
  `'Create PDF report'`.

---

## `app/case/[caseId]/audit.tsx`

The most carefully reasoned file in the scope, and the one that already removed the client's exact
complaints — `HASH SIGNED`, "Immutable Audit Trail", "Tamper-Resistant Ledger", "Actor a3f9c1b2d4",
`EVIDENCE a3f9c1b2` chips, "Cloud Synchronized", and a 21-hex-literal colour map — each with a
comment recording why. What remains is Title Case copy that contradicts its own comment, a loading
state that makes the exact false claim the file's comments forbid, and a history you cannot follow.

### 1. Layout defects

- `audit.tsx:314-340` — like the event screen, this one hand-rolls the header instead of using
  `ScreenScroll`/`Masthead`. Here the gutters *are* right (`SPACING.xl` = `LAYOUT.screenPadding` =
  20, `:751`, `:756`), so the cost is narrower: no back fallback (`:326` bare `router.back()`), no
  `RefreshControl`, and `accessibilityLabel="Back"` (`:326`) where the event screen says
  "Back to case".
- `audit.tsx:499-539` — the integrity panel's status column has no `wrap` and its two chips have no
  `shrink`, while the same file passes `shrink` to the chips that need it (`:666`, `:687`). At 360dp
  with a large system font, `AnimatedCounter` (a `statValue`, the largest type in the app) on the left
  and `'Saved to your account'` + icon on the right collide.
- `audit.tsx:388-420` — five filter chips with counts (`'Relationship Links (12)'`) in a horizontal
  `ScrollView` with `showsHorizontalScrollIndicator={false}`. At 360dp the fourth and fifth are
  entirely off-screen with no visual hint that the strip scrolls — the same defect as
  `timeline.tsx:201-214`.
- `audit.tsx:549-559` — the full 64-character `chain.head` is printed at `mono` full-width above the
  fold, which is three wrapped lines of hex in the first card of the screen. The per-row digests use
  `shortDigest()` (`:730`); the head does not. Nothing is wrong with offering it, but it is the
  visual centrepiece of the panel and should sit inside the same `What does this prove?` disclosure
  (`:561-609`) that already exists two lines below it.
- `audit.tsx:715-732` — each row ends with `Entry 3 of 24` on the left and a hex fragment on the
  right, under a `Divider`, under a timestamp row, under a chip row: five stacked rows per entry at
  `padding: SPACING.xl`. A 24-entry history is very tall for what each row conveys.

### 2. Hardcoded styling

Effectively none, and the `styles` block carries a docblock explaining why module-scope `SPACING`
references are still token references (`audit.tsx:739-744`). This is the model the `event`, `compare`
and `claim` screens should follow. Only `Icon size={16}` (`:575`) and the `pressScale` literals are
raw.

### 3. Copy quality

- **Title Case, in a file that states the rule against it.** `audit.tsx:334-336` says "Sentence case,
  which is what every other screen title in the app uses" — and the same file ships
  `'No Activity Recorded Yet'` (`:444`), `'No Entries Match This Filter'` (`:445`),
  `'Audit Trail Active'` (`:520`), `'No Recorded Entries'` (`:520`),
  `'Recorded Entry'`/`'Recorded Entries'` (`:504`), `'Evidence Ops'`, `'Relationship Links'`,
  `'Claims & Events'`, `'Case Reviews'` (`:205-209`).
- `audit.tsx:206` — `'Evidence Ops'`. "Ops" is engineering shorthand; nobody building a bank
  complaint has an opinion about evidence ops.
- `audit.tsx:207` — `'Relationship Links'` uses the internal entity name (`workspace.relationships`)
  twice over, for the thing the case screen calls **Connections** (`index.tsx:146`).
- `audit.tsx:209` — `'Case Reviews'` labels a filter that actually matches `FINDING_*` **and**
  `CASE_*` (`:222-223`), i.e. finding reviews plus case renames and status changes. The label
  misdescribes its own filter.
- **Four names for this one screen, three of them on the screen itself**: the entry row says
  `'History'` (`index.tsx:153`), the header says `'Audit trail'` (`:337`), the panel heading says
  `'Activity history'` (`:490`), and the loading notice says `'Reading this history'` (`:442`).
- `audit.tsx:452` — `'No activity records match the selected filter category. Try "All".'`
  "Activity records" and "filter category" are system nouns, and the sentence names a control in
  quotation marks instead of offering it.
- Positives worth preserving verbatim: `:355`, `:594`, `:603-604`, `:520`, `:534`, `:705`, `:721`.
  `AUDIT_ACTION_LABELS` (`enums.ts:253-276`) is fully human ("Case analysed", "Details confirmed",
  "Record sealed"), so no action enum can leak here.

### 4. Leaked internals

- `audit.tsx:727` — `accessibilityLabel={`Chain digest ${link.digest}`}`. A screen reader reads
  **64 hexadecimal characters aloud**, one row at a time. The same file truncates a chip label at 48
  characters specifically to protect the accessibility label from a paragraph (`:198-201`), so the
  intent is established; this is the one place it inverts.
- `audit.tsx:594` — `'(SHA-256)'` in body copy, where the evidence screen and `letter.tsx:391` call
  the same value "a fingerprint" and this very panel titles it `'Fingerprint of this history'`
  (`:550`). One product, two vocabularies for one number.
- `audit.tsx:557-559`, `:730` — digests on screen by design. Justified for an evaluator, but it is
  worth stating plainly that the top card of this screen is a wall of hex and the bottom of every row
  is a hex fragment.
- Explicitly **absent**, and confirmed by reading: no "Firebase Connected", no "Cloud Firestore", no
  "PROOF", no SCREAMING_SNAKE, no actor id, no `metadata` dump (`:624-636` records the removal), no
  "V1", no "Evolution Tools". `repositoryKind === 'firebase'` (`:311`) never reaches the UI; the chips
  say "Saved to your account" / "Saved on this device" (`:534`).

### 5. Loading and error states

- **The loading state makes the exact false claim the error path was rewritten to avoid.** The comment
  at `:346-352` says a failed load "would state 'No Recorded Entries' and show a count of zero — a
  positive claim about the history, made from data that never arrived" — and that is precisely what
  renders while `loading` is true, because the guard covers `error` only: `IntegrityPanel` draws
  `AnimatedCounter value={0}` (`:502`), the label `'Recorded Entries'` (`:504`) and the chip
  `'No Recorded Entries'` (`:520`) before any data exists.
- There is **no skeleton**. When data arrives the counter animates 0 → n, the chip changes text and
  tone, the entire `Fingerprint of this history` block appears (`:541-611`, ~90pt inserted mid-card),
  the filter counts change width, and the notice is replaced by rows. Every element on the screen
  moves.
- The list's own empty notice *is* loading-aware (`:440-453`), which shows the author considered this
  for the list and not for the panel above it.
- No pull-to-refresh: the hand-rolled `ScrollView` (`:342`) has no `RefreshControl`, so `reload`
  is reachable only through the seal ribbon and the error state.

### 6. Dead ends

- `audit.tsx:675-691` — the reference chips resolve to a record's real name (the fix documented at
  `:137-148`) and then **do not navigate**. "Bank statement March 2024" appears as a chip on the entry
  that added it, and tapping it does nothing; the row is not pressable either. The history is a list
  of things you cannot open, on a screen whose siblings make every reference tappable
  (`compare.tsx:254`, `event/[eventId].tsx:305`).
- `audit.tsx:326` — `router.back()` with no fallback, on a screen reachable by deep link.
- `audit.tsx:438-455` — the "no entries match" notice tells the user to try "All" rather than
  offering a reset control.

---

## `app/(tabs)/insights.tsx`

The state machine at `:103-110` is the best-reasoned loading logic in the codebase and its comment
explains exactly which bug each branch prevents. Two things spoil the screen: an unbounded case
switcher, and a raw error string presented as the user-facing message.

### 1. Layout defects

- `insights.tsx:266` — `column: { maxWidth: 960 }`. **The third of five content widths in the app**:
  720 (`LAYOUT.maxContentWidth`, `index.tsx:802`, `letter.tsx:689`), 760 (`export.tsx:156`), 820
  (`previous-cases.tsx:246`, `about.tsx:92`), 960 here. On web and on tablets the app's column
  changes width on nearly every navigation. `LAYOUT.maxContentWidth` exists precisely to stop this
  (`tokens.ts:626-630`).
- `insights.tsx:151-195` — the case switcher renders one pill per case in a wrapping `Row` with no
  cap, no "show more" and no horizontal scroll. A user with twelve cases gets six rows of pills
  (each up to `maxWidth: 260`, `:267`) above the analysis, pushing the panel the screen exists for
  below the fold. `notifications.tsx:43` solves the same problem with a `WORKLIST_PREVIEW` constant
  and a documented rationale.
- `insights.tsx:161-189` — the pill's tap target is `spacing.sm` × 2 (16) plus a `bodySmall` line box
  (~21) ≈ **37pt**, under `HIT_TARGET` 44 (`tokens.ts:617`), with no `hitSlop`.
- `insights.tsx:216-232` — "Open case" is text-only with `hitSlop={8}`, giving roughly 36pt, and it
  is the only route from this tab into the case.
- `insights.tsx:198` — `<FadeIn key={activeCase.id}>` remounts the whole lower half on every
  switcher tap, so picking a case fades out the card, the chip and the panel together rather than
  swapping the panel.

### 2. Hardcoded styling

```
column: { maxWidth: 960, width: '100%', alignSelf: 'center' },
switch: { borderWidth: StyleSheet.hairlineWidth, maxWidth: 260 },
```

(`insights.tsx:265-268`.) Plus `hitSlop={8}` (`:227`) and the `pressScale` literals. Everything else
correctly reads `theme.spacing` / `theme.radius` / `theme.layout`.

### 3. Copy quality

- `insights.tsx:129-131` — `<ErrorState title="Could not load analysis" message={failure.message} …>`.
  The **raw repository error string is used as the user-facing message**, on the tab the product is
  built around. `ErrorState` has a `detail` slot for exactly that, and every other screen uses it
  properly (`audit.tsx:353-357`, `event/[eventId].tsx:192-197`, `previous-cases.tsx:256-261`,
  `notifications.tsx:444-449`). The title is also the only system-side error title on the screen —
  compare `'This case would not open'` at `:249`, which is how it should read.
- `insights.tsx:115` — `subtitle="What do the sources support?"`. `MastheadProps.subtitle` is
  documented as "One line under the title. Keep it factual" (`Screen.tsx:213`); a rhetorical question
  in the subtitle slot is the one piece of marketing voice in the case flow.
- `insights.tsx:114` — title `'Analysis'`, matching the tab label (`(tabs)/_layout.tsx:46`). Correct,
  and one of the few labels in the app that does match its entry point — though the file is still
  named `insights.tsx`, and "Insights" appears nowhere in the UI.
- Positives: `'Nothing to analyse yet'` with a `'Create a case'` action (`:142-147`),
  `'Not analysed yet'` (`:237`), and `:250`, which explains a failure in terms of what may have
  happened to the user's data.

### 4. Leaked internals

- `insights.tsx:131` — `failure.message`, as above: repository and adapter error text rendered as
  primary copy is the most likely route for an internal string to reach a user on this screen.
- Nothing else. `lastAnalyzedAt === null` becomes a `'Not analysed yet'` chip (`:235-241`) rather than
  a timestamp or a field name.

### 5. Loading and error states

Correct, and the reasoning at `:76-110` should be treated as reference: `loadingSeenFor` prevents the
"switching between two good cases flashes an error" bug, `failure` outranks the skeleton so an error
never sits above a spinner, and `'missing'` is distinguished from `'loading'`. `SkeletonCard` for both
the case list (`:138`) and the panel (`:255`), `onRefresh`/`refreshing` wired (`:116-117`).

### 6. Dead ends

- `insights.tsx:235-241` — the `'Not analysed yet'` chip is inert; the control that would resolve it
  lives inside `CaseAnalysisPanel` below, and nothing connects the two.
- `insights.tsx:229` — `Text variant="label" colorToken="accent"` for "Open case". This is the
  **structural gold** (`colors.accent`, documented at `tokens.ts:438-449` as the colour that paints
  structure — tiles, borders, rules), used here as the colour of an interactive text label, where the
  token for accented text is `textAccent` (used correctly at `audit.tsx:557`, `:570`, `:576`). Gold
  text with no underline, no chevron and no button chrome is also the weakest possible affordance for
  the screen's only navigation.

---

## `app/previous-cases.tsx`

The flow is right — list, review, move, then separately remove — and the reasoning for splitting it in
three is sound (`:14-22`). The screen fails on the review panel, which is an unbounded single card
containing every claim and the full extracted text of every source, with the primary action at the
bottom of it.

### 1. Layout defects

- `previous-cases.tsx:246` — `maxWidth: 820`, the fourth width in the app (see `insights.tsx:266`).
- `previous-cases.tsx:319-464` — the review panel is one `Surface glass` holding the title, the
  description, four chips, every claim, every source with an expandable text dump, up to three
  notices, and two buttons. There is no `Section`, no `SectionHeader` and no `ScreenFooter`, so
  `'Move into my account'` (`:453`) sits below all of it: with ten sources the user scrolls past
  everything to reach the button that is the point of the screen.
- `previous-cases.tsx:372-377` — the expanded extracted text renders **unbounded raw OCR output** at
  `body` size with no `numberOfLines`, no max height and no scroll container. One long PDF makes this
  card tens of screens tall.
- `previous-cases.tsx:367-371` — each source's disclosure is a full-width ghost `Button`. `Disclosure`
  exists in the primitive set for exactly this and is what the case screen uses; a stack of full-width
  buttons is the heaviest possible treatment for "show more".
- `previous-cases.tsx:344-353` — claims render as bare `Text` lines with no divider, ordinal or chip:
  a run-on wall of sentences where `ClaimCard` (`@features/claims/claim-card`) already exists.
- `previous-cases.tsx:270` and `:344` — `variant="subheading"` is used both for the list heading
  ("3 cases found") and for the section headings inside the panel ("Claims", "Sources") and again for
  each source's title (`:361`), so three levels of hierarchy render identically.
- `previous-cases.tsx:314` — `{reading && <SkeletonList count={2} />}` sits *above* the panel it
  stands in for, so tapping a case inserts a skeleton between the list and the eventual panel, then
  the panel appears below where the skeleton was.

### 2. Hardcoded styling

One number in the whole file, and it is the container: `maxWidth: 820` (`:246`). There is no
`StyleSheet` block at all; everything else goes through `Stack`/`Row`/`Surface` props and
`theme.spacing`. Structurally the cleanest file in the scope.

### 3. Copy quality

- `previous-cases.tsx:316` — `<Notice tone="danger" title="This needs your attention" …>`. The title
  says nothing at all, and the message is a raw thrown error string. Every other failure on this same
  screen is specific: `'Device storage could not be read'` (`:257`),
  `'This case cannot be moved yet'` (`:385`), `'The device copy could not be removed.'` (`:226`).
- `previous-cases.tsx:444` — `title="Your account already has a case with this id"`. **"Id" is an
  internal concept**; a user has never seen a case id and cannot act on one. The following sentence
  ("Moving will overwrite it") is the consequence they need, and the title should name the case.
- `previous-cases.tsx:448-452` — `<Text tone="danger">Your account could not be checked. Reconnect
  before moving anything.</Text>`: a bare red sentence among eight `Notice`s, so the one message that
  blocks the primary action is the least prominent thing near it.
- `previous-cases.tsx:271` — `'3 cases found'`. "Found" is scanner language for something the user
  already knows they created.
- `previous-cases.tsx:333` vs `:355` vs `:368` — "sources" here, `plan.value.evidenceCount` in the
  data behind it, "Show extracted text" for the thing the evidence screen calls something else.
- Positives: `:439` ("Nothing is re-analysed and nothing is discarded"), `:421-423` ("Removing it
  cannot be undone"), `:258`, `:395-400`. This is the app's best destructive-action copy.

### 4. Leaked internals

- `previous-cases.tsx:444` — "this id", above.
- `previous-cases.tsx:316` — raw exception text as a user-facing `message` (the same pattern as
  `insights.tsx:131`); at `:259` the identical value is correctly placed in `detail`, so the screen
  does both.
- `deviceOwnerId` appears only in keys and calls, never on screen. Good.

### 5. Loading and error states

- Strong: `SkeletonList count={3}` (`:254`), `SkeletonList count={2}` while reading (`:314`),
  `ErrorState` with `detail` + `onRetry` (`:256-261`), `onRefresh`/`refreshing` (`:243-244`), and
  `loading` on both destructive buttons (`:427`, `:456`).
- `previous-cases.tsx:457` — `disabled={moving || !plan?.value || current.loading || Boolean(current.error)}`.
  Three of the four reasons are explained on screen; `current.loading` is not, so the primary button
  is silently dead while the account list loads.

### 6. Dead ends

- `previous-cases.tsx:248-252` — `'Sign in to move a case'` with **no action**, on a screen that
  cannot do anything until the user signs in. `EmptyState` takes an `action` and
  `notifications.tsx:451-456` fills it with a `'Sign in'` button for the same situation.
- `previous-cases.tsx:441-447` — the id-collision warning offers no way to compare the two versions
  or to rename; the only path forward is to overwrite.

---

## `app/notifications.tsx`

Reference-quality states and reasoning (`:99-142`), correct use of `SEVERITY_TONE`, real paging in
both directions, and the only screen in the scope whose every empty state has an action. The defects
are small raw numbers and one navigation decision that strands the user.

### 1. Layout defects

- `notifications.tsx:290-475` — **no max content width at all**, so on a tablet or on web the rows
  stretch the full window while every other screen centres a column. The fifth distinct answer to the
  same question.
- `notifications.tsx:480` — `row: { borderBottomWidth: 1 }`. Every other rule in the app is
  `StyleSheet.hairlineWidth` (`audit.tsx:753`, `insights.tsx:267`) or a `Divider`, so the activity
  log is ruled with lines two to three times heavier than the rest of the product — and the last row
  gets one too, drawing a line under the end of the list.
- `notifications.tsx:375-382` — the `'Show N more'` ghost button has no top margin and butts directly
  against the glass surface above it.
- `notifications.tsx:326-332` — the worklist rows are `Pressable` with no padding of their own, so
  the press feedback runs to the edge of the card's `padding="lg"` and the rows are separated only by
  `Divider spacing="md"`.

### 2. Hardcoded styling

```
row: { borderBottomWidth: 1 },
```
(`:479-481`) plus inline `marginTop: 4` (`:348`, `:428`), `marginTop: 6` (`:362`), `marginTop: 8`
(`:432`), `Icon size={20}` (`:368`), `Icon size={22}` (`:422`). `6` is specifically off the scale —
`tokens.ts:551-578` records that 6 was removed from it because it was "off-grid".

### 3. Copy quality

- Very good: `'Needs doing'` (`:291`) is the user's phrase, not the system's; `'Outstanding'` /
  `'Recent activity'` label the two halves honestly; `:461` and `:454` are plain.
- `notifications.tsx:445-446` — `'Activity could not be loaded'` / `'Check your connection and try
  again.'` The advice is a guess: this screen reads local storage as well, and on a device-only
  session there is no connection to check. `previous-cases.tsx:258` shows the better form.
- `notifications.tsx:460` — `'No case activity yet'` uses "case activity", the internal name of the
  derivation (`caseActivity`), where the section heading two blocks up says "Recent activity".
- `notifications.tsx:429` — `{item.caseTitle} · {formatTimestamp(item.time)}`: a separator glyph built
  inline in JSX. That is the app's third separator convention after `' | '`
  (`evidence/[evidenceId].tsx:187`, `:191`, `:227`) and `Divider`.
- The route is `/notifications` and the screen's own docblock argues at length that it is *not* a
  notification feed (`:114-124`). On web the URL contradicts the screen.

### 4. Leaked internals

None. `item.failed` becomes an icon and a tone, `AttentionKind` becomes a glyph through `WORK_ICON`
(`:53-58`), severity goes through `SEVERITY_TONE`, and no id or enum value is printed.

### 5. Loading and error states

- The best in the scope: skeleton inside `empty` while loading (`:441-442`), `ErrorState` with
  `detail` + `onRetry` (`:444-449`), two distinct `EmptyState`s each with an action (`:450-464`),
  `refreshing`/`onRefresh` (`:407-408`), a generation counter, and the `ready` case deliberately
  holding `loading` true with a comment explaining the bug that caused (`:174-182`).
- One layout shift, by design: `ownData` (`:230`) is false during any refresh, so pulling to refresh
  removes the entire "Outstanding" card and the "Recent activity" heading from the header, collapsing
  the page, then restores them.

### 6. Dead ends

- `notifications.tsx:234-246` — the activity log opens rows with `router.replace`, so **tapping an
  entry destroys the route back to this screen**. The file argues the case for `push` on the worklist
  immediately below (`:248-259`) and does not apply the same reasoning here; a user reviewing five
  saved changes has to find their way back to the bell after each one.
- `notifications.tsx:455` — the sign-in empty state also uses `router.replace`, so after signing in
  there is no return path to what they were looking at.

---

## `app/about.tsx`

**The brief's question — "does it say what the product does and who it is for, or is it a
version-number dump?" — has a clear answer: it is not a version dump.** There is no version string,
no build number, no "V1", no library list, no "Firebase" tag, no developer credit. It opens with a
proposition (`:31`), states what the product does in one sentence (`:34`), walks the actual workflow
in five steps, defines all six conclusions the app can reach, and then spends its largest card on
what the user must not conclude — including a genuinely unusual, correct privacy paragraph whose three
failed drafts are recorded in a comment (`:60-81`).

It fails on the second half of the question. **It never says who it is for.** The product exists for
an ordinary person assembling a documented complaint — a disputed bank charge, a telecom bill, a
consumer claim — and none of that appears anywhere on this screen. "Examine claims using the sources
you provide" (`:34`) would describe a research tool, a compliance product or a developer library
equally well. A stranger reading this page learns what the app *is* and nothing about whether it is
for them.

### 1. Layout defects

- `about.tsx:92` — `content: { width: '100%', maxWidth: 820 }`: the same fourth width as
  `previous-cases.tsx:246`, and still not `LAYOUT.maxContentWidth`.
- `about.tsx:28` — hand-rolled `ScrollView` instead of `ScreenScroll`, with all padding inline. It
  does at least use `theme.layout.screenPadding` and `theme.layout.headerHeight`, which the event and
  audit screens do not — but `paddingBottom: insets.bottom + theme.spacing.xl` (20) against
  `ScreenScroll`'s `SPACING.giant` leaves the final paragraph almost touching the bottom edge on a
  device with no home indicator.
- `about.tsx:50` and `:55` — `Text variant="title"` for both a page section heading ("What a
  conclusion means") and a card heading inside a `Surface` ("What to check before relying on a
  result"), so a section and an element inside a section have identical weight. `SectionHeader`
  (`Screen.tsx:617-658`) exists for the former.
- `about.tsx:51-53` — the six outcomes are `subheading` + body pairs with `gap: md` and no dividers,
  ordinals or chips. This is a **legend for coloured chips the user meets elsewhere** and it shows
  none of those chips, so the one screen that could teach the app's tone vocabulary teaches it in
  plain text.
- `about.tsx:38-44` — five numbered cards each with "Step 1" as a `caption` above a `title`; the
  ordinal is the smallest text in the card, so the sequence reads last.
- The file is written with almost no line breaks — `:52` renders an entire outcome row as one line,
  `:92` is the whole `StyleSheet`, and every `Text` crams its props and children together. Content
  aside, it is the least finished-looking source file in the scope.

### 2. Hardcoded styling

Only `maxWidth: 820` (`:92`). Every space, colour and size otherwise comes from `theme.*` — including
`theme.motion.stagger` for the entrance delays (`:33`, `:36`, `:49`), which is the correct token and
is used nowhere else in this scope.

### 3. Copy quality

- `about.tsx:9` — `'Processing status tells you which sources are ready, which failed, and which need
  attention.'` "Processing status" is the internal field name (`processingState` /
  `PROCESSING_STATE_LABELS`), presented to the user as vocabulary they should learn.
- `about.tsx:11` — `'Use the evidence graph to explore which sources support or conflict with a
  claim.'` Two problems: the screen is called **Connections** (`index.tsx:146`), so "evidence graph"
  is an internal name; and that screen **draws no graph** — so the one place the product explains
  itself promises a visualization the app does not have.
- `about.tsx:11` — `'Your case history and search help you find the work later.'` Vague, and "case
  history" is a fifth name for the audit screen.
- `about.tsx:34` — `'It organizes evidence'`: American spelling, against `'Nothing to analyse yet'`
  (`insights.tsx:144`) and `'Case analysed'` (`enums.ts:269`). One product, two spelling
  conventions.
- `about.tsx:57` — `'PDF reading includes a limited number of scanned pages'`. "A limited number" is
  the vaguest statement on a screen whose whole purpose is precision; the cap is a constant and can
  be named.
- `about.tsx:87` — the header reads `'How evidence review works'` while the button that brings the
  user here reads `'What this app does, and does not do'` (`profile.tsx:761`). Both are good strings;
  they are not the same string.
- Strong throughout otherwise, particularly `:7` ("A claim is a statement to examine, not a fact the
  app assumes is true"), `:17` ("This does not establish intent to deceive"), `:58`, and `:82`.

### 4. Leaked internals

- `about.tsx:9` "Processing status" and `:11` "evidence graph", as above — internal names, not leaked
  values.
- The six `outcomes` titles (`:14-21`) match `ASSESSMENT_LABELS` (`case-report.ts:165-172`) **exactly**
  — same words, same casing, all six present, none missing. This is the only cross-file label
  agreement I found in the scope and it should be protected by a test.
- No version, no vendor, no model name. The privacy paragraph deliberately says "the provider you
  configure in Settings" rather than naming Groq (`:78-80`).

### 5. Loading and error states

Not applicable — the content is static. No spinner, no shift, correctly.

### 6. Dead ends

- `about.tsx:80` — "Settings is where a key is added or removed" is stated in a comment but the
  rendered sentence (`:82`) says "the provider you configure in Settings" with **no link to
  Settings**. Every actionable noun on this screen is inert: Settings, the graph, the case history and
  search are all named and none is reachable.
- The screen has no next step of any kind. A person who has just read what the product does and who
  is presumably convinced has no `'Create a case'` button, which is the one thing
  `insights.tsx:146` gets right on an equivalent page.

---

## Cross-screen: the five content widths

Worth stating once, since it appears in six files and no single screen looks wrong on its own. The
token is `LAYOUT.maxContentWidth = 720` (`tokens.ts:626-630`), and the scope contains:

| Value | Where |
| --- | --- |
| 720 (token) | `case/[caseId]/index.tsx:802`, `case/[caseId]/letter.tsx:689` |
| 760 | `case/[caseId]/export.tsx:156` |
| 820 | `previous-cases.tsx:246`, `about.tsx:92` |
| 960 | `(tabs)/insights.tsx:266` |
| none | `notifications.tsx`, `case/[caseId]/audit.tsx`, `case/[caseId]/event/[eventId].tsx` |

On a phone none of this is visible. On a tablet, on a foldable, and on web — where the client is most
likely to be shown the product — the column jumps width on almost every navigation, which is the
mechanism by which an app made of good screens still reads as unfinished.

---

## Ranked

The twelve most damaging problems in this scope, worst first.

1. **The two flagship visualizations render no visualization.** `graph.tsx:400-520` draws a list of
   nodes and a list of edges — no lines, no positions, nothing connected to anything — and
   `timeline.tsx:220-250` draws a plain card list with no axis, no spine and no date gutter, on the
   two screens whose names, icons and hints (`index.tsx:137-149`) promise a picture.
2. **Nine raw ids and raw SCREAMING_SNAKE enum values are printed to the user on the connections
   screen**, through `|| edge.type` and `?? node.id` fallbacks at `graph.tsx:443`, `:449`, `:455`,
   `:492`, `:496`, `:498`, `:600`, `:603`, `:605` — the client's explicit removal list, still on
   screen.
3. **Screens assert facts about the user's case while the data is still loading.**
   `export.tsx:107-110` states "No assessment has been saved yet, so every claim will be marked as
   not assessed" before the workspace arrives; `audit.tsx:502-521` shows a count of zero and
   "No Recorded Entries" — the exact false claim the comment at `audit.tsx:346-352` was written to
   prevent — and `timeline.tsx:216-218` and `graph.tsx:340-343` do the same with "nothing recorded".
4. **Five of the seventeen screens have no loading state at all**, so the page arrives in one jump
   with everything shifting: `letter.tsx:213` falls through to a masthead over an empty canvas,
   `export.tsx` renders as if ready, `audit.tsx` animates a counter from a false zero, and
   `claim/[claimId].tsx:173-189` and `timeline.tsx:155-161` use a `Notice` titled "Loading" with a
   retry button where `SkeletonCard`/`SkeletonList` already exist.
5. **`event/[eventId].tsx:178-239` bypasses `ScreenScroll` entirely**, giving the case workspace a
   second header design, a 16pt gutter against `LAYOUT.screenPadding` 20 (`:482`, `:487`), 18pt card
   padding and 16pt radii that exist in no token (`:490-493`), and a back button with no deep-link
   fallback (`:225`).
6. **One action carries five different names across screens the user moves between in two taps**:
   `'Add a source'` (`index.tsx:302`), `'Add evidence'` (`compare.tsx:187`, `timeline.tsx:143`,
   `claim/[claimId].tsx:338`), `'Add a document'` (`letter.tsx:234`), plus "sources" / "evidence" /
   "documents" used for the same records on `compare.tsx:143`, `export.tsx:111` and
   `previous-cases.tsx:333`.
7. **The audit screen has four names inside one screen** — `'History'` (`index.tsx:153`),
   `'Audit trail'` (`audit.tsx:337`), `'Activity history'` (`audit.tsx:490`) and
   `'Reading this history'` (`audit.tsx:442`) — and nine Title Case labels (`audit.tsx:205-209`,
   `:444-445`, `:504`, `:520`) in the same file whose comment at `:334-336` states the app's
   sentence-case rule.
8. **Raw error strings are shown to users as the primary message** at `insights.tsx:131` and
   `previous-cases.tsx:316` (the latter under the content-free title
   `'This needs your attention'`), while `ErrorState`'s `detail` slot — used correctly at
   `audit.tsx:356` and `previous-cases.tsx:259` — exists for exactly that text.
9. **The primary action of the export screen produces no feedback of any kind**: after
   `export.tsx:59-68` resolves, a cancelled share sheet and a successful one are indistinguishable,
   there is no toast, no filename and no re-open — and `export.tsx:40` never destructures `reload`,
   so a load failure has no retry either.
10. **The letter — the artefact the user prints and sends — is set in a synthetic oblique that does
    not exist.** `letter.tsx:691` applies `fontStyle: 'italic'` to every unanswered blank while
    `FONT_FAMILY` (`tokens.ts:72-81`) loads eight upright faces and no italic, the same fake-styling
    trap `tokens.ts:661` documents for weight; `letter.tsx:341` then sets the letter's own headings
    in the monospace face reserved for machine-extracted values (`tokens.ts:60-64`).
11. **Tap targets under the documented 44pt minimum sit on the primary navigation of three screens**:
    `compare.tsx:384` (`paddingVertical: 7` ≈ 35pt, the only route to a document),
    `letter.tsx:695` (≈ 23pt, the only route from a fact to its source) and
    `insights.tsx:161-189` (≈ 37pt, the case switcher), against `HIT_TARGET = 44`
    (`tokens.ts:617`).
12. **The history you cannot follow, and the empty states with nowhere to go**:
    `audit.tsx:675-691` resolves every reference to a real record name and then makes none of them
    tappable, while `event/[eventId].tsx:426-431`, `event/[eventId].tsx:461-465`,
    `previous-cases.tsx:248-252` and `about.tsx:82` each name a screen or an action the user must
    reach and provide no route to it.

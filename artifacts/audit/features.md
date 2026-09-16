# `src/features/` audit — the shared composition layer

Read-only audit. Baseline: `src/ui/tokens.ts` (927 lines), `src/ui/primitives/*`, `src/ui/semantics.ts`.

**Calibration respected as documented** (`tokens.ts:438-449`, `tokens.ts:470-487`): `colors.accent` = gold =
structure (icon tints, focus rings, selection borders); `colors.cta` = blue = the primary button;
`tones.accent` = blue = chips. Findings below only fire where a component reached for the *wrong one of
the three for the job it is doing*.

Token vocabulary available and therefore expected: `SPACING` (`xxs`2 `xs`4 `sm`8 `md`12 `lg`16 `xl`20
`xxl`24 `xxxl`32 `huge`40 `giant`48 `colossal`64), `RADIUS` (`xs`6 `sm`10 `md`14 `lg`18 `xl`24 `xxl`32
`pill`999), `BORDER_WIDTH`, `HIT_TARGET`44, `LAYOUT`, `TYPE` (13 sans + 4 mono ranks), `MOTION`,
`ELEVATION`/`ELEVATION_DARK` via `theme.elevation.*`, `theme.tone(...)`. `Icon` has no size scale
(`src/ui/icon.tsx:35`, default 18), so raw glyph sizes are counted only where they are inconsistent, not
as token bypass.

---

## `src/features/navigation/`

### `tab-bar.tsx` (258 lines) — full treatment in §7 below

**Token bypass — 4 raw values, 1 hardcoded shadow.**

- `tab-bar.tsx:135-139` — a hand-rolled black shadow object, three lines under a comment
  congratulating itself for deleting the last hand-rolled shadow:
  ```
  backgroundColor: theme.colors.cta,
  shadowColor: '#000000',
  shadowOpacity: 0.18,
  shadowRadius: 6,
  shadowOffset: { width: 0, height: 2 },
  elevation: 4,
  ```
  `tokens.ts:817-822` is explicit that a neutral-black shadow "reads as dirt" and that every preset is
  tinted royal `#16224A` / `#01040C`. This is the app's most-seen control wearing the one shadow colour
  the token file forbids. `theme.elevation.medium` is the value it wants.
- `tab-bar.tsx:85` — `paddingBottom: insets.bottom > 0 ? insets.bottom * 0.5 : 8`. Raw `8` (=`SPACING.sm`)
  and a magic `0.5` that silently halves the OS safe-area inset.
- `tab-bar.tsx:237-242` — `slotInner: { width: 44, height: 26 }`. `44` is `HIT_TARGET` (imported at line
  38 and unused for this); `26` is off the 4pt grid and matches nothing in `LAYOUT`/`SPACING`.
- `tab-bar.tsx:249-257` — `marginTop: -22`, `width: 52, height: 52, borderRadius: 26`. Four raw numbers
  for the compose disc; `LAYOUT.tileSizeLarge` is 48 and `RADIUS.pill` exists.
- Glyph sizes `22` (line 187) and `28` (line 143) are raw but uncontroversial; noted only because the
  22pt glyph inside a 26pt-high pill leaves 2pt of air, which is why the active pill reads as a smudge
  rather than a shape.

**Composition defects.**

- `tab-bar.tsx:34` — `import { Pressable, StyleSheet, View } from 'react-native'`. Both the tab slots
  (line 168) and the compose button (line 115) use **React Native's** `Pressable`, not the app's
  (`src/ui/primitives/Layout.tsx:233`), which is documented as "the app's one tappable primitive … so
  press feedback is identical on every screen". So the five most-pressed targets in the product are the
  five that do *not* share the app's press behaviour. The substitute is a bespoke `transform:
  [{ scale: pressed ? 0.9 : 1 }]` (`tab-bar.tsx:120`) — an instant, un-eased 10% jump against the
  primitive's 90ms timing-in / snappy-spring-out.
- `tab-bar.tsx:81-108` — the bar states its edge three ways at once: `backgroundColor:
  theme.colors.surface` + `borderWidth: BORDER_WIDTH.hairline` (line 227) + `theme.elevation.high`
  (line 107). `elevation.high` is the 38pt/0.78-opacity preset reserved for modals
  (`tokens.ts:905-911`); a 66pt bar sitting on the canvas is not three planes up.

**Accessibility.**

- Good: `accessibilityRole="tab"` + `accessibilityState={{ selected }}` (lines 170-171), compose has
  role/label/hint (lines 117-119), and the active state is triply encoded (glyph swap, pill, weight) so
  colour is not the sole carrier.
- Missing: no `accessibilityRole="tablist"` on the container (line 89), so the four tabs are announced
  as unrelated tabs with no group or position.
- `tab-bar.tsx:230-236` — `slot: { height: '100%' }` inside a container fixed at `LAYOUT.tabBarHeight`
  (66). Content is 26 (pill) + 4 (`gap: SPACING.xs`) + 16.5 (caption line-height) = 46.5. At the OS
  "largest text" setting the caption line box roughly doubles and the label is clipped by the fixed
  height — there is no `maxFontSizeMultiplier` and no `allowFontScaling={false}` anywhere in the file.

**Copy / internals.** Clean. `TABS` (lines 47-51) maps route `insights` → label `Analysis`, i.e. the
route name is deliberately not shown. No leaked ids or enums.

---

## `src/features/cases/`

### `case-card.tsx` (194 lines)

**Token bypass — 2 raw spacing values, 3 raw glyph sizes.**

- `case-card.tsx:186-192`:
  ```
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  ```
  `gap: 12` is `SPACING.md` written as a literal; `paddingVertical: 10` is not on the scale at all
  (`SPACING.sm` 8 / `SPACING.md` 12). `tokens.ts:577` states the contract this breaks: "Nothing outside
  this file hard-codes a spacing number, which is what makes re-cutting the scale a one-file change."
  Worse, this hand-built row exists next to `Row`/`Stack` (`Layout.tsx:506`, `:546`) which do exactly
  this with tokens — `CaseCard` above it uses `Row` correctly (line 87), `CaseRow` below it does not.
- Glyph sizes `13` (lines 126, 137) and `18` (line 181) — `13` appears nowhere else in the app and is
  below `Icon`'s documented 18 default for dense lists.

**Composition defects.**

- `case-card.tsx:88-94` — a `Row between` whose first child is `<View />` when there is no category.
  An empty view as a layout shim; `Spacer` (`Layout.tsx:579`) is the primitive for this, or the chip
  could simply align right.
- `case-card.tsx:117` — `<Divider spacing="lg" />` then a footer row. Fine on its own, but the card is
  `padding="xl"` (20) with `marginTop: theme.spacing.lg` (16) between title and body and `Divider
  spacing="lg"`: four different vertical rhythms in one 5-element card.

**Copy written from the system's side.**

- `case-card.tsx:133` — `"Not analysed yet"`, `:140` — `"Analysed"`, `:129` — `"Analysis out of date"`.
  British `-s` spelling here against the domain's `ANALYZED` and the American `analyze` used in
  `home-summary.ts` prose; more importantly "Analysed" is a state of the *system's pipeline*, not
  something the reader did or controls. A user building a complaint wants "Checked for conflicts" /
  "Not checked yet".
- `case-card.tsx:89-91` — `record.category` is rendered `variant="monoOverline"` `uppercase`.
  `category` is free text (`src/domain/models.ts:193` — `z.string().max(80)`). Two problems: monospace
  is the app's *provenance* signal, reserved for "this string came off a document"
  (`tokens.ts:56-70`, and `Chip.tsx:9-15` spells out the same rule for labels the app assigned), and a
  category the user typed is not that. Then `uppercase` SHOUTS an arbitrary 80-character user string.

**Duplicated components.** `CaseCard` (line 65) and `CaseRow` (line 155) — two renderers for one
record. The docblock at lines 149-154 justifies the split, and the justification holds (a picker needs
scanning, not the staleness footer). What is not justified is that `CaseRow` re-implements the layout
with literals while `CaseCard` composes primitives; `CaseRow` should be `Row gap="md"` with
`Stack gap="xxs"` inside. **Better: `CaseCard`**, because it goes through `Surface`/`Row`/`Divider` and
therefore inherits the scheme-correct edge treatment from `Surface`'s per-scheme border/shadow logic
(`Layout.tsx:173-177`).

**Accessibility.** Both variants label correctly (lines 80-83, 169-170), `CaseCard`'s label even folds
in the staleness. `CaseRow` sets `minHeight: theme.layout.rowHeight` (56) — good. The staleness footer
(lines 124-142) pairs every colour with an icon *and* words, so colour is not sole carrier.

### `activity.ts` (39 lines)

**Copy written from the system's side — the whole file.**

- `activity.ts:15-19`:
  ```
  const subject = job.evidenceId ? 'Evidence processing' : 'Case analysis';
  ...
  return `${subject} ${states[job.state] ?? job.state.toLowerCase().replaceAll('_', ' ')}`;
  ```
  Every activity title a user reads is a job-queue log line: "Evidence processing queued", "Case
  analysis needs review", "Evidence processing completed". These name the system's internal work item
  (a `ProcessingJob`), not the user's document or claim. The record carries `caseTitle` and the evidence
  title — neither reaches the headline.

**Leaked internals.**

- `activity.ts:16-19` — `states` is `Partial<Record<ProcessingJob['state'], string>>` covering 6 of the
  8 `ProcessingState` members (`semantics.ts:104-113` lists all 8). `UPLOADING` and `CONFIRMED` fall
  through to `job.state.toLowerCase().replaceAll('_', ' ')`, so the enum member itself is rendered —
  "Evidence processing uploading", "Evidence processing confirmed". `PROCESSING_STATE_LABELS` is
  already exported for exactly this (`semantics.ts:339`) and is not used.
- `activity.ts:30` — `detail: job.lastError ?? ...`. A raw pipeline error string, rendered as the
  activity detail with no framing and no next step. `ErrorState` exists so this class of string sits
  behind "Show technical details" (`Feedback.tsx:198-199`: "Never a raw stack trace or SDK error
  string"; `:273-279` on why it stays collapsed).
- `activity.ts:29,36` — ids are minted as `` `job:${job.id}` `` / `` `audit:${entry.id}` ``. Not
  rendered here, but they are the `CaseActivity.id` any consumer may key or display.

**Copy, vague next step.** `activity.ts:30` — `'Open the case to inspect its saved review.'` "Saved
review" is storage vocabulary; the reader has no model of a review being saved or unsaved.

### `home-summary.ts` (36 lines)

**Duplicated components (label map).**

- `home-summary.ts:25` re-declares the assessment vocabulary inline:
  ```
  const labels = { SUPPORTED: 'supported', PARTIALLY_SUPPORTED: 'partially supported', CONTRADICTED: 'contradicted', DISPUTED: 'disputed', INSUFFICIENT_EVIDENCE: 'with insufficient evidence', UNRESOLVED: 'unresolved' };
  ```
  `ASSESSMENT_LABELS` already exists in `src/domain/analysis/case-report.ts:165-172`, in the same file
  this module already imports from (line 1), under the comment *"Assessment outcomes as a reader sees
  them. Never show the stored value."* **Better: `ASSESSMENT_LABELS`**, because it is the single source
  the rest of the app reads and it is exhaustively typed.
- `home-summary.ts:27` — `labels[status as keyof typeof labels]`. The cast defeats the exhaustiveness
  guarantee `semantics.ts:5-9` claims for this layer ("a new enum member is a type error everywhere it
  must be handled"). A seventh assessment status renders as **`"2 undefined"`** in the user's summary
  sentence, with no compile error.

**Copy written from the system's side.**

- `home-summary.ts:35` — `'Evidence has been added; extraction is still needed.'` and detail `'Open the
  case to review processing status and retry or process the sources.'` "Extraction", "processing
  status" and "process the sources" are all pipeline nouns; the user's mental model is "read my
  document". The action is also three alternatives in one sentence.
- `home-summary.ts:20` — `'Open the case to follow the saved job status.'` Names the job.
- `home-summary.ts:23,33` — `'Run analysis again before relying on that review.'` /
  `'Run analysis to see what the sources support, contradict or leave unresolved.'` "Run analysis" is
  the action name used here; see the naming collision collected in the Ranked section — the same action
  is "Analyse" and "Re-run" elsewhere in the layer.
- `home-summary.ts:22` — `` `${report.coverage.processedEvidence} of ${report.coverage.totalEvidence} evidence sources included${report.coverage.truncated ? '; coverage is incomplete' : ''}.` ``
  "Coverage is incomplete" tells the reader a fact about the system's run and nothing about what to do.

---

## `src/features/case/`

The strongest directory in the layer. `assessment.ts` and `case-ledger.tsx` are clean; `composer-sheet.tsx`
is clean apart from one naming collision. Findings below are the exceptions.

### `assessment-plate.tsx` (308 lines)

**Token bypass — 0 raw colours, 0 raw spacing.** Only raw glyph sizes `17` (line 227) and `14`
(line 258), against `Icon`'s 18 default; there is no size token, so this is inconsistency rather than
bypass.

**Composition defects.**

- `assessment-plate.tsx:180-188` + `:299` — the plate hand-builds `Surface`'s box instead of using it:
  ```
  style={[
    styles.plate,                          // borderWidth: BORDER_WIDTH.hairline
    {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.border,
      borderRadius: theme.radius.md,
      padding: theme.spacing.xl,
    },
  ]}
  ```
  This is border + fill and **no elevation, in both schemes**. `Surface` exists precisely to resolve
  that per scheme (`Layout.tsx:173-177`), and its docblock names this exact shape as the app's core
  visual problem: *"what that actually produced was a border and an invisible shadow: a flat box with a
  hairline round it, 55 times over. That is the largest single contributor to the app reading as
  cheap"* (`Layout.tsx:88-92`). The element the file header calls "the element this product exists to
  render" is the flat bordered box in light mode. `<Surface radius="md" padding="xl">` inside the
  existing `Pressable` — which is exactly what `case-card.tsx:86` does — is the fix.
- `assessment-plate.tsx:185` — `radius.md` (14) here against `radius="lg"` (18) on `CaseCard`
  (`case-card.tsx:86`) and `claim-card.tsx`. Three card radii in one list.

**Leaked internals / copy from the system's side.**

- `assessment-plate.tsx:292-294` — the basis line renders the word **stale** to the reader:
  ```
  return basis.stale > 0
    ? `${passages} · ${documents} · ${basis.stale} stale`
    : `${passages} · ${documents}`;
  ```
  So a user reads `4 passages · 2 documents · 1 stale`. "Stale" is engineering vocabulary for a
  citation whose offsets no longer resolve (`assessment.ts:122-131`); the reader has no model for it,
  and this is the single most consequential line on the plate — it is how they learn the verdict rests
  on something that has since changed. The `·`-separated mono triple also reads as a log line rather
  than a sentence. `assessment-plate.tsx:286-288` words the same idea properly — `"0 passages check out
  · 3 no longer resolve"` — so the honest phrasing already exists three lines above.
- `assessment-plate.tsx:284` — `'no assessment on record'`. "On record" is storage vocabulary, and the
  string is lowercase where every sibling is sentence case.
- `assessment-plate.tsx:155` — `'Not assessed yet'`. "Assessed" is the system's word for its own run;
  the caveat directly underneath (line 252) says the same thing in the user's terms — *"This claim has
  not been checked against the sources in its current wording."* — which shows the vocabulary the label
  should have used.

**Accessibility.** Exemplary: role, label folding in the verdict, hint, and
`accessibilityLiveRegion="polite"` on the swapping status (line 210). Tone is always paired with a
glyph and a word (lines 225-235), so colour is never the sole carrier.

### `case-ledger.tsx` (103 lines) — clean

No raw values, no fixed heights, `textAlign: 'right'` chosen explicitly over a fixed column
"at 200% font scale a hardcoded column clips" (lines 100-102). Only nit: `Row gap="lg" align="center"
justify="space-between"` (line 69) where `Row`'s own `between` prop exists (`Layout.tsx:499-501`) —
same output, but three call sites in this layer now do it the long way.

### `composer-sheet.tsx` (287 lines) — clean, one copy collision

- `composer-sheet.tsx:258` — `label={isClaim ? 'Add claim' : 'Record event'}`. "Add claim" is one of
  three names this layer gives the same action; see Ranked #8.
- `composer-sheet.tsx:142` — `Row gap="lg" align="center" justify="space-between"`, as above.
- Everything else is token-clean, has `accessibilityRole="header"` (line 143), labels its close button
  per context (line 148), and puts the disabled-reason in an `accessibilityHint` rather than in colour
  (lines 267-273).

### `assessment.ts` (206 lines) — clean

Pure data. Notable as the counter-example the rest of the layer should copy: it refuses to restate
labels the domain already owns (`assessment.ts:49-52`) — exactly the mistake `home-summary.ts:25` makes
— and every caveat string is written from the reader's side.

---

## `src/features/claims/`

### `claim-card.tsx` (238 lines)

**Token bypass — 3 raw values.**

- `claim-card.tsx:232-237`:
  ```
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 11,
  },
  ```
  `paddingVertical: 11` is the worst raw number in the layer. It is not on the 4pt scale, it is not
  even on a 2pt grid, and it is 1pt different from `case-card.tsx:191`'s `paddingVertical: 10` — two
  list rows that appear in the same scroll view, one of them 2pt taller than the other for no reason
  anyone can state. `SPACING.md` (12) is what both want.
- `claim-card.tsx:219` — `style={{ marginTop: 2 }}`. `SPACING.xxs` is 2.
- `claim-card.tsx:231` — `step: { width: 18 }` — see accessibility below.

**Composition defects.**

- `claim-card.tsx:86-185` — the card has **no pressable wrapping it**; instead `Pressable` wraps only
  the statement + detail block (line 94), and a second `Pressable` wraps the trace toggle (line 148).
  So the state label, the two count chips and the "not a judgement" paragraph are dead zones inside a
  card that visibly dims when its middle third is touched. A user taps the chip, nothing happens.
- `claim-card.tsx:121-126` — `label={`${supporting} supporting`}` where `supporting =
  evaluation?.independentSupport.length ?? 0` (line 82). While the workspace is still loading,
  `evaluation` is undefined and the card asserts **"0 supporting"** in a settled neutral chip. The file
  header (lines 18-23) and `tokens.ts:43-47` both forbid exactly this — "never style an uncertain
  finding so it looks certain". Absent data must not render as a zero count.
- `claim-card.tsx:137-142` — the `UNSUPPORTED` explanation sits under the chips, which are under the
  statement, which is under the state label: four vertical `marginTop`s (`md`, `sm`, `lg`, `lg`) hand
  applied per child instead of one `Stack gap`.

**Leaked internals / provenance violation.**

- `claim-card.tsx:89-91`:
  ```
  <Text variant="monoOverline" tone={tone} uppercase>
    {CLAIM_STATE_LABELS[state]}
  </Text>
  ```
  A monospace, uppercased, letter-tracked treatment of a label the *app* assigned. `Chip.tsx:9-15` is
  written specifically against this: *"A chip reading `Active` or `High` is not that: it is a state the
  app assigned, in the app's own vocabulary. Setting it in mono would claim a provenance it does not
  have and would blunt the signal everywhere it *is* true."* And the same value is rendered in sans
  `caption` 130 lines below in `ClaimRow` (line 219-221) — so one label has two typographic
  treatments in one file, and the louder of the two is the dishonest one. It also reads to the user as
  a SCREAMING_SNAKE enum even though it is not one, because uppercase + mono + tracking is the costume
  an enum wears.

**Duplicated components.** `ClaimCard` (line 61) / `ClaimRow` (line 190) — the same documented
card+row split as `cases/`. See the cross-cutting finding: with `CaseRow` and `EvidenceRow` this layer
now contains **three hand-rolled `styles.row` implementations of one shape** at three different
paddings (10 / 11 / `SPACING.lg`) and two different gaps (12 / `SPACING.lg`). **Better: `EvidenceRow`
(`evidence-row.tsx:217-222`)**, the only one of the three that uses tokens for both gap and padding.
None of them should exist: a `ListRow` primitive (leading slot, title, subtitle, trailing chevron,
`minHeight: rowHeight`) is the missing piece of `@ui`, and its absence is visible as three different
list rhythms on three tab screens.

**Accessibility.**

- `claim-card.tsx:231` — `step: { width: 18 }` around `String(index + 1).padStart(2, '0')` at
  `monoSmall` (12pt). At the OS large-text settings the two digits exceed 18pt and clip or wrap, which
  breaks the numbered trace — the one element the file header calls "the app's answer to … *on what
  basis?*". `minWidth` would survive scaling.
- Both pressables have role, label and (for the toggle) `accessibilityState={{ expanded }}`. Tone is
  always paired with a glyph (lines 88, 213) or a word.

---

## `src/features/evidence/`

### `evidence-row.tsx` (232 lines)

The best-tokenised component file in the layer (`SPACING.lg` for row gap and padding,
`LAYOUT.tileSize` for the badge, `theme.radius.*` throughout, an explicit comment at lines 223-224 about
why the badge reads a token). Two structural problems remain.

**Duplicated components — the leading badge vs `IconTile`.**

- `evidence-row.tsx:225-231` + `:80-99` + `:154-169` — a bespoke leading tile:
  ```
  badge: {
    width: LAYOUT.tileSize,
    height: LAYOUT.tileSize,
    ...
    borderWidth: BORDER_WIDTH.hairline,
  },
  ```
  `IconTile` (`Layout.tsx:438`) is the primitive for exactly this — "the rounded pastel square that
  leads most rows and cards" — takes a `Tone`, and its docblock states callers "pass a `Tone` and never
  a colour". This badge needs a spinner slot `IconTile` does not have (line 90), which is a legitimate
  reason to fork, but it forks the whole box and **adds a hairline border on top of the pastel fill**
  that no `IconTile` in the app has. So the leading tile on the evidence list does not match the
  leading tile on every other list. **Better: `IconTile`** — the right fix is a `busy` prop on the
  primitive, not a second tile.

**Duplicated components — two chip-like things for one value, in one file.**

- `evidence-row.tsx:106-110` renders the processing state as an inline pseudo-chip:
  ```
  <Row gap="sm" align="center" style={{ marginTop: SPACING.xxs }}>
    <Icon name={PROCESSING_ICON[record.state]} size={12} color={palette.fg} />
    <Text variant="caption" tone={tone} numberOfLines={1}>
      {PROCESSING_STATE_LABELS[record.state]}
    </Text>
  ```
  while `evidence-row.tsx:185-190` renders the *same* value 80 lines later through the real `Chip`
  with the same icon and tone. One record's state therefore has two visual identities depending on
  which list you are looking at. **Better: `Chip`** — its height is derived from the caption line box
  (`Chip.tsx:71-75`), it carries `accessibilityLabel` (`Chip.tsx:120`), and `alignSelf: 'flex-start'`
  stops it stretching. The inline version's only advantage is density, which `Chip size="sm"` already
  provides.

**Composition defects.**

- `evidence-row.tsx:196-209` — a hand-rolled `Notice`:
  ```
  backgroundColor: theme.tone('danger').bg,
  borderRadius: theme.radius.sm,
  marginTop: theme.spacing.lg,
  padding: theme.spacing.lg,
  ```
  `Notice` (`Feedback.tsx:341`) is the primitive, and its docblock calls it *"the component the
  product's honesty requirement lives in"*. The copy of it here loses the border, the icon and the
  title, so a failure reads as a bare tinted paragraph with no heading and no "what now".
- The failure block is also inside a `Surface` inside a `Pressable`, i.e. the only way to read a
  failure reason is to be inside the tap target that navigates away from it.

**Leaked internals.**

- `evidence-row.tsx:205-207` — `{record.failureReason}` is rendered raw. Most writers sanitise
  (`src/services/ai/case-analysis.ts:229-231`, `safeFailureMessage`), but
  `src/services/ai/case-analysis.ts:677` stores `error.message` directly:
  `failureReason: (error instanceof Error ? error.message : 'The original file could not be read.').slice(0, 600)`.
  So a platform string can reach this `Text`, in a `caption`, with no disclosure and no retry — the
  opposite of `ErrorState`'s contract (`Feedback.tsx:198-199`, `:273-279`).

### `media-recorder.tsx` (550 lines)

Copy and error handling here are the best in the repo — `MESSAGES` (lines 134-149) states, per
failure, what happened, whether anything was saved, and what to do, and the docblock explains that no
platform string may reach the screen (lines 127-133). `describeError` is explicitly log-only (line 183).
Two defects.

**Token bypass — the whole stylesheet is 2 raw numbers.**

- `media-recorder.tsx:548-550`:
  ```
  const styles = StyleSheet.create({
    card: { padding: 14, borderRadius: 14 },
  });
  ```
  `padding: 14` is **not on the spacing scale at all** — `SPACING` has 12 and 16 and nothing between
  (`tokens.ts:580-593`), and `tokens.ts:571-573` names `lg` 16 as "the most common card padding in the
  app". `borderRadius: 14` re-states `RADIUS.md` as a literal *and* overrides `Surface`'s own
  `radius`/`padding` props (line 446 passes neither), so this card is 14/14 while `CaseCard` is
  `xl`/`lg` (20/18) and `AssessmentPlate` is `xl`/`md`. Three cards, three geometries, one screen.

**Copy — an action label that inverts.**

- `media-recorder.tsx:511` — `<Button label="Keep recording" icon="check" onPress={keep} …>` sitting
  next to `<Button label="Record again" …>` (line 512). "Keep recording" is the *stop and save* action,
  but in a recorder, next to "Record again", it reads as "continue recording". The one irreversible
  choice in the component is the one whose label can be read backwards. "Keep this recording" or
  "Save statement" removes the ambiguity; the surrounding copy already calls it a "take"
  (lines 487, 506, 518).

### `media-recorder-format.tsx` (111 lines) — clean

Pure formatting, no rendering, no tokens involved. `formatElapsedClock` floors rather than rounds
(lines 30-32) and `memoFileName` uses local time with a stated reason (lines 70-73).

### `upload-queue.ts` (297 lines)

**Token bypass (type-level).**

- `upload-queue.ts:46-51` — `ReadFailure` declares `tone: 'info' | 'warn'` and
  `icon: 'text-search' | 'image-off-outline' | 'information-outline'` as raw string unions instead of
  `Tone` and `IconName` from `@ui`. Nothing checks these against the theme's tone table or the icon
  font's glyph list — the exact drift `semantics.ts:1-17` exists to prevent.

**Dead API surface.**

- `upload-queue.ts:90-91` — `stage: string | null;` — *"The named step running right now, while
  `status` is `reading`."* Grepped repo-wide: never assigned, never read, never rendered; the only
  occurrence outside this declaration is `stage: null` in `tests/upload-queue.test.ts:33`. So the
  progress narration the module docblock promises — *"the queue reads strictly in order and names the
  file it is on, so waiting two minutes for ten photographs looks like progress rather than a hang"*
  (lines 24-27) — is not implemented, and every construction site must still fill the field.

**Copy written from the system's side.**

- `upload-queue.ts:277` — `'1 file saved. Check processing status in the case.'` "Processing status" is
  pipeline vocabulary, and it is the third distinct phrasing of this same instruction in the layer
  (`home-summary.ts:35` "review processing status", `activity.ts:30` "inspect its saved review").
- `upload-queue.ts:210,214,219` — these strings become the submit button's own label
  (docblock lines 200-205): `'Add a file to get started'`, `'Still reading files…'`, `'No file here
  could be read'`. A primary button labelled with a status sentence is not an action, and
  `'No file here could be read'` gives no next step (remove them? pick different files?) on the one
  control the user is looking at.
- Good, for contrast: `upload-queue.ts:291` — `'1 was kept on this device only — its backup copy did
  not upload.'` Names no vendor and no service. This is the wording `settings/ai-key-section.tsx`
  should have used (see below).

---

## `src/features/analysis/`

This is the worst directory in the layer. It is also the most-seen: `CaseAnalysisPanel` renders on the
Analysis tab and the case screen, and `CitationList` is imported by six more screens.

### `finding-card.tsx` (544 lines)

**Token bypass — the highest count in the layer. The file imports neither `SPACING` nor
`BORDER_WIDTH`.** Every value in its stylesheet is a literal:

- `finding-card.tsx:513-544`:
  ```
  severityRule: {
    position: 'absolute', left: 0, top: 14, bottom: 14,
    width: 2, borderTopRightRadius: 2, borderBottomRightRadius: 2,
  },
  provisional: { borderRadius: 12, borderWidth: 1 },
  findingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  rowRule: { width: 2, borderRadius: 2, marginVertical: 4 },
  ```
  Four separate failures in twelve lines. `top: 14, bottom: 14` is off the 4pt scale entirely and is
  set against a card whose own `padding="xl"` is 20 — so the severity rule, the one element whose job
  is to align with the card's content, is inset 6pt less than the content it is marking. `borderRadius:
  12` is between `RADIUS.sm` (10) and `RADIUS.md` (14), so the provisional block's corners match no
  other corner in the app. `borderWidth: 1` is `BORDER_WIDTH.hairline` written by hand. `width: 2` is
  `BORDER_WIDTH.thick`.
- `finding-card.tsx:503` — `style={{ marginTop: 2 }}` (`SPACING.xxs`).
- `finding-card.tsx:530` — `dismissed: { opacity: 0.58 }`. A magic opacity with no token behind it;
  `Pressable` uses `0.42` for disabled and `0.62` for press-dim (`Layout.tsx:266,328`), so this is a
  third disabled-ish opacity that means a fourth thing.

**Composition defects.**

- `finding-card.tsx:213-221` — a full-width section rule for one chip:
  ```
  <Divider spacing="lg" />
  <Row between align="center" gap="md">
    <Chip label={CONFIDENCE_LABELS[band]} … />
  </Row>
  ```
  `Row between` with exactly one child does nothing (`Layout.tsx:499-501` — `between` pushes children
  apart; there is nothing to push against), and `Divider spacing="lg"` spends 16pt above and below plus
  a hairline to introduce a 26pt pill. This is the "section header over one item" defect in its purest
  form, on the card a user reads most.
- `finding-card.tsx:370-375` — `ProvisionalPrompt` hand-builds a tinted, bordered, iconless box with a
  title and a message. That is `Notice` (`Feedback.tsx:341`), whose docblock calls itself *"the
  component the product's honesty requirement lives in"* — and a provisional finding is exactly the
  case it was written for. **This is the third hand-rolled `Notice` in the layer** (with
  `evidence-row.tsx:196-209` and `media-recorder.tsx`), so the app's honesty affordance has four
  visual forms.
- `finding-card.tsx:154-174` — the `Pressable` wraps only the title and the explanation. The severity
  rule, the type label, the confidence chip and the comparison table are outside it, in a card that
  dims when its upper half is touched.

**Leaked internals — two SCREAMING_SNAKE enum values reach the reader through this component.**

`ComparisonRow` (`finding-card.tsx:457-474`) renders `finding.inputs` as a key/value table with no
mapping layer on the value side. The file's own docblock (`:19-21`) is proud that inputs are
"reader-facing prose written by the rule … never a field path" — true of the **keys**, false of the
**values**:

- `src/domain/rules/definitions/amount-mismatch.ts:136` and `:209` write
  `Discrepancy: classification.category`, whose values are defined in
  `src/domain/analysis/conflict-classification.ts` as `MATERIAL_AMOUNT_CONTRADICTION`,
  `AMBIGUOUS_FORMATTING`, `FEE_OR_TAX_VARIANCE`, `PARTIAL_PAYMENT`, `CURRENCY_MISMATCH`,
  `LIFECYCLE_STAGE_DIFFERENCE`, `SETTLEMENT_TIMING_DIFFERENCE`, `MATERIAL_DATE_CONTRADICTION`,
  `INTERMEDIATE_PROGRESSION`, `MATERIAL_STATUS_CONTRADICTION`, `CONSISTENT`. A person disputing a bank
  charge reads the row **`Discrepancy   MATERIAL_AMOUNT_CONTRADICTION`**, set in mono, inside the
  finding that is supposed to explain the problem to them.
- `src/domain/rules/definitions/response-overdue.ts:124` writes
  `'Date read by': dateWasRead ? \`${complaint.date.method} — unconfirmed\` : complaint.date.method`,
  where `method` is `ExtractionMethod` (`src/domain/models.ts:56`). It renders **`OCR — unconfirmed`**
  or **`DETERMINISTIC`**. `EXTRACTION_METHOD_LABELS` (`semantics.ts:254-259`) exists for this exact
  string and `case-analysis-panel.tsx:38-41` uses it correctly two files away.

**Provenance violation.**

- `finding-card.tsx:127-129` and `:500-502`:
  ```
  <Text variant="monoOverline" tone={tone} uppercase numberOfLines={1}>
    {ANALYSIS_LABELS[finding.resultType]}
  </Text>
  ```
  `ANALYSIS_LABELS` values are sentence-case prose — `'Cross-source statement discrepancy'`,
  `'Harassment / hostile tone detected'` (`src/domain/enums.ts:201-216`). Uppercased, letter-tracked
  and set in mono, a 34-character sentence becomes a truncated all-caps machine string: the card's
  headline **recreates the look of the enum member the docblock is proud of not showing**, and then
  clips it at one line. `label` or `overline` in sans is the correct variant; the mono scale means
  "this came off a document".

**Accessibility floor.**

- `finding-card.tsx:192-201` — "Show all {n}" is a bare `<Text onPress accessibilityRole="button">`.
  `caption` is 12/16.5, so the target is roughly **17pt tall against a 44pt floor** (`HIT_TARGET`), and
  it bypasses the app's `Pressable` (`Layout.tsx:233,313`) so it has no press feedback, no haptic and
  no minimum height. It is the control that reveals the rest of the evidence for a finding.

**Good.** `ReviewRow` (`:279-316`) — every action carries a hint written for a person, `Dismiss` goes
through `confirmDestructive`, and the provisional wording is reused from `PROVISIONAL_FINDING`
(`semantics.ts:287-297`) rather than re-invented.

### `case-analysis-panel.tsx` (410 lines)

**Token bypass — 22 raw spacing numbers and no token import at all.** The import list
(`case-analysis-panel.tsx:1-10`) pulls components from `@ui` and not one token. Every gap is inline:
`gap: 12` (`:65,124,324,333,364`), `gap: 8` (`:68,140,329,340`), `gap: 4` (`:150`), `gap: 20` (`:249`),
`gap: 14` (`:250,310,322,326`), `gap: 10` (`:288,302,326,384`), `gap: 6` (`:318,341,385`).

Three of those numbers — **6, 10 and 14 — are not tokens at all**; `SPACING` steps 4, 8, 12, 16, so
the panel's vertical rhythm alternates between on-grid and off-grid gaps down a single scroll. The
card at `:250` and the claim cards at `:310` use `gap: 14` while their sibling sections use `10` and
`12`, which is why the screen reads as assembled rather than laid out.

**Composition defects.**

- Roughly twenty `<View style={{ gap: N }}>` where `Stack gap="…"` is the primitive (`Layout.tsx:546`).
  The panel does not use `Stack` once.
- `case-analysis-panel.tsx:311-313`:
  ```
  <Row between align="center">
    <Chip label={ASSESSMENT_LABELS[claim.status]} tone={tone} size="sm" />
  </Row>
  ```
  A second `Row between` wrapping a single chip, the same defect as `finding-card.tsx:215`. Two
  instances of one mistake in one directory.
- `CitationList` (`:63-82`) renders **one bordered `Surface variant="sunken"` per citation**, and it is
  called from inside a `Surface` in four places in this file alone (`:317,324,327,392`) plus six other
  screens. `variant="sunken"` is *always* bordered (`Layout.tsx:110-112`), so a claim card with three
  citations is a hairlined box containing three hairlined boxes — the exact figure the `Surface`
  docblock names as *"the largest single contributor to the app reading as cheap"* (`Layout.tsx:81-99`),
  reproduced at the highest-traffic point in the product.

**Copy written from the system's side.**

- `case-analysis-panel.tsx:353` — `<Button label="Upload proof" …>` and `case-analysis-panel.tsx:283`
  — `<Button label="Add evidence" …>`. **Both navigate to `/case/[caseId]/upload`. Both can be on
  screen at once.** Two buttons, one destination, two names — and one of them uses "proof", which is on
  the removal list. `:335` uses it again as a heading: `"Evidence completeness & missing proof"`.
- `case-analysis-panel.tsx:272` — `<Notice title="Evidence Independence Warning" …>`. Title Case, in a
  file whose other three notice titles are sentences ("Sources have changed", "Analysis needs
  attention", "Assessment saved"). It is a category name from a spec, not something said to a person.
- `case-analysis-panel.tsx:368` — *"Factual assertions automatically extracted from your records.
  Promote any assertion to a case claim to have it formally verified."* The app cannot formally verify
  anything, and it says so 38 lines earlier at `:330`: *"It does not establish document authenticity,
  completeness, or a legal finding."* One screen makes and withdraws the same promise. "Promote" (also
  the button, `:396`) is a data-model verb.
- `case-analysis-panel.tsx:337` — *"Identified gaps across submitted records. Uploading corroborating
  documentation resolves these uncertainties."* Passive, and it overclaims: uploading a document may
  answer the gap, it does not resolve an uncertainty.
- `case-analysis-panel.tsx:266` — *"Derivative captures discounted from corroboration counts."* Four
  domain nouns and no verb a reader can act on.
- `case-analysis-panel.tsx:79` — *"Reprocess the evidence and run a new analysis."* "Reprocess" names
  the pipeline, and neither step is offered as a control here.
- `case-analysis-panel.tsx:304` — `{new Date(report.createdAt).toLocaleString()}` — a bare
  `9/15/2026, 4:31:09 PM` under a heading, with no label saying what the date is. `formatRelativeTime`
  (`src/ui/format.ts:144`) is what `case-card.tsx:121`, `evidence-row.tsx:192` and
  `seal-ribbon.tsx:144` all use for the same value.

**Leaked internals.**

- `case-analysis-panel.tsx:386` — `<Chip label={assertion.kind} tone="ai" size="sm" />`.
  `DiscoveredAssertion['kind']` is `'TRANSACTION' | 'BILLING' | 'STATUS' | 'COMMUNICATION' |
  'DISCREPANCY'` (`src/domain/analysis/evidence-intelligence.ts:26`), so **the chip reads
  `TRANSACTION`**. This file defines `SUGGESTION_KIND_LABELS` at `:13-19` for the neighbouring enum and
  writes a careful docblock at `:26-41` about never printing a raw `method` — then prints a raw `kind`
  in a violet chip 350 lines later.
- `case-analysis-panel.tsx:239` + `:277` — the panel puts a raw exception in front of the reader:
  ```
  setError(inner instanceof Error ? inner.message : 'Analysis could not start. Please retry.');
  …
  {error ? <Notice title="Analysis needs attention" message={error} tone="danger" /> : null}
  ```
  The fallback branch is the good sentence; the branch that actually fires shows `inner.message`.
  `ErrorState` exists with a `detail` prop for exactly this — *"Technical detail, shown only behind a
  disclosure"* (`Feedback.tsx:201-202`) — and its `message` is documented *"Never a raw stack trace or
  SDK error string"* (`Feedback.tsx:197`).
- `case-analysis-panel.tsx:278` — `message={latestJob.lastError || 'The last request failed…'}`. The
  same pattern again, from the job record. **Third instance in the layer** (with `activity.ts:30` and
  `evidence-row.tsx:205`); with `:239` that is four raw-error render sites.
- `case-analysis-panel.tsx:246` — `['PAYMENT_STATUS_CONFLICT', 'HARASSMENT_INDICATOR',
  'AMOUNT_MISMATCH', 'STATEMENT_DISCREPANCY'].includes(f.resultType)` — a component hand-listing enum
  members to decide what counts as a conflict. Not reader-facing, but it silently omits any rule added
  later, and `semantics.ts` is where that predicate belongs.

**Epistemic colour — a warning tone on an ordinary reading.**

`case-analysis-panel.tsx:258-262` — `tone={intelligence.independence.ratio < 1.0 ? 'warn' : 'ok'}`.
Any case where two documents share a source — two screenshots from one app, a statement and its PDF
copy — is *below 1.0*, which is the common case, and it gets amber. `tokens.ts:43-47` sets the rule in
the other direction (never style an uncertain finding as certain), and the corollary holds: a routine
reading styled as a problem trains the user to ignore amber everywhere else. The chip label also states
the same fact twice — `"2 of 3 sources independent (67%)"`.

**Provenance violation — the quotes themselves are in sans.**

`case-analysis-panel.tsx:69` renders the citation quote as `variant="bodySmall"`, and `:151` renders it
as `variant="caption"`. These strings are *verbatim passages lifted out of the user's documents* — the
single clearest case of the rule in `tokens.ts:56-70` and `Chip.tsx:9-15`, that mono means "this came
off a document". The app spends its mono scale on app-assigned state labels
(`claim-card.tsx:89`, `finding-card.tsx:127`, `case-card.tsx:89`) and then sets the actual document
quotations in the body face. `monoValue` / `mono` is what `:69` wants; `ProvenanceValue` is the
component.

### `ai-setup-notice.tsx` (39 lines) — clean, and the model the rest should copy

Reuses `EmptyState`, presents an unconfigured feature as a setting rather than a failure, names no
vendor and no model, and states what still works without it (`:35`). Two nits: the message uses a
hyphen where the app uses an em dash, and `icon="scale-balance"` reads as *legal/justice*, not as
*a feature that is switched off*.

### `index.ts` (2 lines)

Exports `ai-setup-notice` and `finding-card` and **not** `case-analysis-panel` — so eight screens reach
past the barrel (`app/(tabs)/insights.tsx:7`, `app/case/[caseId]/index.tsx:52`,
`app/case/[caseId]/graph.tsx:30`, `app/case/[caseId]/timeline.tsx:8`,
`app/case/[caseId]/claim/[claimId].tsx:9`, `app/case/[caseId]/evidence/[evidenceId].tsx:10`) while
their siblings come through it.

---

## `src/features/settings/`

The opposite of `analysis/`. Three of these four files are the standard the rest of the layer should
be held to, and one of them contains the fix for the layer's worst copy defect.

### `ai-key-section.tsx` (717 lines) — and the removal-list question, answered

**First, the forward reference from `evidence/` resolves as *not a defect*.** This panel names its
providers throughout — `'Groq'` / `'xAI (Grok)'` (`:117-120`), `${providerName} API key` (`:646`),
`'gsk_…'` / `'xai-…'` placeholders (`:667`), `Get a key from ${providerName}` (`:705`). That is **not**
an instance of the client's complaint. "Firebase Connected" and "Cloud Firestore" are infrastructure
tags surfaced as decoration on screens the user cannot act on; a provider name here is the address of a
website the user must physically visit to create the key the field is asking for (`:498-510` opens it).
Removing it would leave an instruction that cannot be followed. Leave it exactly as written.

**And the removal list is clean across this whole directory.** No model names are rendered, no "V1", no
prompt version, no confidence decimal, no UUID, no developer badge. The only occurrences of the words
"Firebase" and "Firestore" in `src/features/` are (a) comments in `auth-errors.ts:6,9,27` and (b) the
`INTERNAL_MARKERS` array at `auth-errors.ts:83`, which exists to *block* them from reaching a screen.

**Token bypass — two raw numbers in 717 lines, and one of them causes a visible jump.**

- `ai-key-section.tsx:521` — `<Shimmer width={54} height={24} radius="pill" />`, standing in for the
  `Chip` rendered at `:523-527`. A `size="sm"` chip is **26pt** tall (`Chip.tsx:74`, sized from the
  caption line box). So the placeholder is 2pt shorter than the thing it is holding space for, and the
  panel header shifts the moment the keystore read resolves — the exact jump the shimmer was added to
  prevent, and the file gets this right two lines later at `:535-536` by deriving the height from
  `theme.type.bodySmall.lineHeight`.
- `ai-key-section.tsx:103` — `const FIELD_HEIGHT = 46;` with the comment *"Matches the single-line
  field height in `Field.tsx`"*. Two files now own one number and nothing keeps them in step. `LAYOUT`
  has `rowHeight`, `tileSize`, `tileSizeLarge` and `tabBarHeight`; this is the entry it is missing.

**Composition defect — up to six controls in one card, and no hierarchy after the first.**

`ai-key-section.tsx:679-711` is a single `Row gap="sm" wrap` holding `Check and turn on` (primary),
`Stop` (ghost), `Keep the current key` (ghost) and `Get a key from ${providerName}` (ghost) — with
`Save without checking` (secondary) above it at `:572-588` and, in the replace flow, `Replace key` /
`Remove key` at `:619-639`. Three of the four in that row are visually identical ghosts wrapping into
ragged lines on a narrow phone, so the control that turns the feature on has to compete with a
documentation link. `Get a key from …` is not an action on this screen's subject; it belongs as an
inline link under the field's `hint` (`:668`), which already explains where the key comes from.

Smaller: `:599` and `:644` use `<View style={{ gap: theme.spacing.md }}>` where `Stack gap="md"` is the
primitive — the token is right, the component is not; and `:515` passes `radius="lg"`, which is
`Surface`'s default (`Layout.tsx:126`).

**Copy — the best in the app.** `statusLine` (`:260-271`) leads with what *does* work in every state,
including `'no-storage'`. `:471` says what is kept, not only what is lost. `probeProvider`
(`:214-251`) returns three distinct verdicts with a sentence for each and never a status code, and
`:429-436` is the only place in the layer that distinguishes "we could not check this" from "this was
refused" — which is the same distinction `tokens.ts:43-47` asks for and the same one
`case-analysis-panel.tsx:239` collapses. `describeShapeProblem` (`:153-181`) names the paste mistake
rather than reporting that one was made.

**Accessibility.** Both consequential buttons carry `accessibilityHint` (`:579`, `:685`). The On/Off
`Chip` uses `dot` plus the word, so colour is not the sole carrier (`:523-527`). One gap:
`:671-675`, the reveal `IconButton`, changes its `accessibilityLabel` with state but carries no
`accessibilityState={{ expanded: revealed }}` — the verb does most of that work, but
`Feedback.tsx:290` shows the pattern the app already uses.

### `toggle.tsx` (163 lines) — the best-built component in the layer

- **Accessibility exemplar.** `accessibilityRole="switch"`, `accessibilityLabel={label}`, the hint
  forwarded, and `accessibilityState={{ checked: value, disabled }}` (`:115-118`). The whole row is the
  target, so it grows with the OS font scale instead of clipping (`:16-21`) — the direct counter-example
  to `claim-card.tsx:231` and `finding-card.tsx:192`.
- **Reduced motion done correctly** (`:83-86`): the travel is removed, not slowed, and never skipped —
  *"no animation at all would leave the thumb lying about the state it represents."*
- **Uses the right one of the three accents.** The track fills with `colors.accent` (gold) at `:98`,
  which is structure, not a signal, and `:92-95` states why. Correct per the calibration.
- The raw geometry at `:50-54` is **not** a token bypass: the three numbers are derived from each other
  (`THUMB_SIZE`, `THUMB_TRAVEL`) and `:46-48` gives the reason not to tokenise — one consumer. This is
  what the raw numbers in `finding-card.tsx:513-544` would look like if they had been thought about.

### `auth-errors.ts` (152 lines) — the copy standard, and the unused fix

Thirty supplementary codes, each a sentence with a next step (`:43-76`); a **total** contract that
returns a human sentence for a bare string, a code with no message, `null` and `undefined`
(`:114-134`); and the one deliberately vague message documented as email-enumeration protection rather
than left looking like laziness (`:24-31`).

**And it already contains the fix for the layer's worst copy defect.** `looksInternal(message)`
(`:92-98`) tests for `'firebase'`, `'firestore'`, `'auth/'`, `'undefined is not'`, `'null is not'` and
an empty string. It is exported, it is tested (`tests/auth-errors.test.ts:78-88`), and **nothing outside
this module imports it** — `readableAuthError` is used only by `app/sign-in.tsx`. The four sites that
put a raw provider or pipeline string in front of a reader —
`case-analysis-panel.tsx:239`, `case-analysis-panel.tsx:278`, `evidence-row.tsx:205`,
`cases/activity.ts:30` — each need exactly this predicate, and it is sitting in the same layer with
tests around it.

One nit: `:68` — `'Sign-in was stopped by a check on our side. Contact support.'` There is no support
route in `app/` and no contact affordance anywhere in the product, so the sentence closes by naming an
action the user cannot take.

### `confirm.ts` (53 lines) — clean

A correct reason to exist (`Alert.alert` compiles on web and silently does nothing, `:4-8`), Cancel
first and marked `style: 'cancel'` so a hardware back press resolves to "do nothing" (`:48-49`), and
`confirmLabel` documented as never "OK" (`:26-31`). Its `message` prop doc — *"The place to say what is
**kept**, not only what is lost"* (`:24`) — is the sentence the whole layer's copy should be written
against; `ai-key-section.tsx:471` is the only call site that fully honours it.

**No barrel.** `settings/` has no `index.ts`, so `app/sign-in.tsx:76` reaches in by deep path.
Combined with `analysis/index.ts` exporting two of its three modules, the layer has three different
conventions for how a directory is entered.

---

## Ranked

The twelve most damaging problems in `src/features/`, worst first.

1. **A person disputing a bank charge reads `MATERIAL_AMOUNT_CONTRADICTION` and `OCR — unconfirmed`
   inside the finding that is supposed to explain the problem to them** — `finding-card.tsx:457-474`
   renders `finding.inputs` values with no mapping layer, so the enums written at
   `amount-mismatch.ts:136` and `response-overdue.ts:124` reach the screen verbatim, in mono, on the
   product's core artifact.
2. **Four screens render a raw exception or pipeline error string as the user-facing message of a
   Notice** — `case-analysis-panel.tsx:239` sets `inner.message` as the message and `:277` renders it
   (also `:278`, `evidence-row.tsx:205`, `activity.ts:30`), while `looksInternal`
   (`auth-errors.ts:92`) sits exported and tested in the same layer, unused by all four.
3. **A violet chip reads `TRANSACTION`** — `case-analysis-panel.tsx:386` passes
   `assertion.kind` straight to `Chip`, in the one file that defines a label map for the neighbouring
   enum forty lines from the top (`:13-19`).
4. **The app's one provenance guarantee is inverted: the actual quotations lifted out of the user's
   documents are set in the body face** (`case-analysis-panel.tsx:69`, `:151`) **while the mono
   scale is spent on labels the app assigned itself** (`claim-card.tsx:89`, `finding-card.tsx:127`,
   `case-card.tsx:89`) — so the typography claims document provenance exactly where there is none and
   drops it exactly where there is.
5. **The figure the `Surface` docblock calls "the largest single contributor to the app reading as
   cheap" is reproduced at the highest-traffic point in the product** — `case-analysis-panel.tsx:68`
   renders one always-bordered `variant="sunken"` box per citation inside an already-bordered card,
   across four call sites in that file and six other screens.
6. **`case-analysis-panel.tsx` imports twenty-two spacing values as literals and not one token**
   (`:250` is `gap: 14`), three of which — 6, 10 and 14 — are not on the 4pt scale at all, so the
   busiest screen in the app alternates between on-grid and off-grid rhythm down a single scroll;
   `finding-card.tsx:513-544` is the same failure with an off-grid `top: 14` inset against a
   `padding="xl"` card.
7. **The tab bar's real footprint is larger than the token four screens pad their content by** —
   `tab-bar.tsx:85` adds `insets.bottom * 0.5` (or 8pt) outside the `LAYOUT.tabBarHeight` box and
   `:249` pushes the compose disc 22pt above it, so the bottom of every tab screen sits under the bar
   again, which is the precise regression the comment at `:218-223` says was fixed.
8. **One action has four names, two of them on screen at once and pointing at the same route** —
   `case-analysis-panel.tsx:353` is `"Upload proof"` and `:283` is `"Add evidence"`, both navigating to
   `/case/[caseId]/upload`, with `"Add a file to get started"` (`upload-queue.ts:210`) and `"Add
   claim"` (`composer-sheet.tsx:258`) elsewhere — and "proof" is on the client's removal list, used
   again as a heading at `:335`.
9. **Four hand-rolled list rows at four different vertical rhythms, on screens a user swipes between**
   — `claim-card.tsx:232-237` pads by 11, `case-card.tsx:186-192` by 10, `finding-card.tsx:532-537` by
   12, `evidence-row.tsx:217-222` by `SPACING.lg`; `EvidenceRow` is the one to keep, and the `ListRow`
   primitive none of them should have needed is the missing piece of `@ui`.
10. **The control that reveals the rest of the evidence for a finding is a 17pt-tall piece of text** —
    `finding-card.tsx:192-201` is a bare `<Text onPress>` at `caption` size against a 44pt
    `HIT_TARGET`, bypassing the app's `Pressable` entirely, and the cards around it (`:154-174`,
    `claim-card.tsx:94`) dim on touch across areas that are not actually tappable.
11. **The home screen can render the string `"2 undefined"`** — `home-summary.ts:25-27` re-declares a
    lowercase copy of `ASSESSMENT_LABELS` and indexes it through `as keyof typeof labels`, so any
    stored status outside its four keys prints the word `undefined` into the first sentence a returning
    user reads.
12. **The Analysis screen promises verification and withdraws it 38 lines later** —
    `case-analysis-panel.tsx:368` says a promoted assertion will be *"formally verified"* and `:337`
    that uploading a document *"resolves these uncertainties"*, while `:330` states the app *"does not
    establish document authenticity, completeness, or a legal finding"*.

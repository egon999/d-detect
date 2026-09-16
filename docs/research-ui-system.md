> Historical working note. This records earlier research or defects and may describe behavior that has since changed. Current implementation and acceptance are documented in [PROJECT_SPEC](../PROJECT_SPEC.md), [ARCHITECTURE](../ARCHITECTURE.md), and [rebuild acceptance](rebuild-acceptance.md). Historical measurements and feasibility assumptions below are not current runtime guarantees.
# Ddetect — UI Research and Derived Design System

**Scope:** research + a paste-ready token system for a React Native evidence-analysis workspace.
**Audience:** an ordinary person in a dispute, not a lawyer. 10+ mixed documents about one situation.
**Constraints this document designs within:** RN 0.83 / Expo 55, flexbox only, no CSS grid, no hover as a primary affordance, no `position: sticky`, 360–412dp phone, dark **and** light, WCAG AA, 44dp touch targets, reduce-motion respected, `react-native-reanimated` unavailable (no babel config), `Animated` + `expo-linear-gradient` only.

---

## 0. How to read this

**Verification status is marked throughout.** I did not want to hand over a palette that "feels premium".

- **[MEASURED]** — I computed it. Contrast ratios come from the WCAG 2.1 relative-luminance formula with no rounding; font metrics come from parsing the actual TTFs in `node_modules/@expo-google-fonts/`.
- **[PROD]** — read out of a vendor's shipped CSS/JS bundle or published npm token package. Ground truth for what that product actually renders.
- **[DOCS]** — the vendor says so in writing. Official, usually unitless.
- **[INFER]** — my reasoning. Called out so you can disagree with it.

**Every colour pair in §2 states its measured ratio.** The final audit is 163 checks, 0 AA failures.

### 0.1 The diagnosis: why the current theme reads "cheap"

Before proposing anything, the specific defect. The current `src/ui/tokens.ts` sets:

```
darkColors.canvas = royal950  #070D21     OKLCH  L=6.1  C=0.045  H=268.3°
darkColors.accent = royal400  #3D7BFF     OKLCH  L=59.6 C=0.196  H=262.9°
```

**The accent is 5.4° of hue away from the background.** [MEASURED]

That single number explains most of the verdict. An accent that shares its background's hue can only differ from it by lightness and saturation, so nothing on screen ever reads as *a different kind of thing* — it reads as the same blue, brighter. Every attempt to create hierarchy then has to be made with something else, which is where the borders, the cards, the glows and the gradients come from. They are compensation for a palette that cannot separate figure from ground.

Corroborating evidence that this is the actual failure mode, not a taste dispute: **Stripe's brand colour `#635bff` appears exactly twice in 3.5 MB of shipped Dashboard CSS** [PROD]. The working accents are `#5469D4` and `#0570DE`, and the brand colour is functionally absent from the data UI. **Linear's brand `#5e6ad2` survives in the product only as a caret colour, a focus ring, and a `color-mix` base** [PROD]. Serious data products do not paint with their brand colour. Ddetect currently does, in the one hue it also uses for the canvas.

The rest of this document is built on the consequence: **the accent must leave the blue family entirely, and it must be rationed.**

---

# 1. Research findings

## 1.1 Investigation / e-discovery

### Everlaw — three states, zero hue

Everlaw's coding panel distinguishes three states of a code with **no colour at all**:

| State | Encoding |
| --- | --- |
| Not applied | grey fill |
| Applied | white fill |
| **Changed this session** | **dotted outline** |

Fill inversion carries the binary; **stroke style** carries the temporal third state. This is the cheapest possible encoding of "provisional vs settled" and it survives greyscale, colour-blindness, and a 3-inch screen. Ddetect needs exactly this third state for AI suggestions that have not yet been accepted or rejected, and §4 uses it.

Everlaw also renders **Coding History as a table column**, not a modal — provenance is a field of the record, not a detour. And `And # more` expands **inline in the same cell** rather than opening anything.

### Nuix — weight as read-state

**Bold = unviewed**, with a 2-second dwell threshold before an item is marked read. Weight is a free channel most products waste. Ddetect can mark unreviewed findings this way and get read-state tracking without a badge, a dot, or a colour.

### Relativity / Logikcull — the persistent-context rule

The document viewer never loses the coding panel. In an evidence product the artifact and the judgement about it are co-resident; you never navigate away from the thing you are judging in order to record the judgement. This drives the finding-detail layout in §3.2 — the snippet and the verdict are on one screen.

## 1.2 Security / SOC

### Splunk — severity is ink, never fill

The single most transferable line in this entire research is a token restriction, not a colour:

> Splunk's severity tokens declare `cssProperties: color, fill` — **not** `background-color`. [PROD]

Severity is permitted to colour **text and glyphs only**. It may not become a row background. This is why SOC consoles stay readable at 200 rows while consumer dashboards turn into a traffic light at 20.

Splunk also **rotates hue at the top of the scale** rather than only increasing saturation: Alert `#CC2D37` → Critical `#C2306F` → Emergency `#B53394`, red drifting to magenta. Escalation is a hue journey, not a brightness journey, so the top of the scale is still distinguishable when everything is already red.

And: **Status and Disposition are orthogonal axes.** "Is anyone working on this?" and "What turned out to be true?" are different questions and get different controls. Ddetect's `FindingStatusEnum` (OPEN/REVIEWED/DISMISSED/RESOLVED) and `ClaimStateEnum` (SUPPORTED/CONTRADICTED/UNSUPPORTED/MIXED_REVIEW) are exactly this pair and must never be merged into one chip.

### Elastic Security — no cell borders at all

EuiDataGrid ships with `border: 'none'` and `header: 'underline'` as the recommended configuration [PROD]. Rows are separated by rhythm and a single header rule; **cells are separated by nothing**. Elastic runs one of the densest tables in commercial software and it has no grid lines.

Session View draws **a red line to the left of the event that caused the alert** — causality gets a rail, not a highlight, so the text stays readable.

### Datadog — three findings that matter here

1. **Chips are a three-part token: `base` / `contrast` / `soft`.** The chip fill is `soft`, the text is `contrast`. Never a saturated mid-tone with white text. [PROD]
2. **Text hierarchy by alpha, not by hex.** Dark-mode body text is 76% white, not 100%. [PROD]
3. **Hairlines drawn as `inset 0 -1px box-shadow`**, so a border never changes layout. [PROD]
4. **Dashed outline for inferred spans** — when hue is already spent on service identity, stroke style carries "this was inferred, not observed". Same mechanism as Everlaw, arrived at independently.
5. **Watchdog uses a pink binoculars glyph** — a dedicated mark for "the AI has something to say", deliberately **off the status colour scale**. It cannot be confused with a severity because it is not on that axis. This is direct precedent for §4's treatment of AI provenance.

### Sentry — weight ceiling

Nothing in Sentry's UI exceeds font-weight 500. Elastic's EUI stops at 600. Suspect-commits resolves an exact file+line through git blame, filters by recency, and names an author and a PR — **a reasoning chain rendered as a chain, not as a confidence score.**

## 1.3 Document / data-heavy productivity

### Linear — the status glyph grammar

Linear's status icons take **`color` as a prop** sourced from a user-configurable workflow colour. The glyph *shape* is the only fixed carrier of meaning. [PROD]

| State | Ring | Fill | Knockout |
| --- | --- | --- | --- |
| Backlog | **dashed** — 12 filled trapezoids, 15° mark / 15° gap, r5→r7 | none | — |
| Todo | solid 1.5px, r=6 | none | — |
| In Progress | solid 1.5px, r=6 | **partial pie, r=3.5** | — |
| Done | none (disc to r=7) | full | ✓ |
| Canceled | none (disc to r=7) | full | ✕ |
| Triage | none (disc to r=7) | full | ⇥⇤ |

**Progress reads as fill percentage.** 0% dashed → 0% outlined → n% pie → 100% solid. Terminal states drop the ring entirely (it is no longer a container waiting to be filled) and gain a semantic mark. The set is legible at 14px, in greyscale, and after arbitrary recolouring. Ddetect's `ProcessingStateEnum` is a progress ladder with terminal states and maps onto this structure almost one-to-one (§3.5).

Linear's priority glyphs add the other half of the idea: **unfilled bars render at `fillOpacity: 0.4`, not absent.** The silhouette is constant across Low/Medium/High; only the ratio changes. The column never jumps, and you always see the scale you are reading against. This is the correct way to render a 4-band confidence indicator (§4.3).

Other Linear specifics worth taking:

- **Row height is a constant, 40px, with no density control.** [PROD] The compression affordance is a **field-visibility list**, not a row-height slider. [DOCS] You compress by removing columns.
- **`--border-hairline: 1px`, redefined to `.5px` at DPR ≥ 2** by a single media query. [PROD] One token, one query, and every border in the product becomes a true single device pixel. RN gives this for free as `StyleSheet.hairlineWidth`; use it and never write `borderWidth: 1`.
- **Borders drawn as `inset box-shadow`** where layout must not shift, and **translucent** (`#ffffff0d`, 5% white) so one token is correct on every surface level.
- **`--speed-highlightFadeIn: 0s` / `--speed-highlightFadeOut: .15s`.** [PROD] Feedback appears instantly; only the *removal* animates. This is most of why Linear feels fast, and it costs nothing.
- **Dark mode is shadowless.** Base shadows are `0px 0px 0px transparent`; depth is pure value-stepping across `#08090a / #0f1011 / #141516 / #191a1b`.
- The design refresh post states the border problem in the client's own words: borders *"had quietly proliferated across the platform, sometimes appearing without clear reason."* And the closing line, which is the standard this document is trying to hit: *"If most people don't immediately notice what changed, that's probably a good sign."*

### Notion — shape as a one-bit type signal

Select chips are 20px-tall **3px-radius rectangles**. Status chips are 20px-tall **pills**. Same palette, same size. **The property *type* is encoded in the corner radius alone.** [PROD] A workflow state is separable from an arbitrary tag at a glance, for the price of one border-radius value.

Notion table cells **wrap by default** (`white-space: normal; word-break: break-word`); the `-nowrap` ellipsis variant is the opt-out. This is the inverse of Linear and Airtable. Notion's auto-ID field is deliberately dimmed to 50% so IDs recede.

### GitHub Primer — the border rule, and one rule I am going to override

Primer does not publish a page called "borders vs backgrounds", but the rule exists across four statements [DOCS]:

> "The first six steps of the neutral scales are typically used for background colors... All contrast values for text and borders are calculated against `bgColor-muted`."
> "Steps 7 and 8 are typically used for borders and dividers... Step 8 is considered the minimum contrast value for interactive control borders."
> **"If a softer background color must be used, make use of borders around elements to increase contrast."**
> **"Borders of an input must meet a contrast ratio of 3:1... Inputs without visible borders must use their background color instead. In this case, the required contrast ratio is 3:1."**

That last one is the important one and it is the foundation of §2.11. **A border and a background fill are substitutes discharging the same 3:1 obligation under WCAG 1.4.11.** The choice between them is therefore not a preference — it is determined by whether the fill already clears 3:1 against its parent. If it does, the border is redundant and must be removed. That converts the client's stated dislike of borders from a taste into a testable rule.

Primer also states the nesting convention: **outer containers get the stronger border, internal separators the weaker one**; and the don't-over-divide rules — *"Don't use dividers to separate individual items"*, *"make sure they truly make the presented information easier to parse, instead of only increasing visual clutter."*

**Primer's DataTable guidelines**, which drive §3.3 [DOCS]:

- **"It's easier to scan many rows than it is to scan many columns."**
- **"Consider swapping columns and rows when it's unlikely that there will ever be more rows than columns."**
- Use a list, not a table, **"when there are columns where the cells will usually be empty."**
- **"Avoid wrapping or truncation of cell content as much as possible. Cells should represent data in the shortest possible format."**
- **"Right-align numeric values and use the `tabular-num` font variant when possible."**
- Small screens: "Use the column width options", "Remove less important columns", "Scroll horizontally".
- And the one I override: **"You may show a message to explain an absence of data. Just don't use a character like 'x' or '-'."**

> **Override, stated explicitly.** Primer's empty-cell rule is written for tables where absence is *noise* — a nullable field nobody asked about. In Ddetect absence is *signal*: a missing value is a finding (`MISSING_EVIDENCE`), and "no document mentions the payment date" is one of the four things the product exists to tell you. A blank cell in Ddetect's matrix would be indistinguishable from a rendering failure. **Ddetect therefore renders absence as an explicit glyph, and accepts Primer's rule everywhere else.** [INFER]

### Polaris — the padding rule, and a conflict with Primer

> **"The general rule is that the deeper an element is nested, the smaller its padding is."** [DOCS]
> "Don't use padding to create space between elements. Instead, use block stacks."
> "Avoid too many call-to-action buttons or links and only one primary call to action per card."
> "Don't allow cards to become so tall that they are difficult to overview."
> On when *not* to use a card: "For more flexibility on styling, use the Box component."
> Badge copy: **"Always describe the tone in the past tense. For example, refunded not refund."**

And, directly contradicting Primer:

> **"Wrap instead of truncate content. This is because if row titles start with the same word, they'll all appear the same when truncated."**

**Resolution for Ddetect:** Polaris wins for document names, Primer wins for values. Real-world evidence filenames genuinely do collide on their prefixes — `Invoice_ACME_2024_03.pdf`, `Invoice_ACME_2024_04.pdf`, `Invoice_ACME_2024_signed.pdf`. Truncating those produces three identical rows. So **document titles wrap to two lines; extracted values never wrap and never truncate, because they are short by construction.** [INFER]

## 1.4 Finance / audit

This group produced the single most valuable material for Ddetect, because "do these two records agree?" is literally its product question.

### Expensify — agreement should render as *nothing*

Expensify's merge logic is open source, so the rule can be read rather than inferred:

```js
// src/libs/MergeTransactionUtils.ts
if (isTargetValueEmpty || isSourceValueEmpty || targetValue === sourceValue) {
    // auto-resolve silently
} else {
    conflictFields.push(field);
}
```

**Fields that agree are resolved silently and never shown.** The wizard's step count equals the conflict count. Their own FAQ confirms it: *"Why was I not asked to choose which expense details to apply? If both expenses already have the same details, the final expense keeps those values automatically."* [DOCS]

This is the answer to the hardest layout question in the brief. **Do not build a two-column diff of the whole record. Build a conflict list.** The UI surface area should be proportional to the *disagreement*, not to the record. A ten-document case where everything agrees should produce a nearly empty screen and one line of confirmation.

Expensify also encodes **field authority**: when merging a manual entry with an imported card transaction, **the bank record is authoritative for amount and currency regardless of what the user typed.** Not every field is a free choice. For Ddetect: the original artifact outranks any transcription, OCR output, or derived value — which is exactly what `ExtractionMethodEnum`'s stated precedence (`MANUAL > DETERMINISTIC > AI`) already encodes, and the UI must show it rather than presenting an authoritative value as a 50/50 choice.

And the violation vocabulary, which is a masterclass in copywriting for this product:

```
"Amount greater than scanned receipt"          ← states the SIGN and names the AUTHORITY
"Date differs from scanned receipt"            ← names the AUTHORITY
"Can't auto-match receipt due to broken bank connection."  ← blames the SYSTEM, not the record
"Awaiting merge with card transaction."        ← a pending state with a named cause
"Potential duplicate"
```

Compare with the useless generic every product defaults to: *"Mismatch."*

Expensify is also the only **mobile-first** product in this research, and its rows are `tableRowHeight: 56`, `optionRowHeight: 64` [PROD] — a useful correction against naively copying Linear's 40px desktop row onto a phone.

### Ramp — "couldn't verify" is a third state, and it is grey

Ramp publishes its matching rule verbatim [DOCS]:

> "1. The amount **must** match. 2. The date **OR** the merchant must match."
> Date tolerance: "within one calendar day before or after."

**One hard gate plus an OR over the soft fields.** Publishing the rule is itself the design decision — users trust a stated rule far more than a confidence score.

The visual language is the important part. Verified and unverified use **the same popover, the same three rows, the same glyph slot**. Only the glyph and the verb change:

```
✓ Verified amount          (green #3D7441)
✕ Couldn't verify amount   (GREY #6D6A68)
```

**The failure state is grey, not red.** And the copy is *"Couldn't verify X"*, never *"X doesn't match."* That is a claim about the system's confidence, not an accusation about the record.

This gives Ddetect its epistemic spine — **three registers, not two:**

| Register | Meaning | Colour |
| --- | --- | --- |
| **Agrees** | Established as matching | green, quiet |
| **Couldn't establish** | Neither confirmed nor refuted | **grey / neutral** |
| **Disagrees** | Established as conflicting | red, and *only* here |

Most products collapse rows 2 and 3 and end up crying wolf on every unparsed field. Corroborated independently by Mercury's dedicated `--ds-text-money-pending-or-null` token, Carbon's `caution-undefined` (a distinct colour for "severity could not be determined"), and QuickBooks' "Uncategorized" fallback buckets. **Four products independently gave the epistemic state its own token.**

Three more Ramp patterns, all directly applicable:

- **Normalized value with the raw source disclosed beneath, plus a copy icon.** The merchant renders as **Jackpocket**, with the raw descriptor **JACKPOCKET** in grey caps directly below. The cleaned value, the evidence for it, and the ability to take the evidence, in one two-line cell. This is §3.4's field pattern, copied verbatim.
- **Per-field outline flag icons attached to individual field labels** — not a row banner, not a page alert. If one field is in question, exactly one field is marked.
- **"⛊ Auto-Approved by Policy" rendered as a shield glyph + plain text. No pill, no badge.** A machine decision is stated, not celebrated.
- Popover footer: **"Report incorrect receipt verification."** The system admits it can be wrong, inline, at the point of the claim. (This is HAX G9, *Support efficient correction*, implemented in one link.)

Ramp ships **IBM Plex Sans and IBM Plex Mono** — the exact fonts already installed in this project.

### QuickBooks — the difference must reach zero

> "Scroll to the bottom and make sure that the difference is zero." [DOCS]

A running, always-visible scalar that updates as you select, acting as a **hard exit gate**. It converts an abstract "do these agree?" judgement into a number you drive to $0.00. Nothing else in this research is as effective, and Ddetect has a direct analogue: an amount conflict has a delta, and that delta should be a first-class rendered value (§3.2), not something the user computes in their head.

Two more:

- **The Action column offers exactly two verbs: "Add" vs "Match."** The entire reconciliation model compressed to a binary, with a one-to-many picker behind "Match".
- **The green match symbol, where *absence* is the signal.** *"Ideally, you want all of the transactions to have a match symbol next to them."* You scan for the gaps, not for the marks. This is precisely how Ddetect's comparison matrix should be read (§3.3).

### Stripe — selection is a border, never a background

```css
.db-EventAndLogsSection-timeline-border-selected{
  border: 1px solid var(--sail-blue500);
  box-shadow: 0 2px 5px #32325d1a, 0 1px 1.5px #00000012;
  transition: border-color .5s }
```

**Selection = border colour change + elevation, not a background highlight.** [PROD] Critical for an evidence UI: a background highlight recolours the content you are trying to read. And the `.5s` transition is deliberately slow — this is a state you are *reasoning about*, not a hover.

Other Stripe findings:

- **Gradients are 1.11% of Dashboard CSS rules, and zero of them are in tables, rows, badges or detail layouts.** [PROD] The rule is absolute: no gradients in data UI.
- Shadows are always two layers with a **tinted ambient**: `0 2px 5px rgba(60,66,87,.08), 0 1px 1px rgba(0,0,0,.12)`. The blue-grey ambient is why they look like paper rather than a filter.
- `--sail-font-weight-bold: 500`. Not 700.
- `.PropertyListItem-status { margin: -2px -4px }` — negative-margin an inline badge so it doesn't inflate the row height. A one-line fix for the most common metadata-grid ugliness.
- **Dashboard-initiated mutations are logged as API requests carrying `source: Dashboard`.** Human and machine actions land in the *same* log, distinguished by a field. This is the correct model for an evidence chain of custody.
- **Logs do not auto-refresh** — "Click Refresh logs." An audit surface that mutates under you is unreadable.
- IDs render in **monospace by field type** (`type: "id"` → mono). Linear deliberately does *not* mono its IDs, because they are short, prefixed and sit in a fixed 72px slot. **The deciding variable is ID length and variability.** Ddetect's IDs come from arbitrary third-party documents, so they are long and variable → mono.

### Mercury — red is reserved for errors

```
--ds-text-money          #363644  (LIGHT)  /  #f4f5f9  (DARK)   ← the DEFAULT is neutral
--ds-text-money-in       #036e43           /  #77c599
--ds-text-money-out      #b0175f           /  #fc92b4           ← MAGENTA, not red
--ds-text-money-pending-or-null  #70707d   /  #c3c3cc
```

Three deliberate decisions [PROD]: money is **neutral by default** and only coloured when direction is semantically relevant; **money-out is magenta because red is reserved for errors — a debit is not an error**; and "we don't know yet" gets its own token.

Mercury's status backgrounds are **the badge text colour at 10% alpha** — derived, not separately designed. Guaranteed on-hue on any surface, and cheaper to maintain. Ddetect's tinted fills use the same architecture at 0.14 (dark) / 0.08 (light).

## 1.5 The transferable rules, consolidated

Fourteen rules that survived across products, each with at least two independent sources.

| # | Rule | Sources |
| --- | --- | --- |
| 1 | **Severity colours text and glyphs. Never a row background.** | Splunk (token restriction), Elastic, Linear |
| 2 | **Agreement renders as nothing.** Surface area ∝ disagreement. | Expensify (algorithm), QuickBooks |
| 3 | **"Couldn't establish" is a third state and it is grey.** | Ramp, Mercury, Carbon, QuickBooks |
| 4 | **Shape carries meaning; colour is decoration.** | Linear (glyph grammar), Notion (pill vs rect), Primer (filled vs outlined) |
| 5 | **Stroke style carries "provisional".** | Everlaw (dotted = changed), Datadog (dashed = inferred) |
| 6 | **Chip = soft tinted fill + same-hue dark text.** Never saturated fill + white text. | Datadog, Notion, Airtable (in code), Stripe, Mercury, Carbon |
| 7 | **Borders are alpha overlays of one ink at 2–3 intensities**, not opaque greys. | Linear, Notion, Mercury, Atlassian |
| 8 | **Hairlines are DPR-aware.** 1px → 0.5px at 2×. | Linear (`--border-hairline`); RN gives it free as `hairlineWidth` |
| 9 | **Don't divide individual items.** Dividers group; rhythm separates. | Primer, Polaris, Linear's own refresh post |
| 10 | **Selection = border + elevation, not background.** | Stripe (explicit), Everlaw |
| 11 | **No gradients in data UI.** | Stripe (1.11%, zero in data), Linear (flat compositing only), Notion (scroll masks only) |
| 12 | **Brand colour ≠ UI accent.** | Stripe (2 occurrences / 3.5 MB), Linear (caret + focus ring only) |
| 13 | **Weight ceiling of 500–600 in data UI.** | Stripe (bold=500), Airtable (strong=500), Sentry (≤500), EUI (≤600) |
| 14 | **The record and its event log are peers**, and the log does not auto-refresh. | Stripe (Events and logs), Ramp (Overview/History), Everlaw (Coding History as a column) |

**Row heights converge on three values:** 32 (spreadsheet-dense), 40 (desktop app list — Linear *and* Stripe independently), 48 (comfortable with a chip). The only mobile-first product measured, Expensify, uses **56 / 64**. Ddetect is mobile; §2.9 follows Expensify, not Linear.

---

# 2. Derived tokens

## 2.1 Method

The palette was solved, not chosen.

1. Work in **OKLCH**, where lightness is perceptual and hue is stable under lightness changes. Verified round-trip exactness on five reference colours before use.
2. For each semantic ink, fix a hue and chroma, then **binary-search lightness until the contrast against the target background lands exactly on 4.5:1** (or the chosen headroom), with automatic sRGB gamut mapping by chroma reduction.
3. Verify with the WCAG 2.1 formula — relative luminance `L = 0.2126R + 0.7152G + 0.0722B` on linearised channels, ratio `(L1 + 0.05) / (L2 + 0.05)` — **and never round up.** 4.48 fails.
4. For anything sitting on a tinted fill, **alpha-composite first and solve against the blend**, not against the nominal surface. This step is where most hand-picked palettes fail.

**Why everything is solved to 4.5:1 and not 3:1.** WCAG's "large text" exemption requires ≥24px, or ≥18.66px **bold** — and the spec does not fix a numeric weight for "bold", so anything below 700 is arguable. In the type scale below, only `display` (28/700) is unambiguously exempt; `title` (22/600) is arguable and `heading` (18/600) fails the size floor outright. Every other role in a data-dense UI — body, label, caption, mono — must clear 4.5:1 regardless. **So the whole palette is solved to 4.5:1 and nothing depends on the exemption.** Designing to 3:1 and then discovering this is the standard way to ship an inaccessible theme.

## 2.2 Background elevations — dark

Royal hue **258°**, held constant, chroma tapering as lightness rises so the top surfaces don't go plastic.

| Token | Hex | OKLCH L | Contrast vs. `bg` | Role |
| --- | --- | --- | --- | --- |
| `bgSunken` | `#060E1B` | 12.6 | 1.08 | Behind scroll content; the matrix's frozen-label gutter |
| `bg` | `#0D1727` | 20.4 | — | **The canvas.** Every screen's root |
| `bgRaised` | `#182334` | 28.9 | 1.14 | Sheets, the app bar when scrolled |
| `surface` | `#212D3F` | 35.5 | 1.29 | Rows, list containers, the one card that survives |
| `surfaceAlt` | `#2E3A4C` | 43.4 | 1.21 (vs `surface`) | Inputs, code/snippet blocks, selected row |

Adjacent steps are 1.08 / 1.14 / 1.29 / 1.21. Wide enough to see, narrow enough not to look striped. `bgSunken` exists so there is a level *below* the canvas — without it, a scroll container behind content has nowhere to go and you end up drawing a border instead.

## 2.3 Background elevations — light

| Token | Hex | Contrast vs. `bg` | Role |
| --- | --- | --- | --- |
| `bgSunken` | `#E9EDF4` | 1.09 | Behind scroll content |
| `bg` | `#F4F7FB` | — | The canvas |
| `bgRaised` | `#FFFFFF` | 1.08 | Sheets, app bar |
| `surface` | `#FFFFFF` | 1.08 | Rows, containers |
| `surfaceAlt` | `#EEF2F7` | 1.05 | Inputs, snippet blocks, selected row |

`bgRaised` and `surface` are the **same white**, exactly as Atlassian and MD3 do it. In light mode elevation is carried by shadow and border, not by value; a "slightly whiter white" does not exist. This is not a gap in the ladder — it is what the ladder correctly degenerates to.

## 2.4 Text

**Dark**

| Token | Hex | on `bgSunken` | on `bg` | on `bgRaised` | on `surface` | on `surfaceAlt` |
| --- | --- | --- | --- | --- | --- | --- |
| `textPrimary` | `#E8EDF5` | 16.44 | **15.28** | 13.44 | 11.82 | 9.78 |
| `textSecondary` | `#C2CBD7` | 11.80 | **10.96** | 9.65 | 8.48 | 7.02 |
| `textTertiary` | `#9BA3AD` | 7.58 | **7.05** | 6.20 | 5.45 | **4.51** |

**Light**

| Token | Hex | on `bgSunken` | on `bg` | on `bgRaised`/`surface` | on `surfaceAlt` |
| --- | --- | --- | --- | --- | --- |
| `textPrimary` | `#161F2D` | 14.10 | **15.41** | 16.56 | 14.73 |
| `textSecondary` | `#454F5E` | 7.06 | **7.72** | 8.29 | 7.37 |
| `textTertiary` | `#636C7B` | **4.51** | 4.93 | 5.30 | 4.72 |

`textTertiary` is solved to land at exactly 4.51 on its **worst** background in each scheme, so it is never the thing that fails. It has no headroom by design — which is why §2.6 gives the neutral chip its own token rather than reusing it.

**`textPrimary` is deliberately not `#FFFFFF`.** Pure white on a near-black OLED panel halates — the glyph edges bloom and thin strokes smear. `#E8EDF5` still measures 15.28:1, four hundred percent past the requirement, and renders cleanly. Datadog reaches the same conclusion by a different route: 76% white rather than 100%.

## 2.5 Hairlines

| Token | Dark | ratio vs `bg` | Light | ratio vs `bg` | Rule |
| --- | --- | --- | --- | --- | --- |
| `hairline` | `#353C45` | 1.61 | `#A9AEB6` | 2.08 | Decorative separation. **No contrast minimum applies** — a divider conveys no information. |
| `hairlineStrong` | `#5D646D` | **3.00** | `#8B8F97` | **3.02** | Any border that is the *only* thing defining an interactive control's boundary. Meets WCAG 1.4.11. |

Two intensities, not six. Width is always **`StyleSheet.hairlineWidth`**, never `1`. On a 3× Android phone that renders one device pixel (≈0.33dp); on 2× it renders 0.5dp. This is Linear's `--border-hairline` media query, already built into the platform, and it is the single highest quality-per-character technique available.

## 2.6 Semantic tones

Five inks. **`info` has been deleted** — see §5.4 for why.

**Dark** (all ratios against `bg` `#0D1727`)

| Token | Hex | OKLCH H | on `bg` | on `surface` | on `surfaceAlt` |
| --- | --- | --- | --- | --- | --- |
| `conflict` | `#FF7D75` | 25.3° | **7.22** | 5.58 | 4.62 |
| `warn` | `#F48A34` | 55.1° | **7.30** | 5.64 | 4.67 |
| `accent` (gold) | `#D4AF37` | 91.1° | **8.54** | 6.61 | 5.47 |
| `ok` | `#46BD69` | 149.9° | **7.48** | 5.78 | 4.79 |
| `ai` (violet) | `#B397FF` | 294.9° | **7.52** | 5.81 | 4.81 |
| `neutral` | `#A4ABB6` | 259.4° | **7.77** | 6.01 | 4.97 |

**Light** (against `bg` `#F4F7FB`)

| Token | Hex | on `bg` | on `surface` | on `surfaceAlt` |
| --- | --- | --- | --- | --- |
| `conflict` | `#B6252B` | **5.94** | 6.39 | 5.68 |
| `warn` | `#974C00` | **5.83** | 6.27 | 5.58 |
| `accent` (gold) | `#7A6000` | **5.58** | 6.00 | 5.34 |
| `ok` | `#006F31` | **5.89** | 6.33 | 5.63 |
| `ai` (violet) | `#7147C0` | **5.81** | 6.24 | 5.55 |
| `neutral` | `#5B616B` | **5.80** | 6.24 | 5.55 |

### 2.6.1 Hue separation, evaluated per co-occurrence set

A naive whole-palette check gives a worst pair of **29.8°** (`conflict`/`warn`), which looks like a defect. It isn't, because those two never appear on the same screen. **Hue separation only has to hold within a set of colours that can co-occur.** [MEASURED, INFER on the framing]

| Surface | Hues present | Minimum separation |
| --- | --- | --- |
| Findings list, finding detail, matrix, evidence detail | conflict, accent, ok, ai | **58.8°** |
| Upload / processing | warn, accent, ok | 36.0° |

The one tight pair is `warn`/`accent` at 36° on the processing screen. Mitigation: **gold is banned from the processing screen.** Retry and Cancel are neutral outlined buttons there. The orange is a status glyph, the gold would have been a filled button — different shapes, different roles — but the cleanest fix is simply not to put them together.

For reference, the old theme's accent/canvas separation was **5.4°**.

### 2.6.2 The gold problem, and why gold is dark-mode-only as an ink

Metallic gold `#D4AF37` measures **8.54:1 on the dark canvas** and **2.10:1 on white** [MEASURED]. On white it fails even the 3:1 non-text floor. Forcing gold to 4.5:1 against white yields `#8F7400` — an olive-bronze that is no longer recognisably gold.

**Therefore:**
- **Dark mode:** gold is a text and glyph colour. `#D4AF37`.
- **Light mode:** gold is a *non-text* accent only — a 3dp rail, a 2dp focus ring, a filled button's background under white text. Where gold must carry text in light mode it becomes `#7A6000` (5.58:1), which reads as a dark brass and is honest about what it is.

Do not attempt one gold for both schemes. The two schemes need different colours to express the same idea, which is what a semantic token layer is for.

### 2.6.3 Tinted chip fills — and the rule that came out of failing to make them work

Chips use `tone.ink` at alpha over the parent, per rule #6 in §1.5.

| Scheme | Fill alpha |
| --- | --- |
| Dark | **0.14** |
| Light | **0.08** |

Light is 0.08, not 0.10, because at 0.10 the accent measures **4.48:1** on its own composited fill — and WCAG forbids rounding up.

**The rule that matters:** when text is placed on its own tinted fill, the contrast must be computed against the **composite**, not the nominal surface. Solving against the surface and hoping is how palettes fail in production. Every tone below is verified against its own blend:

**Dark, `ink` on `ink @ 0.14` over each surface — minimum ratio across all four permitted surfaces**

| Tone | min ratio on fill |
| --- | --- |
| conflict | 5.02 |
| warn | 5.06 |
| ok | 5.18 |
| ai | 5.21 |
| accent | 5.87 |
| neutral | 5.44 |

**`surfaceAlt` is excluded, and that exclusion is a design rule, not a workaround.**

On `surfaceAlt` the composited fills bottom out at **3.80:1** and no colour choice fixes it — the surface is simply too close in lightness to the tint. Rather than invent a second set of chip colours, the rule is:

> **Tinted tone fills are permitted on `bgSunken`, `bg`, `bgRaised` and `surface`. They are forbidden on `surfaceAlt`. On `surfaceAlt` the tone is carried by text and glyph only.**

`surfaceAlt` is where inputs, snippet blocks and selected rows live — the densest, most-read regions of the app. The accessible answer turns out to be the quieter one, which is the outcome the brief asked for.

## 2.7 The full contrast audit

```
DARK   50 ink×background pairs                 0 below 4.5
DARK   24 ink-on-own-tinted-fill composites    0 below 4.5
LIGHT  50 ink×background pairs                 0 below 4.5
LIGHT  24 ink-on-own-tinted-fill composites    0 below 4.5
       hairlineStrong  dark 3.00  light 3.02   meets 1.4.11
       gold on dark bg 8.54 · gold on white 2.10 (why light-mode gold is non-text)
──────────────────────────────────────────────────────────
TOTAL CHECKS  163        TOTAL AA FAILURES  0
```

## 2.8 Typography

### 2.8.1 Font role assignment

Three faces are installed. Two of them should be used.

| Role | Face | Why |
| --- | --- | --- |
| **UI text** — everything | **IBM Plex Sans** | See below |
| **Values** — amounts, IDs, hashes, ISO dates, deltas | **IBM Plex Mono** | See below |
| Display / marketing | *Plus Jakarta Sans* — **do not use in the product** | See below |

**The argument for Plex Mono on compared values, with measurements.**

The brief asks me to argue for the mono choice rather than assert it. Three measurements, taken by parsing the shipped TTFs. [MEASURED]

**(a) Proportional digits cannot column-align, and the error is enormous.**
In Plus Jakarta Sans, two nine-character amount strings render at wildly different widths:

```
"1,111.11"   →  2.782 em          "85,000.00"  →  5.460 em
                                   a 96% width difference
```

In IBM Plex Mono both render at exactly **5.400 em** (9 × 0.600 advance). Amounts in a proportional face can never form a column, which means the eye cannot compare them by position — it has to read them. In a product whose entire job is "these two numbers differ", that is disqualifying.

**(b) Plex Mono actually disambiguates zero from O with a mark, not with width.**

```
IBM Plex Mono   "0"  3 contours,  bbox 488 units wide
                "O"  2 contours,  bbox 488 units wide     ← identical box, extra contour = a dotted zero

IBM Plex Sans   "0"  2 contours,  480 wide
                "O"  2 contours,  592 wide                 ← distinguished by WIDTH only
Plus Jakarta    "0"  2 contours,  588 wide
                "O"  2 contours,  746 wide                 ← distinguished by WIDTH only
```

In a monospaced context width is constant, so a face that separates 0 from O by width alone would make them indistinguishable. Plex Mono adds a third contour — an actual dot inside the counter. For transaction IDs and reference numbers copied out of scanned documents, `0` vs `O` and `1` vs `l` are the two mistakes that matter, and only Plex Mono resolves the first structurally.

**(c) Plex Sans and Plex Mono are metrically identical, so they mix inline with no adjustment.**

```
                 unitsPerEm   ascender   descender   x-height
IBM Plex Sans       1000        1025       -275        0.516
IBM Plex Mono       1000        1025       -275        0.516     ← identical
Plus Jakarta        1000        1050       -300        0.536     ← 3.9% larger x-height
```

`Invoice total is ₹85,000.00` can set the sans and the mono at the **same px size** with zero baseline or x-height mismatch. Pairing Jakarta with Plex Mono would require setting the mono at a fractional 15.58px to optically match, which is both fragile and wrong. **This is the decisive argument** — it is not about which mono is nicest, it is that the family is already matched.

**Why Plus Jakarta Sans is removed from the product.** It is a good face and it is the wrong one here. It has a larger x-height and a more geometric, friendlier construction; it says *consumer app*. Plex Sans was designed by IBM for technical interfaces, is a hair narrower at the same size (more characters per 360dp line), and pairs metrically with its own mono. Shipping two sans families to a phone also costs bundle size for no benefit. Keep Jakarta for a marketing site if one exists.

Independent corroboration: **Ramp — a serious fintech doing exactly this class of receipt-vs-record comparison — ships IBM Plex Sans and IBM Plex Mono.** [PROD]

**A hard constraint to note.** `@expo-google-fonts/*` ships **static** weights, not variable fonts. The industry's fashionable micro-weights — Linear's 510/590/680, Atlassian's 653, Polaris's 450/550/650 — are **not available**. Ddetect has 400 / 500 / 600 / 700 and nothing between. Given rule #13, that is fine:

> **600 is the maximum weight anywhere in Ddetect's data UI. 700 appears only in `display`.**

### 2.8.2 The scale

Letter-spacing in RN is in **dp**, not em. Values are pre-multiplied.

| Role | Face | Size | Weight | Line height | Letter-spacing | WCAG class |
| --- | --- | --- | --- | --- | --- | --- |
| `display` | Plex Sans | 28 | 700 | 34 | −0.5 | large (3:1) |
| `title` | Plex Sans | 22 | 600 | 28 | −0.3 | large *if 600 counts as bold* |
| `heading` | Plex Sans | 18 | 600 | 24 | −0.2 | normal (4.5:1) |
| `subheading` | Plex Sans | 16 | 600 | 22 | −0.1 | normal |
| `body` | Plex Sans | 15 | 400 | 22 | 0 | normal |
| `bodyStrong` | Plex Sans | 15 | 500 | 22 | 0 | normal |
| `bodySm` | Plex Sans | 13 | 400 | 18 | 0 | normal |
| `label` | Plex Sans | 13 | 500 | 16 | +0.1 | normal |
| `caption` | Plex Sans | 11 | 500 | 14 | +0.3 | normal |
| `overline` | Plex Sans | 11 | 600 | 14 | +0.8 | normal |
| **`mono`** | **Plex Mono** | **15** | **500** | **22** | **0** | normal |
| **`monoSm`** | **Plex Mono** | **13** | **500** | **18** | **0** | normal |
| **`monoXs`** | **Plex Mono** | **12** | **400** | **16** | **0** | normal |

**Body is 15, not 16 or 14.** Linear independently landed on 15 for the same reason: 16 wastes a phone's width on a data-dense list, 14 is tiring for the prose that carries a reasoning chain.

`title` at 22/600 sits in the genuinely arguable zone of the "large text" exemption. WCAG defines large as ≥24px regular **or** ≥18.66px *bold*, and the spec says "bold" without fixing a weight — so whether 600 SemiBold counts is a reading, not a fact (the conservative reading is ≥700). **This design does not rely on the answer.** Every ink in §2.6 is solved to 4.5:1, so no role anywhere depends on the exemption being granted; the "WCAG class" column records only which roles *would* qualify under the most permissive reading.

**Only `mono*` roles use tabular figures.** RN's `fontVariant: ['tabular-nums']` is unreliable on Android; Plex Mono is monospaced by construction, so the feature is unnecessary. Follow Linear's structural solution instead: give numeric slots a **fixed width** and right-align them. That works on every platform.

### 2.8.3 What gets mono, and what does not

| Mono | Sans |
| --- | --- |
| Currency amounts — `₹85,000.00` | Human dates — `12 March 2025` |
| Deltas — `−₹45,000.00` | Document titles |
| Transaction / reference / invoice IDs | Party names |
| Hashes and checksums | Snippet prose |
| ISO dates when compared as strings — `2025-03-12` | Counts in sentences — "3 documents" |
| Page and line locators — `p.4 L12` | Anything a person reads rather than compares |

Restricting mono to *things compared character-by-character* is the whole point. A date rendered `12 March 2025` in mono is ugly and gains nothing, because nobody compares it glyph-by-glyph. A date rendered `2025-03-12` beside another `2025-03-14` is being compared glyph-by-glyph, and mono earns its place.

## 2.9 Spacing

```
space.0   0
space.1   2      hairline offsets, icon nudges
space.2   4      inside a chip
space.3   8      between a label and its value
space.4   12     between rows in a group
space.5   16     ← the default. screen gutter, card padding
space.6   20
space.7   24     between sections
space.8   32     above a section heading
space.9   40
space.10  56     empty-state vertical rhythm
```

A 4dp base with a 2dp half-step. Same shape as Atlassian (2/4/6/8/12/16/20/24/32) and Carbon (2/4/8/12/16/24/32).

**Screen gutter is 16dp**, giving 328dp of usable width at 360dp. Every layout calculation in §3 uses 328.

Polaris's nesting rule applies: **the deeper an element is nested, the smaller its padding.** Screen 16 → container 12 → row 8 → chip 4. And Polaris's corollary, which matters more: **do not use padding to create space between siblings — use a gap.** In RN that is `gap` on the flex container (supported since 0.71), not `marginBottom` on every child.

### Row heights

| Row | Height | Basis |
| --- | --- | --- |
| Finding row (2-line) | **64** | Expensify `optionRowHeight: 64` — the only mobile-first reference measured |
| Finding row (3-line, with values) | **84** | 64 + one 20dp mono line |
| Evidence row | **64** | |
| Matrix field row (collapsed) | **44** | Minimum touch target; the row is the target, not the cell |
| Matrix expanded child row | **44** | |
| Group header | **32** | Deliberately shorter than a row (Linear: 36 header vs 40 row) |
| Filter chip strip | **36** | |
| List separator | `hairlineWidth` | |

Linear's 40dp row is a desktop measurement with a mouse. On a phone with a finger, 44 is the floor and 56–64 is the working range. Do not copy 40.

## 2.10 Radius

My first draft was 6 / 10 / 14. Measuring the references killed it: **EUI 4, Splunk 4, Datadog 4 including its status pills, Atlassian 2/4/6/8/12, Linear's data UI 4/8.** The industry consensus is 4px for nearly everything, and "pill" shapes are frequently just 4px rectangles.

```
radius.none  0
radius.xs    2     severity rail caps, tiny marks
radius.sm    4     chips, buttons, inputs, matrix cells   ← the workhorse
radius.md    8     rows, list containers, inline panels
radius.lg    12    bottom sheets, modals, full-bleed panels
radius.full  999   avatars ONLY — never a chip
```

**Concentric rule:** `inner = outer − padding`. An 8dp container with 8dp padding has a 0dp inner box. Violating this produces a visible crescent gap that reads as a rendering bug.

**Chips are 4dp rectangles, not pills.** Datadog keeps even `--status-pill-border-radius` at 4. A pill shape on a status chip is one of the loudest "consumer app" signals available, and this product is trying not to send it. Where Ddetect needs Notion's shape-as-type trick, the distinction is **filled vs outlined** (Primer's StateLabel/Label split), not rounded vs square — because the corner radius is already spent.

## 2.11 The container decision rule

The client dislikes unnecessary borders. Rather than encode a preference, here is a rule derived from an accessibility obligation, following Primer's substitution principle (§1.3).

> **A border and a background fill are substitutes discharging the same obligation: making a container's boundary perceivable at 3:1 (WCAG 1.4.11). Use whichever one is already doing the job. Never both.**

**The decision procedure, in order. Stop at the first "yes".**

**1. Does the container need a perceivable boundary at all?**
It needs one only if it is *interactive*, or if its edge carries meaning (a snippet quoted from a document is a different kind of text and the boundary is the claim). If the container merely groups related content, **it needs nothing** — spacing and a heading do the work. This is the majority case and it is the one Ddetect currently gets wrong.
→ **No: use nothing.** No border, no fill, no shadow. Group with `space.7` and a `heading`.

**2. Does the content already sit on a different background from its parent?**
If yes, measure it. If the fill clears **3:1 against the parent**, the boundary is already perceivable.
→ **Yes: use the fill alone. The border is redundant and must be deleted.**

**3. Does the fill *not* clear 3:1 — because the elevation ladder's steps are 1.08–1.29?**
This is the normal case for Ddetect: `surface` on `bg` is 1.29:1, nowhere near 3:1. So a filled surface on this ladder **does not** by itself constitute a perceivable boundary for an interactive control.
→ **Interactive control: fill + `hairlineStrong` (3.00:1).** The border is doing real work.
→ **Non-interactive region: fill + `hairline` (1.61:1).** No minimum applies; the hairline is a reading aid.

**4. Is this a transient surface above the app — a sheet, a menu, a dialog?**
→ **Light mode: fill + one shadow, no border.** Dark mode: **fill + `hairline`, no shadow** (see §2.12).

**The four consequences, stated as prohibitions:**

- **A `surface` row inside a `bg` list gets no border.** The fill and the rhythm are sufficient. Primer: *"Don't use dividers to separate individual items."*
- **A group of rows gets one `hairline` between rows OR an inset per row — never both.**
- **Nothing gets a border and a shadow.** They are the same signal spent twice.
- **A chip never gets a border and a tinted fill.** Filled chips have no stroke; outlined chips have no fill. Primer runs exactly this split, and it also gives Ddetect a free channel: **filled = the one canonical state of the object; outlined = every other attribute.**

Ddetect's card budget, stated as a number: **one bordered/filled container per screen, maximum, and only where the boundary is load-bearing.** In the six screens in §3, the count is: findings list 0, finding detail 2 (the two snippet blocks), matrix 0, evidence detail 1 per field, upload 0, empty states 0.

## 2.12 Elevation

**Dark mode has no shadows.** A black shadow on a dark surface is invisible, and Android's `elevation` prop compensates by drawing a grey key-line that reads as a cheap outline. Linear reaches the same conclusion — its dark base shadows are literally `0px 0px 0px transparent`, and depth is pure value-stepping.

```
DARK    elevation is carried ENTIRELY by the background ladder (§2.2).
        Sheets and menus get `hairline`. No shadowColor, no elevation prop, ever.

LIGHT   exactly two shadows exist:
          raised  { shadowColor:'#1E2536', shadowOpacity:0.06, shadowRadius:2,
                    shadowOffset:{w:0,h:1}, elevation:1 }
          overlay { shadowColor:'#1E2536', shadowOpacity:0.10, shadowRadius:14,
                    shadowOffset:{w:0,h:6}, elevation:8 }
```

`shadowColor` is a blue-grey, not black — Stripe's tinted-ambient technique, which is why their shadows look like paper. RN cannot do two-layer shadows on Android (only `elevation`), so a single tuned layer plus `elevation` is the honest ceiling.

`raised` is for the app bar once content scrolls under it. `overlay` is for bottom sheets. **Nothing in a list gets a shadow.**

## 2.13 Motion

### The platform constraint, stated precisely

`react-native-reanimated` is unusable. Only RN's `Animated` API is available. That matters more than it sounds, because of what the native driver allows. From `NativeAnimatedAllowlist.js` [PROD]:

```
NATIVE-DRIVER ANIMATABLE   opacity · transform (translateX/Y, scaleX/Y, rotate) ·
                           backgroundColor · color · borderColor · tintColor ·
                           borderRadius · elevation · shadowOpacity · shadowRadius · zIndex

NOT ANIMATABLE             height · width · margin · padding · flex · top · left · right · bottom
```

**Consequence: an accordion cannot animate its height at 60fps.** Height animation requires `useNativeDriver: false`, which runs on the JS thread and janks visibly during list scroll — precisely when an accordion is used.

> **Rule: never animate height. Cross-fade `opacity` and offset with `translateY`, and let the layout snap.** The eye reads the fade as the transition; the instantaneous reflow underneath is not perceived.

### Tokens

```
duration.instant  0      appearance of feedback — see below
duration.fast     80     press states, checkbox, chip toggle
duration.base     140    the default. fades, chip changes, tab switch
duration.slow     200    sheet in, row expand cross-fade
duration.slower   280    full-screen push (RN Navigator handles this)

easing.standard   Easing.bezier(0.2, 0, 0,   1)    entering + most changes
easing.exit       Easing.bezier(0.4, 0, 1,   1)    leaving (accelerate out)
easing.emphasis   Easing.bezier(0.3, 0, 0,   1)    the one confirmation moment
```

**`duration.instant = 0` is a real token and it is the most valuable one here.** Linear ships `--speed-highlightFadeIn: 0s` alongside `--speed-highlightFadeOut: .15s` [PROD]. Feedback appears immediately; only its *removal* animates. A press state that fades in over 80ms feels laggy; a press state that appears instantly and fades out over 140ms feels fast and still looks smooth. Apply this everywhere: **in = 0, out = `duration.base`.**

### The five places motion earns its place

Everything else is static.

| # | Where | What | Duration / easing |
| --- | --- | --- | --- |
| 1 | Press feedback | `backgroundColor` to the MD3 pressed layer (0.10 alpha) | in **0**, out 140 / standard |
| 2 | Matrix row expand | Children `opacity` 0→1 + `translateY` −6→0. **Height snaps.** | 200 / standard |
| 3 | Sheet present / dismiss | `translateY` from `+height`, backdrop `opacity` 0→0.5 | in 200 / standard, out 140 / exit |
| 4 | Processing state change | Cross-fade the glyph: old `opacity`→0 and new 0→1, `duration.base`. **No spinner rotation on determinate states.** | 140 / standard |
| 5 | Suggestion accept / reject | The row `translateY` −8 + `opacity`→0, then removal. The one place a small overshoot is earned. | 200 / emphasis |

**Not on the list, deliberately:** list item entrance staggers, skeleton shimmer (use a static `surfaceAlt` block), number count-ups, chart draw-ons, parallax headers, layout-animation on filter changes, pull-to-refresh custom animations.

### Reduce motion

```ts
// read once at mount, subscribe for changes
AccessibilityInfo.isReduceMotionEnabled()
AccessibilityInfo.addEventListener('reduceMotionChanged', fn)
```

When reduce-motion is on: **all five reduce to an opacity cross-fade at `duration.fast`, and #5's overshoot is removed.** Do not set duration to 0 — an instant swap loses the causal link between the tap and the change, which is the accessibility failure in the other direction. Keep a short fade.

---

# 3. Screen solutions

All wireframes are drawn at **360dp**, the narrowest supported width, with a 16dp gutter → **328dp usable**. Anything that fits at 360 fits at 393 and 412 with slack.

## 3.1 Findings list

**The problem:** severity + claim + supporting documents, without a wall of cards.

**The density argument, as arithmetic.** On a Pixel-class phone: 852dp tall − 24 status bar − 56 app bar − 44 filter strip − 80 tab bar ≈ **648dp of list**. A 64dp row shows **10** findings. An 88dp card with 12dp of inter-card gap shows **6**. [MEASURED] Cards cost 40% of the visible working set to display exactly the same fields, and they do it by adding a boundary that conveys nothing — every finding is the same kind of object, so the container tells you nothing the row doesn't.

**Encoding:** severity is a **3dp left rail plus the word**, following Splunk's `color, fill` restriction and Elastic's causal red line. It is never a chip and never a row background.

```
360dp
┌──────────────────────────────────────────────────────────┐
│ ‹  Findings                                        ⋯     │  56  app bar
│                                                          │
├──────────────────────────────────────────────────────────┤
│  ▸ All 19   Conflicts 6   Unsupported 4   Missing 3      │  44  h-scroll chips
├──────────────────────────────────────────────────────────┤   hairline
│                                                          │
│  CONFLICT · 6                                            │  32  group header, overline 11/600
│                                                          │      textTertiary, NOT sticky
│ ▌ Invoice total does not match the receipt          ›    │
│ ▌ ₹85,000.00   vs   ₹40,000.00                           │  84  3-line row, mono values
│ ▌ Invoice #4471 · Receipt 12 Mar                         │
│ ▌                                                        │      ── hairline, inset 16 left
│ ▌ Payment date is stated three different ways       ›    │
│ ▌ 12 Mar · 14 Mar · 19 Mar                               │  84
│ ▌ 3 documents                                            │
│                                                          │
│  UNSUPPORTED · 4                                         │  32
│                                                          │
│   Claim of a written warning has no document        ›    │
│   No evidence found                                      │  64  2-line row, NO rail
│                                                          │
└──────────────────────────────────────────────────────────┘

▌ = 3dp rail, tone.conflict, full row height, radius.xs
```

**Anatomy of a row**

```
0    3        16                                          328
│ ▌  │        │                                             │
│ ▌  │  Invoice total does not match the receipt      ›     │   body 15/500 textPrimary
│ ▌  │                                                      │   wraps to 2 lines max (Polaris)
│ ▌  │  ₹85,000.00   vs   ₹40,000.00                        │   monoSm 13/500
│ ▌  │  └─ conflict  └ textTertiary   └─ conflict           │
│ ▌  │                                                      │
│ ▌  │  Invoice #4471 · Receipt 12 Mar                      │   caption 11/500 textTertiary
└────┴──────────────────────────────────────────────────────┘
     ↑ 13dp gap                                    ↑ chevron 20dp, textTertiary
```

**Decisions and their sources**

- **No card, no border, no fill.** §2.11 step 1: rows in a homogeneous list group by rhythm. A `hairline` inset 16dp from the left separates rows within a group; **groups are separated by the header's whitespace, not by a rule** (Primer: dividers group, they don't separate items).
- **The severity word is the group header, not a per-row chip.** Saying "CONFLICT" once above six rows instead of six times removes 6 chips from the screen and loses nothing. This is the largest single noise reduction available in the app.
- **Supporting documents are a count and a list of short names in `caption`, not avatars or thumbnails.** "3 documents" beats three 20dp squares that can't be read.
- **`UNSUPPORTED` rows have no rail.** Absence of evidence is not a severity. Following Ramp, the "we couldn't establish this" register is neutral and quiet — it gets `textTertiary` and no colour at all.
- **Unreviewed findings render the claim at weight 500; reviewed ones at 400** (Nuix's bold-means-unviewed). Read-state for free, with no badge.
- **The filter strip is `AnalysisTypeEnum`-derived counts, and it is the density control.** Following Linear: there is no row-height setting. You compress by filtering.
- **Sort is in the `⋯` menu**, defaulting to severity then recency. Primer: "one column must be sorted by default."

## 3.2 Finding detail

**The product's most important screen.** The brief's example: invoice ₹85,000 vs receipt ₹40,000, with provenance for each and a reasoning chain.

**The layout question, answered with arithmetic.** A true side-by-side at 360dp gives `(328 − 16 gutter) / 2 = 156dp` per column. At `monoSm` 13px, Plex Mono advances 0.600em → **7.80dp per character**, so 156dp holds **20 characters**. `₹85,000.00` is 10. **The values fit side by side comfortably.** A source snippet does not — 156dp holds about 22 characters of `bodySm`, which is three words.

> **Therefore: two columns for the values, full width for the evidence.** What you *compare* is a handful of characters and belongs in parallel. What you *read* is prose and belongs in a single column. These are different layout problems inside one screen and solving them the same way is why comparison screens usually fail.

```
360dp
┌──────────────────────────────────────────────────────────┐
│ ‹  Finding                                         ⋯     │  56
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ▌ CONFLICT                                              │  overline 11/600 conflict + 3dp rail
│                                                          │
│  Invoice total does not match                            │  title 22/600 textPrimary
│  the receipt                                             │
│                                                          │
│  ◆ Determined by comparison · both values read           │  caption, textTertiary
│    directly from the documents                           │  ◆ = deterministic glyph, §4
│                                                          │  ── space.7
│                                                          │
│  ┌────────────────────────┬─────────────────────────┐    │  the value strip
│  │ INVOICE                │ RECEIPT                 │    │  overline 11/600 textTertiary
│  │                        │                         │    │
│  │ ₹85,000.00             │ ₹40,000.00              │    │  mono 15/500
│  │                        │                         │    │  textPrimary both — see note
│  └────────────────────────┴─────────────────────────┘    │
│         └ 156dp ─────┘  16  └───── 156dp ────┘           │
│                                                          │
│  Difference          − ₹45,000.00                        │  label 13/500 · mono 15/500
│                      ^^^^^^^^^^^^ tone.conflict           │  the QuickBooks scalar
│                                                          │
│ ──────────────────────────────────────────────────────── │  hairline, full width
│                                                          │
│  WHERE THESE CAME FROM                                   │  overline
│                                                          │
│  Invoice_ACME_4471.pdf                            ›      │  bodyStrong 15/500
│  Page 2 · read from the file                             │  caption textTertiary
│  ┌──────────────────────────────────────────────────┐    │
│  │ Total amount due:  ₹85,000.00                    │    │  snippet block, surfaceAlt
│  │ Payable within 30 days of invoice date.          │    │  monoXs 12/400
│  └──────────────────────────────────────────────────┘    │  radius.sm, 12dp padding
│                                                          │       2dp accent rail on left
│  Receipt_12Mar.jpg                                ›      │
│  Page 1 · read from an image                             │
│  ┌──────────────────────────────────────────────────┐    │
│  │ RECEIVED  Rs 40,000/-  towards inv 4471          │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│ ──────────────────────────────────────────────────────── │
│                                                          │
│  HOW THIS WAS DECIDED                                    │  overline
│                                                          │
│  ●  Both documents refer to invoice 4471                 │  reasoning chain
│  │                                                       │  ● 6dp dot, hairlineStrong
│  ●  The invoice states a total of ₹85,000.00             │  │ 1dp rail between dots
│  │                                                       │
│  ●  The receipt records ₹40,000.00 against it            │  body 15/400
│  │                                                       │  textSecondary
│  ●  These amounts differ by ₹45,000.00                   │  the last step: textPrimary
│                                                          │
├──────────────────────────────────────────────────────────┤
│  [ Mark reviewed ]              [ Dismiss ]              │  56 action bar, pinned
└──────────────────────────────────────────────────────────┘
```

**Decisions and their sources**

- **Neither value is coloured red.** This is the most important call on the screen and it comes from Mercury: money is neutral by default and coloured only where direction is semantically relevant. Neither ₹85,000 nor ₹40,000 is wrong — nobody knows which one is. Colouring both red asserts a fault that has not been established; colouring one red picks a side the system has no basis to pick. **The conflict is the relationship, so the colour goes on the difference.**
- **The difference is rendered, not implied.** QuickBooks' reconciliation scalar. The user should never have to subtract two numbers in their head to understand a finding about two numbers.
- **The snippet blocks are the two containers on this screen that earn a boundary** (§2.11 step 1, "the edge carries meaning"): they are text quoted from somewhere else, and the boundary is the claim of verbatimness. `surfaceAlt` fill + a 2dp gold rail, **no border** — the fill and the rail are already the boundary.
- **Snippet locators (`Page 2`) live outside the block**, following Stripe's `content: attr(data-line-number)` technique — so that copying the snippet yields the document's text and nothing else.
- **Provenance verbs are plain English, not enum names.** `DETERMINISTIC` → "read from the file". `OCR` → "read from an image". `AI` → "suggested by AI". `MANUAL` → "you entered this". A user in a dispute over an unpaid invoice does not know what "deterministic extraction" means, and the word is doing no work that "read from the file" doesn't do better.
- **The reasoning chain is a chain**, in Sentry's suspect-commits sense — ordered steps that a person could check, each naming what it read. It is not a paragraph and it is not a confidence score. PAIR: *"Don't say 'what' without saying 'why' in a high stakes scenario."*
- **The action bar has one primary action** (Polaris: "only one primary call to action"). `Mark reviewed` is filled; `Dismiss` is text-only.

## 3.3 Cross-document comparison matrix

**The hardest layout problem in the app.** Rows = fields, columns = documents, cells = values, on a 360dp phone.

### Why the obvious answer fails, with numbers

The instinct is a frozen field-label column plus horizontally scrolling value columns. Measure it:

```
360 − 32 gutters             = 328 usable
− 104 frozen field label     = 224 for values
÷ 96dp minimum value column  = 2.33 columns visible
```

**2.33 documents visible at a time.** Reading one row across a 10-document case takes **four swipes**, and by the fourth you cannot remember the first. This is not a tuning problem — a value column cannot go below ~96dp because `₹85,000.00` at `monoSm` needs 10 × 7.80 = 78dp plus padding. **Rejected as the primary view.** [MEASURED]

Primer independently says so twice: *"It's easier to scan many rows than it is to scan many columns"*, and use a list not a table *"when there are columns where the cells will usually be empty"* — which is exactly a document/field matrix, where an invoice has no termination date and a bank statement has no signatory.

### The solve: separate *locating* from *reading*

The matrix's job is **"where is the problem?"**, not **"what does it say?"** Those are two views.

**Tier 1 — the glyph matrix.** No values. One 28dp glyph per cell. The whole case at a glance.

```
328 usable = 104 field label + 224 glyph area
224 ÷ 28dp = 8 document columns at 360dp
             9 at 393dp and 412dp
```

```
360dp
┌──────────────────────────────────────────────────────────┐
│ ‹  Compare                                    Docs ⌄     │  56
├──────────────────────────────────────────────────────────┤
│                                                          │
│                D1  D2  D3  D4  D5  D6  D7  D8            │  32  column header
│                ──  ──  ──  ──  ──  ──  ──  ──            │      caption, textTertiary
├──────────────────────────────────────────────────────────┤   hairline
│                                                          │
│  Total amount   ◆   ✕   ◆   ·   ·   ◆   ·   ·      ›     │  44
│  ────────────────────────────────────────────────────    │
│  Invoice no.    ◆   ◆   ◆   ◆   ·   ◆   ·   ◆      ›     │  44
│  ────────────────────────────────────────────────────    │
│  Payment date   ✕   ✕   ◆   ·   ·   ·   ·   ·      ›     │  44
│  ────────────────────────────────────────────────────    │
│  Payee name     ◆   ◆   ◆   ◆   ◆   ◆   ◆   ◆      ›     │  44   ← fully glyphed = healthy
│  ────────────────────────────────────────────────────    │
│  Due date       ·   ·   ·   ·   ·   ·   ·   ·      ›     │  44   ← all gaps = MISSING
│  ────────────────────────────────────────────────────    │
│  Signatory      ◆   ·   ·   ○   ·   ·   ·   ·      ›     │  44
│                                                          │
├──────────────────────────────────────────────────────────┤
│  ◆ agrees   ✕ conflicts   ○ AI suggestion   · absent     │  36  persistent legend
└──────────────────────────────────────────────────────────┘

D1 Invoice_ACME_4471.pdf      D5 Bank_stmt_Mar.pdf
D2 Receipt_12Mar.jpg          D6 Email_thread.pdf     ← the Docs ⌄ sheet
D3 Contract_signed.pdf        D7 Delivery_note.jpg
D4 Reminder_letter.pdf        D8 WhatsApp_export.txt
```

**Tier 2 — tap a row, it expands in place** to full-width readable values. Everlaw's *"And # more expands inline in the same cell"*, and it preserves the surrounding rows as context.

```
│  Total amount   ◆   ✕   ◆   ·   ·   ◆   ·   ·      ⌄     │  44  expanded, chevron rotated
│  ┌────────────────────────────────────────────────────┐  │
│  │ D1  Invoice_ACME_4471       ₹85,000.00    p.2      │  │  44   surfaceAlt fill
│  │ D2  Receipt_12Mar           ₹40,000.00    p.1   ✕  │  │  44   conflict ink on the value
│  │ D3  Contract_signed         ₹85,000.00    p.7      │  │  44
│  │ D6  Email_thread            ₹85,000.00    p.1      │  │  44
│  │                                                    │  │
│  │  Difference   D1 ↔ D2        − ₹45,000.00     ›    │  │  44   → opens the finding
│  └────────────────────────────────────────────────────┘  │
│  ────────────────────────────────────────────────────    │
```

**Decisions and their sources**

- **The row is the touch target, not the cell.** A 28dp cell is below the 44dp minimum and cannot be made compliant without destroying the density that justifies the view. So cells are not individually tappable; the 44dp row is. Per-document access is in the expanded state, where each child row is 44dp.
- **Absence gets an explicit glyph (`·`).** This overrides Primer's *"don't use a character to indicate a cell is empty"*, for the reason stated in §1.3: in Ddetect absence is a finding, not noise. A genuinely blank cell would be indistinguishable from a failed render, and `Due date` being absent from all eight documents is a *result* the user needs to see.
- **Read the matrix by scanning for gaps.** QuickBooks' match-symbol logic inverted into a whole grid: a fully-glyphed row is healthy, and the `Due date` row above is the finding. This is why the glyphs must be **visually even in weight** — `◆` and `·` differ in size, not colour, so a sparse row reads as sparse from across the room.
- **Documents are numbered, not named.** 28dp holds two characters at `caption`. Rotated column headers are unreadable on a phone and are not attempted. The `Docs ⌄` sheet holds the legend permanently, and tapping a column header opens that document.
- **Beyond 9 documents, filter — don't scroll.** The `Docs ⌄` control selects which documents are in view. Horizontal scroll of the glyph area is available as a fallback and is tolerable *for glyphs* (8 at a time, not 2.3), but the primary affordance is Primer's own advice: *"Remove less important columns."*
- **The expansion does not animate height** (§2.13). Children cross-fade over 200ms; the layout snaps.
- **Only one row is expanded at a time.** Two expanded rows on a 648dp viewport leaves no matrix visible, which defeats the view.
- **Field rows are sorted conflicts-first.** The user opened this screen to find disagreement.

### What this deliberately does not do

It does not show every value. That is the whole design. Following Expensify, **agreement is not a thing to render** — the `◆` says "this document agrees with the consensus" and that is all a user needs until they ask. The values are one tap away, and the tap is cheap.

## 3.4 Evidence detail

Extracted fields, each with its source snippet.

```
360dp
┌──────────────────────────────────────────────────────────┐
│ ‹  Invoice_ACME_4471.pdf                           ⋯     │  56
├──────────────────────────────────────────────────────────┤
│  Fields          Document          History               │  44  tabs — the record and its
├──────────────────────────────────────────────────────────┤      log are peers (Stripe/Ramp)
│                                                          │
│  8 fields read from this document                        │  bodySm textSecondary
│  1 needs your review                                     │  bodySm warn
│                                                          │
│ ──────────────────────────────────────────────────────── │
│                                                          │
│  TOTAL AMOUNT                                            │  overline textTertiary
│  ₹85,000.00                                              │  mono 15/500 textPrimary
│  Rs. 85,000/-                                            │  monoXs 12/400 textTertiary
│                                          [copy]          │       ← the RAW string
│  Page 2 · read from the file                             │  caption textTertiary
│  ┌──────────────────────────────────────────────────┐    │
│  │ Total amount due:  Rs. 85,000/-                  │    │  monoXs, surfaceAlt, 2dp rail
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│ ──────────────────────────────────────────────────────── │
│                                                          │
│  ⚑ PAYEE NAME                                            │  ⚑ per-field flag, warn
│  ACME Traders Pvt Ltd                                    │  body 15/500
│  ACME TRADRS PVT LTD                                     │  monoXs textTertiary — raw OCR
│                                          [copy]          │
│  Page 1 · read from an image                             │
│  ┌──────────────────────────────────────────────────┐    │
│  │ Bill to: ACME TRADRS PVT LTD, Mumbai             │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  This looks like a spelling variation. Is it correct?    │  bodySm textSecondary
│  [ Yes, correct ]   [ Fix ]                              │  44 — HAX G9
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**Decisions and their sources**

- **Normalized value on top, raw source beneath, copy affordance on the raw.** Ramp's Jackpocket/JACKPOCKET pattern, copied verbatim. The user sees the cleaned value, the evidence for it, and can take the evidence. This one pattern does more for perceived trustworthiness than any amount of chrome.
- **The flag is attached to the field label**, not to the record and not to the screen. Ramp again. One field is in question, so exactly one field is marked.
- **The correction is offered inline, at the claim.** HAX **G9: Support efficient correction**, and Ramp's "Report incorrect receipt verification". A user who can fix a bad OCR read in one tap will trust the eleven good ones.
- **`History` is a peer tab, not a buried menu item.** Stripe's Events-and-logs and Everlaw's Coding History column. And per Stripe: **it does not auto-refresh.**
- **Snippets are always shown, never collapsed behind "view source".** Provenance is the product. A snippet costs about 40dp; hiding it saves nothing that matters and removes the reason to believe the value.

## 3.5 Upload and processing

States to cover: `UPLOADING` (with %), `QUEUED`, `PROCESSING`, `EXTRACTED`, `REVIEW_REQUIRED`, `FAILED` (with reason), `ANALYZED`, `CONFIRMED`.

**NN/g's thresholds set the indicator type** [DOCS]:

| Duration | Indicator |
| --- | --- |
| < 1s | none — but **always** give immediate acknowledgement of the tap |
| 2–10s | indeterminate loop |
| ≥ 10s | **determinate percent-done, plus an estimate** |
| unknown | *"The bigger the variability in your estimates, the lower the threshold"* — and label the stage in text |

So: **upload is determinate** (bytes are known); **extraction is indeterminate but stage-labelled** ("Step 2 of 3 · Reading text"), because NN/g's fallback for un-estimatable work is *"consider showing the number of steps."*

**The status glyph set follows Linear's grammar** — a ring that fills as work progresses, terminal states dropping the ring for a knockout mark:

```
QUEUED           ◌   dashed ring, no fill              textTertiary
UPLOADING        ◔   solid ring + pie at n%            accent (determinate — real %)
PROCESSING       ◍   solid ring + rotating arc         accent (indeterminate)
EXTRACTED        ●✓  filled disc, knockout check       ok
REVIEW_REQUIRED  ●?  filled disc, knockout query       neutral  ← NOT warn. see below
FAILED           ●!  filled disc, knockout bang        warn     ← NOT conflict red
CONFIRMED        ●✓  filled disc + gold rail on row    ok + accent
```

```
360dp
┌──────────────────────────────────────────────────────────┐
│ ‹  Add evidence                                          │  56
├──────────────────────────────────────────────────────────┤
│                                                          │
│  4 of 11 documents ready                                 │  heading 18/600
│  About 40 seconds left                                   │  bodySm textTertiary  (NN/g)
│                                                          │
│  ████████████░░░░░░░░░░░░░░░░░░░░░░░                     │  4dp bar, accent on surfaceAlt
│                                                          │       radius.xs
│ ──────────────────────────────────────────────────────── │
│                                                          │
│ ◔  Bank_statement_March.pdf                       68%    │  64  mono 13/500 right-aligned
│    Uploading · 2.1 MB of 3.1 MB                          │      caption textTertiary
│                                                          │
│ ◍  Invoice_ACME_4471.pdf                                 │  64
│    Step 2 of 3 · Reading text                            │
│                                                          │
│ ◌  Receipt_12Mar.jpg                                     │  64
│    Waiting                                               │
│                                                          │
│ ●! WhatsApp_export.txt                          [Retry]  │  64  warn glyph
│    Couldn't read this file — it may be password          │      the REASON, always
│    protected                                             │
│                                                          │
│ ●? Delivery_note.jpg                            [Check]  │  64  neutral glyph
│    Read 3 of 6 expected fields                           │
│                                                          │
│ ●✓ Contract_signed.pdf                                   │  64  ok glyph
│    9 fields read                                         │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  [ Add more ]                          [ Cancel all ]    │  56
└──────────────────────────────────────────────────────────┘
```

**Decisions and their sources**

- **Failures stay in the list, forever, with a reason and a retry.** The no-silent-drop rule, which appeared in every SOC product studied. A file that vanishes from the queue is the worst possible outcome in an evidence product — the user believes it was ingested.
- **`FAILED` is `warn` orange, not `conflict` red.** Mercury's reservation, applied: red is the colour of a **finding**, because that is what the user came for. A file that wouldn't parse is Ddetect's problem, not evidence of anything, and dressing it in the same red as a ₹45,000 discrepancy is crying wolf. Expensify's *"Can't auto-match receipt due to broken bank connection"* blames the system in exactly this register.
- **`REVIEW_REQUIRED` is `neutral` grey.** Ramp's third register: "we couldn't establish this" is not a fault and is not an alarm. "Read 3 of 6 expected fields" is a quiet, factual statement with a `Check` action.
- **Failure copy names a cause.** "Couldn't read this file — it may be password protected", not "Processing failed". Expensify's vocabulary discipline: state which thing, in which direction, and whose fault.
- **`Cancel all` exists.** NN/g: *"give users the option to stop the process."*
- **The overall bar is documents-complete, not bytes.** A user tracking 11 documents thinks in documents. "4 of 11 ready" is the unit they care about.
- **The glyph cross-fades between states** (§2.13 #4). Only `PROCESSING` rotates, because only it is genuinely indeterminate. A spinner on a determinate state is a lie about what the system knows.
- **`CONFIRMED` differs from `EXTRACTED` by a gold rail, not a different glyph.** Confirmation is a human act; gold marks human-authored state throughout the app (§5.4).

## 3.6 Empty states

NN/g gives three jobs an empty state must do: *"Communicate system status"*, *"Help users discover unused features"*, *"Provide direct pathways for getting started."* And the rule that matters most here: **"Inaccurate system-status messages for empty states are particularly harmful."** [DOCS]

**Structure, identical for all five:** an outlined glyph at 40dp, `space.5`, a `heading` line, `space.3`, one or two `body` lines in `textSecondary`, `space.7`, one primary action. **No illustration.** A spot illustration of a magnifying glass on a folder is the single most reliable "template app" signal available, and this product is trying not to send it. Centre the block at roughly 38% from the top, not dead centre — dead centre looks like an error page.

**(a) No cases**

```
                      ▢
              Nothing here yet
     A case is one dispute — an unpaid
     invoice, a wrong charge, a workplace
     complaint. Add the documents and
     Ddetect will compare them.
              [ Start a case ]
```

**(b) A case with no evidence**

```
                      ▢
           No documents in this case
     Add invoices, receipts, emails,
     statements, photos of letters —
     whatever you have. Ten is better
     than three.
              [ Add documents ]
```

Explicitly names the file kinds — NN/g: *"Tell the user what could be displayed."* And it sets the expectation that this product wants volume, because comparison across ten documents is where it earns its keep.

**(c) Analysis has never run** — the state NN/g warns about

```
                      ▢
          Ready to compare 11 documents
     Ddetect will look for amounts that
     disagree, dates that don't line up,
     claims with nothing behind them, and
     documents you might be missing.
              [ Run comparison ]
```

**This must not say "No findings."** It is not a result. It is a prompt, and it is the one screen in the app that should state what the product is about to do — HAX **G1: Make clear what the system can do**, and PAIR's *"Communicate the product's capabilities and limitations clearly... and do this early."* Naming the four analysis families is also honest scoping: it tells the user what will *not* be looked for.

**(d) Analysis ran and found nothing — a result, not an empty state**

```
                      ●✓                            ← ok, filled
        Nothing contradicts anything else
     Across 11 documents, every amount,
     date and name that appears more than
     once agrees.
     Checked 6 fields across 11 documents.
     [ See what was compared ]
```

**This is good news and must not look like a failure.** It gets the `ok` glyph, an affirmative headline, and — critically — **the scope of what was checked**, so the user can judge whether the silence is meaningful. PAIR: *"Don't be afraid to admit when a lack of data could affect the quality of the AI recommendations."* A user in a dispute needs to know that "no conflicts" means "no conflicts in the six fields we could read", not "your case is fine".

**(e) A filter matched nothing** — distinct from all of the above

```
                      ▢
           No conflicts in this case
     There are 4 unsupported claims and
     3 missing documents.
              [ Show all findings ]
```

Never the same screen as (a)–(d): the container is populated, the *filter* is empty. The action clears the filter rather than creating anything. NN/g's "what but not how" failure is avoided by naming what *does* exist.

---

# 4. Uncertainty design

## 4.1 The distinction the product's integrity depends on

Two findings can both say "these do not match", and they are not the same kind of statement:

> **A.** The invoice says `₹85,000.00`. The receipt says `₹40,000.00`. Both were read directly from the files. **They differ. This is a fact, and it is certain.**
>
> **B.** A model believes the payment described in the WhatsApp message and the transfer in the bank statement are the same event. **This is an opinion, and it is provisional.**

If a user cannot tell A from B in under a second, the product is dishonest, because it will be believed on B at the strength it has earned on A.

**The failure mode to avoid is subtlety.** A small violet dot is not enough. **The distinction must be carried on three independent channels simultaneously**, so that it survives colour-blindness, greyscale, a cracked screen, and a glance.

## 4.2 The three channels

| Channel | Deterministic | AI-suggested | Precedent |
| --- | --- | --- | --- |
| **Glyph** | `◆` solid diamond | `◇` open diamond, **or** a dedicated AI mark | Datadog's pink binoculars — a mark off the status scale |
| **Stroke** | solid | **dashed** | Everlaw (dotted = changed), Datadog (dashed = inferred) |
| **Hue** | severity hue (conflict / ok / neutral) | **violet, never a severity hue** | brief's reservation; Linear (colour is a prop, shape is data) |
| **Verb** | states — *"differ"*, *"does not match"* | hedges + names an author — *"AI suggests"* | Ramp (*"Couldn't verify"* vs *"doesn't match"*) |

The fourth row is doing as much work as the first three. **Copy carries the epistemics.**

```
DETERMINISTIC                          AI-SUGGESTED
─────────────────────────────          ────────────────────────────────
◆ Invoice total does not match         ◇ AI suggests these describe the
  the receipt                            same payment
  ₹85,000.00  vs  ₹40,000.00             WhatsApp 12 Mar ~ Bank 12 Mar
  Difference − ₹45,000.00                Not yet confirmed
  ─── solid 3dp rail, conflict           ┄┄┄ dashed 3dp rail, ai violet

  "Both values were read directly       "This is a suggestion. Accept it
   from the documents."                  to include it in your case."
                                         [ Accept ]      [ Reject ]
```

**An AI suggestion is never counted in the finding totals until accepted.** `SuggestionStatusEnum.SUGGESTED` items live above the fold in their own group — "3 suggestions to review" — and enter the case only on `ACCEPTED`. HAX **G8: Support efficient dismissal** and **G9: Support efficient correction**; PAIR's *"Progressively increase automation under user guidance."*

**Violet appears nowhere except AI provenance.** Not on a severity, not on a status, not on a button. This is the brief's reservation and it is what makes the violet legible — a colour used for one thing is a colour that means something.

## 4.3 Confidence without fake percentages

PAIR is unambiguous [DOCS]:

> *"Numeric confidence indicators are risky because they presume your users have a good baseline understanding of probability."*
> *"showing more granular confidence can be confusing if the impact isn't clear"* — their example is 85.8% vs 87%.
> *"If it doesn't make an impact on user decision making, consider not showing it."*
> And the rule that shapes the design: **"Clearly indicate what action a user should take under each category of confidence."**

The codebase already knows this. `src/domain/enums.ts` carries the comment: *"showing '99.7%' next to a machine guess implies a precision the system does not have."* The enum is already four coarse bands. The design job is to render them as **actions, not adjectives.**

| `MatchConfidenceEnum` | Label shown | What the user should do | Tone |
| --- | --- | --- | --- |
| `EXACT_MATCH` | **Verified** | nothing | `ok` |
| `STRONG_MATCH` | **Likely** | skim it | `ok` |
| `SUGGESTED_MATCH` | **Check this** | confirm or reject | `ai` violet, **dashed** |
| `NEEDS_REVIEW` | **Needs you** | resolve before relying on it | `neutral` |

Note that `NEEDS_REVIEW` is **grey, not orange.** Ramp's third register: "we could not establish this" is not a warning, it is an absence of knowledge, and painting it amber implies the system found something wrong when it found nothing at all.

**Rendering: bars, not a chip.** Linear's priority glyph, applied — three bars, constant silhouette, unfilled bars at 40% opacity rather than absent:

```
Verified      ▮▮▮      Likely       ▮▮▯      Check this   ▮▯▯      Needs you   ▯▯▯
                                                          (dashed)              (grey)

each bar 3dp wide × 8/11/14dp tall, 2dp gap — total 13dp wide
unfilled bars render at opacity 0.4, so the scale is always visible
```

This is 13dp instead of a ~72dp chip, it never changes width so the column never jumps, and it reads at a glance without a legend once seen twice. Crucially the **silhouette is constant**, so the user always sees what scale they are reading against — the specific insight from Linear that makes a 4-band indicator work at 13dp.

**A number appears in exactly one place in the entire product:** the label under the bars in the finding detail's expanded provenance, where it says how many independent documents support a value — `3 of 11 documents`. That is a **count**, not a probability. Counts are honest; they mean exactly what they say and a user in a dispute understands them immediately.

## 4.4 Mapping onto the actual enums

`ExtractionMethodEnum` and `MatchConfidenceEnum` are **orthogonal and must never be merged into one badge.** A `DETERMINISTIC` extraction can still produce a `NEEDS_REVIEW` match; an `AI` extraction can produce an `EXACT_MATCH` on the string it read. Collapsing them is the single most likely way this design gets broken in implementation.

| Enum | Channel | Rendering |
| --- | --- | --- |
| `ExtractionMethodEnum` | **provenance line** — plain-English verb under the value | MANUAL → "you entered this" · DETERMINISTIC → "read from the file" · OCR → "read from an image" · AI → "suggested by AI" |
| `MatchConfidenceEnum` | **bars**, §4.3 | never a percentage |
| `SuggestionStatusEnum` | **stroke style** | SUGGESTED → dashed · ACCEPTED → solid · REJECTED → removed from view, recoverable from History |
| `ClaimStateEnum` | **glyph + severity hue** | SUPPORTED `◆` ok · CONTRADICTED `✕` conflict · UNSUPPORTED `·` neutral · MIXED_REVIEW `◐` neutral |
| `SeverityEnum` | **rail presence + width** | HIGH 3dp conflict · MEDIUM 3dp warn · LOW no rail · **INFO no rail, neutral text** |
| `ProcessingStateEnum` | **ring-fill glyph**, §3.5 | |
| `FindingStatusEnum` | **weight + opacity** | OPEN 500 · REVIEWED 400 · DISMISSED 400 at 60% opacity, collapsed into a "3 dismissed" footer · RESOLVED 400 with `ok` glyph |

The `ExtractionMethodEnum` precedence (`MANUAL > DETERMINISTIC > AI`) is Expensify's field-authority rule and **must be visible**: when two methods disagree about the same field, the higher-precedence value is shown as the value and the lower one is shown beneath it as the raw/alternate — never as a 50/50 choice.

## 4.5 Copy rules

Five rules. These matter more than the tokens.

1. **Name both sides and the direction.** "Invoice total is ₹45,000.00 higher than the receipt", not "Amount mismatch". *(Expensify: "Amount greater than scanned receipt")*
2. **Name the authority.** "…than the scanned receipt" tells the user which document the comparison was anchored to.
3. **"Couldn't establish" ≠ "disagrees".** When the system could not read a field, say *"Couldn't read the total on this page"* — a claim about Ddetect, not an accusation about the document. *(Ramp)*
4. **Blame the system for the system's failures.** "Couldn't read this file — it may be password protected", not "Invalid file". *(Expensify)*
5. **Past tense for states.** "Reviewed", "Dismissed", "Confirmed" — not "Review", "Dismiss", "Confirm". Those are the buttons. *(Polaris: "Always describe the tone in the past tense.")*

And one prohibition: **never render a machine decision as a celebration.** Ramp's `⛊ Auto-Approved by Policy` is a glyph and plain text — no pill, no green chip, no checkmark animation. An automated determination in an evidence product is information the user may need to overturn, not an achievement to congratulate them on.

---

# 5. Self-critique and revision

## 5.1 The charge I have to answer first

**"Dark navy plus a single accent is a known AI-default. If you land there, justify it against this specific brief or change it."**

I landed there. The structure of what I have proposed — a dark blue-black canvas, a five-step elevation ladder, one warm accent, a red/amber/green semantic set — **is structurally the default.** Saying otherwise would be dishonest. Here is the honest accounting of what is and is not justified.

**What is justified by measurement, not taste:**

- The client asked for royal blue and gold. That is the brief, not my invention.
- The hue distance is real and it is the actual defect being fixed: **5.4° → 166°.** [MEASURED] The old theme's failure was not that it was navy; it was that its accent was *the same navy*. Fixing that is not a style choice.
- Every colour is solved to a contrast target rather than picked, and the audit is 163 checks with 0 failures. That part is not a vibe.

**What is not justified, and what I changed as a result:**

**Navy + gold is itself a cliché** — it is the default of a different genre, "premium fintech", which is arguably worse than the AI-dashboard default because it is trying harder. A gold-buttoned dark app looks like a crypto wallet. The honest defence is not that the colours are unusual; it is that **the gold barely appears.**

> **Gold budget, as an enforceable rule: at most two gold elements per screen, and gold is never a status.** Its entire job is (1) the one primary action and (2) the selected/confirmed state — i.e. it marks *human intent*, in a product where everything else on screen is machine output. That is a real semantic, it is specific to this brief, and it is testable in review: **count the gold. If it is more than two, the screen is wrong.**
>
> Precedent that this is how serious products do it: Stripe's brand colour appears **twice in 3.5 MB** of shipped Dashboard CSS; Linear's survives only as a caret and a focus ring. [PROD]

That defence works for the accent. It does not fully rescue the canvas — a dark blue-grey app in 2026 is a dark blue-grey app. **I am accepting that and pointing at where the actual differentiation has to live: the information design, not the palette.** The things in this document that are genuinely specific to Ddetect are the three-register epistemics (§4.1), the glyph matrix that you read by scanning for gaps (§3.3), the two-column-values / one-column-evidence split (§3.2), and the decision to render agreement as nothing. None of those are colours. A reviewer who says "this looks like every other dark dashboard" is judging the wrong layer, but they will still say it, and the answer has to be that the *screens* don't behave like every other dark dashboard.

## 5.2 Where it is still generic

**1. The tone chips were the most generic thing in the document.** Red/amber/green status chips are the single most recognisable AI-generated-dashboard element in existence, and I had specified a full set with tinted fills and a fill-alpha rule. **Removed.** Severity is now a 3dp rail plus a group header word (§3.1). The change removes six chips from a typical findings screen. Splunk's token restriction (`color, fill` only) says the same thing and I should have followed it from the start rather than deriving a chip system and then reading the research.

**2. Five background elevations is two more than a phone can justify.** I built the ladder because design systems have ladders. On a 360dp screen, `bgSunken` and `bgRaised` are each used in exactly one place. **Kept in the token file, but with a stated budget: any screen using more than three of the five is over-engineered.** In §3, all six screens use exactly `bg` + `surface` + `surfaceAlt`.

**3. `info` (cyan) existed out of habit.** Every design system has an info blue, so I solved one. Then I measured it: `info` at H=219.5° sits **40° from the canvas hue** [MEASURED] — it is a blue on a blue, which is the exact defect I opened this document by diagnosing. It also had no job that `neutral` couldn't do better, because in this product "informational" almost always means "we could not establish this", which Ramp's research says should be grey. **Deleted.**

**4. Radius 6/10/14 was invented, not observed.** Every reference product converges on 4. **Revised to 2/4/8/12.** Chips are 4dp rectangles, not pills.

**5. My first mono argument was an assertion.** "Mono aligns numbers" is what everyone says. It only became an argument when I parsed the fonts and found the 96% width divergence, the three-contour zero, and — the actually decisive one — that Plex Sans and Plex Mono share identical vertical metrics so they mix at the same px size. That third fact is the reason to choose Plex Mono specifically over any other mono, and I would not have found it by reasoning.

## 5.3 What I included out of habit rather than need

- **A shadow scale.** Dark mode does not use shadows at all (§2.12) and light mode needs two. I had five. Cut to two.
- **A spring-based motion system.** The existing `tokens.ts` has springs. Springs are for gestures — dragging, dismissing, snapping — and this app has approximately one gesture. Everything else is a state change, which wants a duration and a curve. **Springs removed.** And `duration.instant = 0` for the *appearance* of feedback turned out to be worth more than any curve.
- **A skeleton-shimmer token.** An animated shimmer on a phone list is a per-frame JS-thread cost for a decorative effect, and with reanimated unavailable it would run on the JS thread during scroll. A static `surfaceAlt` block at the correct height is better and free.
- **Six border tokens.** I mirrored Linear's 24-token border taxonomy before noticing that Linear is a desktop app with hover, focus, and nested-panel states that a phone does not have. **Two: `hairline` and `hairlineStrong`.**
- **A `MEDIUM` severity colour that is actually used.** `warn` orange survives only on the processing screen. On the findings list, MEDIUM gets a rail and the group header word; a second severity hue on a phone list is noise, and it was the pair with the worst hue separation (29.8°).

## 5.4 Revisions made — the diff

| # | Before | After | Why |
| --- | --- | --- | --- |
| 1 | `accent = #3D7BFF` (5.4° from canvas) | `accent = #D4AF37` dark / `#7A6000` light, **≤2 per screen, never a status** | An accent sharing the canvas hue cannot create hierarchy [MEASURED] |
| 2 | `info` cyan in the semantic set | **deleted** | 40° from the canvas hue; blue-on-blue; `neutral` does the job better |
| 3 | `danger` = both findings and system errors | **`conflict`** = proven contradiction only. **`warn`** = system faults. **`neutral`** = couldn't establish | Mercury's reservation; Ramp's three registers. A failed upload is not evidence of anything |
| 4 | Severity chips | Severity **rail + group-header word** | Splunk's `color, fill` token restriction; removes 6 chips per screen |
| 5 | radius 6/10/14 | **2/4/8/12**, chips are rectangles | Measured consensus: EUI/Splunk/Datadog all 4 |
| 6 | Spring motion | **Durations + cubic-bezier**, `in = 0` / `out = 140` | No gestures to spring; Linear's fade-in-0 trick |
| 7 | 5 shadow levels | **0 in dark, 2 in light**, blue-grey tint | Android `elevation` draws a grey keyline on dark; Stripe's tinted ambient |
| 8 | 6 border tokens | **2** | A phone has no hover/nested-panel states to encode |
| 9 | Plus Jakarta Sans as UI face | **IBM Plex Sans**, Jakarta removed from the product | Metrically identical to Plex Mono; narrower; Ramp ships exactly this pair |
| 10 | Confidence as a chip | **3 bars, constant silhouette, unfilled at 40%** | Linear's priority glyph; 13dp vs 72dp; column never jumps |
| 11 | Matrix = frozen label + scrolling values | **Glyph matrix (locate) + tap-to-expand (read)** | 2.33 columns visible was unusable [MEASURED] |
| 12 | Both conflicting amounts in red | **Both neutral; only the difference is red** | Mercury: money is neutral unless direction is semantic. Neither value is wrong |
| 13 | Mono for all values including dates | **Mono only for things compared character-by-character** | A human-readable date gains nothing from mono |
| 14 | "No findings" for both never-run and found-nothing | **Two different screens**, one a prompt and one an `ok` result | NN/g: *"Inaccurate system-status messages for empty states are particularly harmful"* |

## 5.5 What I could not verify, stated plainly

- **`WebSearch` was non-functional for this entire task** (`400: tool_choice names an undeclared local/server tool`). Everything cited was obtained by direct `WebFetch` against named URLs, npm/unpkg token packages, GitHub raw, and parsing local font binaries. A background agent independently reported the same tool failure and one instance of a search tool **fabricating** row-height values. **No number in this document came from a search summary.**
- **Relativity, Logikcull and CrowdStrike Falcon contributed patterns, not measurements.** Their UIs are behind authentication and their design systems are unpublished. The e-discovery findings in §1.1 are behavioural descriptions and should be treated as `[DOCS]`-grade at best.
- **Height.app was completely unreachable** (HTTP 000 across all user agents and protocols). It contributed nothing and should be dropped from the reference set.
- **Linear's runtime theme hexes cannot be recovered** — the tokens are `initial` placeholders resolved in JS by StyleX at runtime. The Linear hexes quoted are from the marketing bundle, which a third party measured as *near but not identical* to the app (`#070707` vs `#08090a`). The *geometry* and the *icon path data* are exact.
- **The ASCII wireframes are dp arithmetic, not renders.** Character cells are not dp. The dimension annotations are computed and correct; the visual proportions in the diagrams are approximate.
- **The 28dp matrix cell has not been tested with a real thumb.** The arithmetic says 8 columns fit at 360dp and the row is a compliant 44dp target. Whether eight glyphs across is *readable* rather than merely *legible* is a question for a device, and it is the highest-risk assumption in this document.
- **The `plugin:figma:figma` MCP server requires OAuth and could not be authorised in a non-interactive session.** If the referenced vendors publish Figma kits, authorising it from an interactive session would close remaining gaps.

---

# Appendix — paste-ready

```ts
// ─── raw palette ────────────────────────────────────────────────────────────
export const dark = {
  bgSunken:'#060E1B', bg:'#0D1727', bgRaised:'#182334',
  surface:'#212D3F', surfaceAlt:'#2E3A4C',
  textPrimary:'#E8EDF5', textSecondary:'#C2CBD7', textTertiary:'#9BA3AD',
  hairline:'#353C45', hairlineStrong:'#5D646D',
  conflict:'#FF7D75', warn:'#F48A34', ok:'#46BD69',
  ai:'#B397FF', accent:'#D4AF37', neutral:'#A4ABB6',
  fillAlpha: 0.14,
} as const;

export const light = {
  bgSunken:'#E9EDF4', bg:'#F4F7FB', bgRaised:'#FFFFFF',
  surface:'#FFFFFF', surfaceAlt:'#EEF2F7',
  textPrimary:'#161F2D', textSecondary:'#454F5E', textTertiary:'#636C7B',
  hairline:'#A9AEB6', hairlineStrong:'#8B8F97',
  conflict:'#B6252B', warn:'#974C00', ok:'#006F31',
  ai:'#7147C0', accent:'#7A6000', neutral:'#5B616B',
  fillAlpha: 0.08,
} as const;

// RULE: tinted tone fills are forbidden on `surfaceAlt`. Tone is text+glyph only there.
// RULE: gold is a non-text accent in light mode. Text-bearing gold is `#7A6000`.

// ─── spacing / radius ───────────────────────────────────────────────────────
export const space  = [0,2,4,8,12,16,20,24,32,40,56] as const;   // space[5] = 16 = gutter
export const radius = { none:0, xs:2, sm:4, md:8, lg:12, full:999 } as const;

// ─── type ───────────────────────────────────────────────────────────────────
// letterSpacing is dp in RN, pre-multiplied here. Max weight 600 outside `display`.
export const type = {
  display:    { f:'IBMPlexSans_700Bold',     s:28, lh:34, ls:-0.5 },
  title:      { f:'IBMPlexSans_600SemiBold', s:22, lh:28, ls:-0.3 },
  heading:    { f:'IBMPlexSans_600SemiBold', s:18, lh:24, ls:-0.2 },
  subheading: { f:'IBMPlexSans_600SemiBold', s:16, lh:22, ls:-0.1 },
  body:       { f:'IBMPlexSans_400Regular',  s:15, lh:22, ls: 0   },
  bodyStrong: { f:'IBMPlexSans_500Medium',   s:15, lh:22, ls: 0   },
  bodySm:     { f:'IBMPlexSans_400Regular',  s:13, lh:18, ls: 0   },
  label:      { f:'IBMPlexSans_500Medium',   s:13, lh:16, ls: 0.1 },
  caption:    { f:'IBMPlexSans_500Medium',   s:11, lh:14, ls: 0.3 },
  overline:   { f:'IBMPlexSans_600SemiBold', s:11, lh:14, ls: 0.8 },
  mono:       { f:'IBMPlexMono_500Medium',   s:15, lh:22, ls: 0   },
  monoSm:     { f:'IBMPlexMono_500Medium',   s:13, lh:18, ls: 0   },
  monoXs:     { f:'IBMPlexMono_400Regular',  s:12, lh:16, ls: 0   },
} as const;

// ─── motion ─────────────────────────────────────────────────────────────────
export const motion = {
  instant:0, fast:80, base:140, slow:200, slower:280,
  standard: Easing.bezier(0.2, 0, 0, 1),
  exit:     Easing.bezier(0.4, 0, 1, 1),
  emphasis: Easing.bezier(0.3, 0, 0, 1),
} as const;
// RULE: never animate height — not native-driver animatable. Cross-fade, let layout snap.
// RULE: feedback appears at `instant`, leaves at `base`.
// RULE: reduce-motion → opacity cross-fade at `fast`, no overshoot. Never 0.

// ─── elevation ──────────────────────────────────────────────────────────────
// DARK: no shadows at all. Depth is the background ladder. Sheets get `hairline`.
export const lightShadow = {
  raised:  { shadowColor:'#1E2536', shadowOpacity:0.06, shadowRadius:2,
             shadowOffset:{width:0,height:1}, elevation:1 },
  overlay: { shadowColor:'#1E2536', shadowOpacity:0.10, shadowRadius:14,
             shadowOffset:{width:0,height:6}, elevation:8 },
} as const;

// ─── always ─────────────────────────────────────────────────────────────────
// borderWidth: StyleSheet.hairlineWidth      — never 1
```

---

# Sources

**Design systems and product documentation**

- GitHub Primer — DataTable guidelines · https://primer.style/product/components/data-table/guidelines/
- GitHub Primer — DataTable overview · https://primer.style/product/components/data-table/
- Google PAIR — People + AI Guidebook, Explainability + Trust · https://pair.withgoogle.com/chapter/explainability-trust/
- Microsoft HAX Toolkit — Guidelines for Human-AI Interaction · https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/
- Microsoft HAX Design Library (G1–G18) · https://www.microsoft.com/en-us/haxtoolkit/library/
- Nielsen Norman Group — Progress Indicators Make a Slow System Less Insufferable · https://www.nngroup.com/articles/progress-indicators/
- Nielsen Norman Group — Empty States in Application Design · https://www.nngroup.com/articles/empty-state-interface-design/
- Linear — Method · https://linear.app/method/introduction
- Linear — Behind the latest design refresh · https://linear.app/blog/behind-the-latest-design-refresh
- Linear — Display options / Configuring workflows / Priority / Peek · https://linear.app/docs/
- Stripe Apps — Design your app · https://docs.stripe.com/stripe-apps/design
- Notion — Using Notion databases · https://www.notion.com/help/guides/using-notion-databases
- Ramp — Receipt verification · https://support.ramp.com/
- Brex — Receipt validation · https://support.brex.com/
- Shopify Polaris — Card, Badge, DataTable · https://polaris.shopify.com/
- Atlassian Design System · https://atlassian.design/
- IBM Carbon Design System · https://carbondesignsystem.com/
- Material Design 3 · https://m3.material.io/

**Shipped code and token packages read directly**

- Linear client bundle — `static.linear.app/client/assets/style-*.css`, `ColorConverter.*.js`, `Status*Icon-*.js`, `Priority*Icon-*.js`
- Stripe Dashboard — Sail CSS bundle
- Mercury — `cdn.mercury.com/builds/*/static/css/main-*.css`
- Expensify — `github.com/Expensify/App` · `src/libs/MergeTransactionUtils.ts`, `src/styles/`, `src/languages/en.ts`
- `react-notion-x` — `packages/react-notion-x/src/styles.css`
- npm via unpkg — `@atlaskit/tokens`, `@carbon/themes`, `@carbon/type`, `@carbon/layout`, `@material/web`, `@shopify/polaris-tokens`, `@primer/primitives`, `@primer/react`
- React Native — `Libraries/Animated/NativeAnimatedAllowlist.js`
- `@expo-google-fonts/ibm-plex-sans`, `ibm-plex-mono`, `plus-jakarta-sans` — TTF `head`/`hhea`/`OS/2`/`cmap`/`hmtx`/`loca`/`glyf` tables parsed locally

**Standards**

- WCAG 2.1 SC 1.4.3 Contrast (Minimum) · https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html
- WCAG 2.1 SC 1.4.11 Non-text Contrast · https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html

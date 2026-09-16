> Historical working note. This records earlier research or defects and may describe behavior that has since changed. Current implementation and acceptance are documented in [PROJECT_SPEC](../PROJECT_SPEC.md), [ARCHITECTURE](../ARCHITECTURE.md), and [rebuild acceptance](rebuild-acceptance.md). Historical measurements and feasibility assumptions below are not current runtime guarantees.
# Adversarial critique of `docs/product-thesis.md`

Written 13 September 2026, against the thesis of the same date and the code as it stands today.

The thesis asks to be argued with. This is the argument. It is deliberately one-sided: it looks for
what is wrong, unbuilt, or self-deceiving. Where a claim holds up it is conceded in one line and
dropped, because a critique that manufactures disagreement is useless.

Every assertion about the code carries a `file:line`. Where I say something does not exist, it is
because a repo-wide search found nothing, not because I did not look.

**The one-sentence verdict.** The thesis is a good piece of thinking about *positioning* and a poor
piece of thinking about *this codebase*. Its philosophy is right — consistency, provenance,
determinism, honest wording — and the domain layer that implements that philosophy is genuinely
strong. But the thesis describes, as settled capability, at least three things the code cannot do,
including its own flagship example and its own named differentiator. It is not a plan; it is a
brochure that has not been checked against the warehouse.

---

## Findings ranked by damage if ignored

| # | Finding | Damage if ignored |
|---|---|---|
| **D1** | The thesis's flagship ₹100 / ₹1000 example **produces zero findings** in today's engine | Catastrophic. The demo fails live. The one story the whole document rests on is not implemented. |
| **D2** | The OCR quarantine — "the single most important safety property" — **does not exist**, and the provenance UI actively **mislabels** model-read digits as "Read from the document" | Catastrophic. The app tells a user in a dispute that a hallucinated number came straight off their document. |
| **D3** | Missing-evidence analysis, the "genuinely novel one", is **structurally unreachable** for every real user, and the thesis describes a capability that is not the one implemented | Severe. The differentiator most cited as defensible is dead code, and the thesis's description of it is false. |
| **D4** | `consistent-amount@1` manufactures **false corroboration** from unrelated documents, with `EXACT_MATCH` confidence | Severe. A dispute tool biased toward telling users their evidence agrees. Failure in the worst direction. |
| **D5** | The shipped AI layer violates §4's never-claim list **wholesale** — numeric confidence, "verified fact", "potential alterations", arbitrator recommendations | Severe. §6.7 is already lost in production. The thesis was written as if the app were a clean slate. |
| **D6** | The comparison matrix as specified — 6 fields × 10 documents — **does not survive a 360dp phone or real sparse data** | High. The "signature view" and "the thing to demo" is a desktop idea that will ship mostly empty. |
| **D7** | §8's bar ("ten mixed files… within a minute") is contradicted by a **strictly single-file upload loop** | High. The bar cannot be met by the flow that exists; ten files is ten full round trips. |
| **D8** | `RuleFinding.inputs` is `Record<string,string>` keyed by document title — **silently loses a value** on duplicate titles, and carries no `evidenceId` or source quote | High. Defeats §5.2 ("tap ₹40,000 and see the sentence") and §6.5 ("every finding carries its inputs") simultaneously. |
| **D9** | `amount-mismatch@1` has two independent emit paths that **do not dedupe against each other** | Medium. The same ₹900 gap reported twice, in different words. Directly undermines "computed, not generated". |
| **D10** | The thesis never asks: what if the **user** is the dishonest party; deletion; multi-user; scale; Devanagari; liability | Medium–High, and one of them (the dishonest user) is an existential product question. |
| **D11** | `impossible-sequence@1`'s HIGH-severity findings rest on **role labels from 40–50 character lookbehinds** over text with no guaranteed reading order | Medium. The most alarming finding type has the most fragile input. |

---

# D1 — The flagship example produces zero findings

Before any of the six attacks, the thing that should stop the room.

> **Claim** (§2). A mall bill says ₹100. A payment screenshot says ₹1000. The app says: *"Two
> documents describe what appears to be the same payment and state different amounts… This needs a
> person to resolve."* — *"That is the product."*

### My attack

Run that scenario against today's engine and **nothing happens**. Not a weak finding. Nothing.

Three independent blockers, any one of which is sufficient:

**(a) The two documents will never be grouped.** `amount-mismatch@1` fires only inside an
`identifierGroups` bucket (`amount-mismatch.ts:53`), which requires two documents to quote the same
normalised reference from `IDENTIFIER_FIELDS` (`support.ts:74-78`) and returns only groups with more
than one member (`support.ts:101-126`). Those fields are populated by `matchLabelled`, whose label
sets are at `deterministic.ts:362-364`:

```
'(?:tax\s+)?invoice'
'(?:order|po|purchase\s+order)'
'(?:transaction|txn|utr|reference|ref|payment)'
```

**"bill", "receipt" and "memo" are absent.** A mall bill says *"Bill No: 4471"*. It matches nothing,
so `invoiceNumbers` is empty, so there is no group. And even if it did match, a UPI screenshot's
transaction ID and a mall bill's bill number are **different strings from different systems** — they
were never going to be equal. The thesis's example is specifically two documents from unrelated
systems, which is precisely the case `identifierGroups` is designed to exclude.

**(b) No rule compares amounts across ungrouped documents.** The only rule that compares amounts
across a whole case without a shared reference is `consistent-amount@1` — and it groups by
`${currency}:${minorUnits}` (`consistent-amount.ts:67`) and reports **only equality**. ₹100 and ₹1000
land in different buckets and are never compared to each other. There is no rule in
`registry.ts:31-44` that says "these two amounts in this case differ". The second emit path of
`amount-mismatch@1` (`:112-174`) would catch it — but only if the user has manually created a claim
**and** manually linked both documents to it with `linkEntities`, which is three deliberate actions
on two other screens, none of which the thesis's scenario includes.

**(c) The screenshot has no text at all.** Images return `text: ''` with `needsOcr: true`
(`ingest.ts:569-583`) unless the user has supplied a Gemini key, and `multimodal-extractor.ts:182-191`
shows the no-key path is the default. With no key, the payment screenshot has `extraction: null`
(`mutations.ts:468`) and `state: 'REVIEW_REQUIRED'`, and contributes nothing to any rule. With a key,
its ₹1,000 is extracted — and then mislabelled `DETERMINISTIC` (Attack 4).

So the single story the entire thesis is built on — quoted in §2, used to justify the reframe in §1,
and the basis of "that is the product" — **cannot be produced by the code the thesis is a thesis
about.** The thesis was written without running its own example.

### Verdict

**Wrong — not as an idea, but as a description of this system.** The finding is the right finding.
The engine cannot reach it.

### What to do instead

1. **Add `bill`, `receipt`, `memo`, `voucher` and `challan` to the `matchLabelled` label sets**
   (`deterministic.ts:362-364`). One line, and it is the most common document word in the target
   market. This does not fix the example, but it is free.
2. **Accept that grouping by shared reference is the wrong primary mechanism for this product.** It
   works for invoice-and-receipt pairs from one vendor's system. It does not work for the *cross-system*
   comparison that is the thesis's own headline. A second grounding mechanism is needed —
   **proximity grouping**: documents whose extracted dates fall within a few days, or whose parties
   overlap after normalisation, or which the user uploaded in the same session. Findings from
   proximity grouping are weaker than findings from a shared reference and must be worded that way
   ("these two may describe the same payment — they are three days apart and name the same
   merchant"), but *weaker and present* beats *rigorous and absent*.
3. **Or make the grouping explicit and cheap.** A "these are about the same thing" multi-select on
   the case screen, taking three taps, produces a user-authored group that the existing rules can
   consume unchanged — the same pattern Attack 3 recommends for missing-evidence. This is the
   fastest route to making the flagship example real: no new rule, no new certainty class, and the
   grounding comes from the user rather than a guess.
4. **Run the example as a test.** `tests/` should contain a fixture that is literally the ₹100 bill
   and the ₹1000 screenshot, asserting that a finding is produced. If the thesis's headline scenario
   is not in the test suite, it is not a specification.

---

# Attack 1 — "Consistency engine, not truth engine"

> **Claim** (§2, §1). The reframe from "is this true" to "do these agree" is the honest and strong
> version of the product, and it resolves the contradiction in the brief.

### My attack

The reasoning is correct. The reframe fails anyway, for a reason the thesis never considers: **it is
a sentence-level fix to a product-level problem.**

A user does not read §2. A user reads, in this order: the app's name, the launcher icon, the home
screen subtitle, the button they press, and the headline number. Every one of those currently says
"truth engine", and three of them cannot be fixed by rewording.

1. **The name.** The product is called **Ddetect**. "Detect" is transitive and it takes an object,
   and in this context the object everyone supplies is *lies*. No amount of careful copy inside the
   app survives a name that is a truth claim. The thesis makes wording "a hard constraint, not a
   style preference" (§6.7) and then never applies that constraint to the loudest word in the
   product. That is not an oversight in the copy; it is an unexamined premise.

2. **The subtitle, shipped today.** `app/(tabs)/index.tsx:98` — `Forensic Evidence
   Cross-Verification`. Three words, three violations. "Forensic" implies an expert methodology with
   a court behind it. "Verification" is on §4's banned list verbatim. This is the first line of text
   a user ever reads.

3. **The headline metric.** The dashboard counts **"Conflicts"** (`app/(tabs)/index.tsx:51-56`,
   `132-143`). Not "things to check". A conflict is an accusation with a number attached. The
   thesis's own preferred vocabulary — "needs review", "worth checking" — is used carefully inside
   `amount-mismatch.ts:98` and then thrown away by the tile that aggregates it.

4. **The export.** `app/case/[caseId]/export.tsx:281` prints *"Autonomous Evidence Analysis &
   Conflict Verification Platform"* into the PDF header, and `:302` heads a section *"Evaluated
   Claims & Veracity Analysis"*. **Veracity** is Latin for "truth". This is in the single artefact
   the user hands to a landlord, an insurer or a small-claims registrar — the exact document where
   the reframe matters most, and the one place the thesis never audits. Note the irony: the same
   file's body text is scrupulous (`:350-352` — "not a certified, signed or legally attested
   record, and nothing in it should be treated as proof"). The honest paragraph is buried under a
   dishonest letterhead, and letterheads are what people read.

5. **The AI modal.** `app/case/[caseId]/index.tsx:803` — `EXECUTIVE DISPUTE ASSESSMENT`; `:882` —
   `ARBITRATOR RECOMMENDATION`. An arbitrator is a person with binding authority. See Attack 5.

Now the deeper point. Even with perfect wording, **"do these agree?" is heard as a truth claim by a
normal person, because of who is asking.** The user did not open a document-comparison utility. They
opened an app because they are in a fight and they want ammunition. In that state, "these two
documents disagree" is not received as a statement about documents. It is received as *"the other
side is lying"* when the conflict is in the opponent's file, and as *"you are about to be caught"*
when it is in their own. The subject of the sentence is documents; the subject of the *interpretation*
is people. The thesis writes a careful sentence and assumes it will be parsed carefully.

There is a sharper failure mode. The reframe is *asymmetric and the thesis does not notice*: when
Ddetect says **nothing**, a user hears **"my evidence is clean"**. The thesis prohibits claiming
completeness (§4) but the entire UI — a "Run Analysis Engine" button, a spinner, a finished state —
is the grammar of a scan that has concluded. Antivirus taught everyone what a green tick means. A
case with no findings because nothing extracted is visually identical to a case with no findings
because everything agreed, and the second is what the user will believe. **Silence is the app's most
common output and the thesis has no wording rule for it at all.**

### Verdict

**Right in substance, failing at every point of contact, and incomplete.** The reframe is correct.
The claim that it is *sufficient* is wrong. And the thesis omits the one output — silence — that
needs the hardest wording of all.

### What to do instead

1. **Fix the name or accept the burden.** If "Ddetect" ships, then every surface needs a
   counterweight. A rename to something about the *case file* rather than the detection ("Casefile",
   "Crossref", "Ledger") removes the problem at the root and costs nothing this early.
2. **Kill "Forensic" and "Verification" everywhere**, starting with `app/(tabs)/index.tsx:98` and
   `app/case/[caseId]/export.tsx:281,302`.
3. **Rename the metric.** "Conflicts" → **"To check"**. Counting problems is a different product from
   counting accusations.
4. **Write the silence rule, and make it §6.8.** Never render an empty findings list as an
   achievement. Render *coverage*: "Compared 4 of 10 documents. Six gave us no readable values, so
   they were not compared." Coverage-first is the honest empty state and it also happens to be the
   best possible prompt for the next user action.
5. **Add a banned-word test.** §6.7 declares a constraint with no mechanism, so it has already
   rotted. A test that walks `app/**/*.tsx` and `src/**/*.ts` for `/verif|proven|authentic|veracity|
   fraud|court-admissible/i` outside an allowlist of explicitly-negated sentences turns a style note
   into something CI can fail on. Without it, §6.7 is a wish.

---

# Attack 2 — "The comparison matrix is the killer feature"

> **Claim** (§5.1, §6.6). Rows are fields, columns are documents. Agreement, conflict and absence
> visible at a glance. A chat interface fundamentally cannot produce this. It is the signature view
> and a first-class screen — "the thing to demo".

### My attack

**It does not exist.** A repo-wide search for matrix / comparison grid / fields-by-document returns
nothing across all 26 screens in `app/` and all of `src/`. The only table in the codebase is the
one-row-per-document HTML list in `export.tsx`. The thesis's signature view, its designated demo,
and its number-one differentiator against ChatGPT, is unbuilt. Everything below is therefore about
whether it *should* be built as specified.

**On the phone.** 6 × 10 is sixty cells. A cell holding `₹1,00,000.00` needs roughly 88dp at a
readable size. Ten columns is ~880dp of content against a 360dp viewport — **2.4 screen widths** —
plus a row-label column that must stay frozen or the grid is meaningless. That means two-axis
scrolling with a sticky header row and a sticky first column. In React Native that is two
synchronised `ScrollView`s or a re-render on every scroll frame; it is achievable and it is
miserable. And the mode the matrix exists for — *at a glance* — is precisely the one a 360dp viewport
cannot deliver. You cannot glance at something that is 240% off-screen. The thesis's own argument
against prose ("prose cannot show you 60 cells at once") **applies to the phone with equal force**.
It is an argument for a desktop app, made inside a mobile product, and the thesis does not notice
that it has proved too much.

**On real data, it is worse than sparse — it is misleading.** Three compounding problems:

1. **"Six extractable fields each" is not what the extractor produces.** `Extraction`
   (`src/domain/models.ts`) is arrays, not scalars: `dates[]`, `amounts[]`, `people[]`,
   `organizations[]`, `invoiceNumbers[]`, `orderNumbers[]`, `transactionIds[]`, `keywords[]`. An
   invoice yields four amounts (subtotal, tax, total, advance) and three dates. So a row cannot be
   "amount"; it must be "amount labelled total", "amount labelled paid", and so on — and those role
   labels are themselves unreliable (see Attack 5, D11). The clean 6 × 10 grid in the thesis
   requires a scalar projection of the data model that does not exist and that the extractor cannot
   reliably produce. Also note `deterministic.ts:365` hardcodes `addresses: []` — a declared field
   that is never populated, i.e. a guaranteed-empty row.

2. **The realistic case is 70%+ empty, and the empties are the important documents.** Take the
   thesis's own ten mixed files: 3 text-layer PDFs, 4 phone photos of paper bills, 2 chat
   screenshots, 1 typed note. The photos and screenshots return `text: ''` with `needsOcr: true`
   (`src/services/ingestion/ingest.ts:569-583`) unless the user has supplied a Gemini key, which
   `multimodal-extractor.ts:182-191` shows is not the default state. So **seven of ten columns are
   entirely blank**, and they are the seven the user most wants explained. A grid that is 70% empty
   does not read as "absence is informative", which is the thesis's hope. It reads as **broken**.
   The user's conclusion is "this app didn't work", and they are approximately right.

3. **Most non-empty cells will differ for boring reasons, so the conflict colouring is noise.** A
   matrix over *all* documents places an electricity bill next to a rent receipt next to a WhatsApp
   export. Of course their dates and amounts differ. Disagreement is only meaningful between
   documents *about the same thing* — which is exactly the discipline `identifierGroups`
   (`src/domain/rules/support.ts:101-126`) enforces for the rule engine and which the global matrix
   throws away. The matrix as specified is **less rigorous than the engine behind it**.

**And the strategic error.** The thesis claims the matrix is what ChatGPT cannot replicate. That is
the weakest of its five differentiators. A competent engineer gets a passable HTML table out of GPT
in one prompt. What ChatGPT genuinely cannot do is **§5.2 (every value linked to the sentence it came
from) and §5.3 (byte-identical output on re-run)**. The thesis has ranked its differentiators in
almost exactly the wrong order: it put the most replicable one first because it is the most
*screenshot-able*. That is a pitch-deck instinct, not a product one.

### Verdict

**Needs modification, and needs demoting.** The *idea* — value-by-value side-by-side with provenance
— is right and worth building. "Rows are fields, columns are all ten documents, and it is the
headline screen" is wrong on mobile, wrong on sparse data, and wrong in its ranking.

### What to do instead

1. **The matrix is right; "all documents" is wrong. Scope it to a comparison group.** Launch
   "Compare" *from* something that already establishes relevance: an identifier group, a claim, an
   event, a finding, or a two-document user selection. Two to four columns and four to eight rows
   fits 360dp with **no horizontal scroll and every cell populated**. Same idea, one-tenth the
   surface, ten times the density.
2. **Ship the two-document compare first.** The "45 pairs" claim (§5.3) is a property of the
   *engine*, not of the UI. The UI only ever needs to show the pairs that disagree. Build
   `Compare(A, B)` as a route reachable from any finding; the global grid, if it is ever built,
   becomes an index over those.
3. **Replace the global grid with a coverage grid.** Rows are documents, columns are three booleans:
   *has a date / has an amount / has a reference*. Dense, mobile-native, never empty, and it answers
   the question a user actually has after upload — "which of my files gave you nothing?" This also
   makes the failures legible instead of invisible, which is the honesty property the thesis wants.
4. **Re-rank §5.** Provenance (currently 2) and reproducibility (currently 3) are the defensible
   differentiators. Lead with them.

---

# Attack 3 — "Missing-evidence analysis is genuinely novel"

> **Claim** (§5.4, §4). "The app reasons about the *shape* of a complete evidence set and reports
> the holes: 'Nothing in this case establishes a payment due date, so the payment was late cannot be
> assessed.'" Classified **Certain** in §4 — "it's a set difference".

This is the weakest section of the thesis, as suspected, and it is weak in three separate ways at
once.

### My attack

**(a) What is implemented is not what is described.** `missing-evidence@1`
(`src/domain/rules/definitions/missing-evidence.ts:46-52`) iterates `claim.requiredEventIds`, looks
up each event, and fires when no evidence is linked to it. In plain words: *"you told us this event
matters and you have not attached a file to it."* That is a **to-do list derived from the user's own
data entry**. It is not reasoning about the shape of a complete evidence set, and it can never
produce the thesis's example sentence, because nothing in the system has any concept of a "payment
due date" being required. The thesis attributes novelty to a capability the codebase does not have.

**(b) It cannot fire for any real user.** `requiredEventIds` appears at exactly six places in the
repo. It is defaulted to `[]` at `src/domain/models.ts:159` and `src/data/mutations.ts:203`; it is
*patchable* via `updateClaim` (`mutations.ts:232`); it is *read* by the two rules; and it is *set*
in exactly one place — the test corpus builder (`tests/fixtures/build-sample-workspace.ts`, moved
there from `src/data/seed/build-demo-case.ts` since this review). The claim-creation UI
(`app/case/[caseId]/index.tsx:212-215`) passes `statement` and `detail` only. **There is no screen,
anywhere in the app, that lets a user mark an event as required by a claim.** Therefore
`claim.requiredEventIds` is `[]` for every claim a human has ever created, therefore the inner loop
at `missing-evidence.ts:47` never executes, therefore **the rule is unreachable outside the test
corpus**. The thesis's named novel differentiator is, today, code that cannot run.

**(c) The `SUGGESTIONS` table is the hardcoding the client forbade — and it is worse than
hardcoding, because it is *cosmetic*.** `missing-evidence.ts:8-14` is a five-entry regex→string
lookup: `/\b(paid|payment|transfer|settled|remit)\b/i` → *"a bank statement line, payment receipt or
UPI/transfer confirmation"*, with the fallback at `:19` *"any document created at the time that
mentions this event"*. Three observations:

- It is a keyword match on an English string the user typed. It encodes exactly the domain
  assumption the brief prohibits, in the crudest available form.
- It is English-only, so it degrades to the generic fallback for any Hindi or transliterated event
  title — which is most of the target market.
- Crucially, **it contributes nothing to the finding's logic.** The finding fires on a set
  difference over user data; the table only decorates the explanation string. So the hardcoding buys
  no capability. It is pure liability: the one thing the client named as forbidden, present, for
  prose polish.

**(d) The "Certain" classification in §4 is a category error.** "It's a set difference" is true only
once you have both sets. The set difference is certain; **the right-hand set is the entire problem**,
and it is a domain judgement, not a computation. Putting missing-evidence in the same column as
SHA-256 equality is the single most misleading row in §4's table. `10000 ≠ 100000` is arithmetic.
"A payment dispute requires a due date" is an opinion about Indian consumer disputes that varies by
contract, by relationship and by jurisdiction.

Now, the thesis is right that this capability is the most valuable one. So here is how to build it
honestly, rather than killing it.

### Verdict

**The claim of novelty survives; everything attached to it is wrong.** The described capability is
not built. The built capability is misdescribed. The implementation contains the forbidden
hardcoding for no functional gain. The "Certain" classification is wrong for any version that needs
a template.

### What to do instead

**Three layers, in build order. Layer 1 is the genuinely dynamic implementation the thesis missed.**

**Layer 1 — role-pairing over the user's own corpus. No domain knowledge. Ships first.**

The extractor already assigns semantic roles it derived from the documents themselves:
`role: 'issued' | 'due' | 'paid' | 'delivered'` on dates (`deterministic.ts:114-123`) and
`'total' | 'tax' | 'paid' | 'advance'` on amounts (`:177-186`). That is a structural vocabulary
*observed in the user's actual files*, not imposed on them. A new rule can then say:

> "Four documents in this case carry a **due** date. None carries a **paid** date. If a payment
> happened, nothing here records when."

and

> "Every invoice reference in this case has a document quoting a **paid** amount against it, except
> `INV-2024-021`."

This is a set difference — genuinely, in the §4 sense — but the right-hand set is **derived from the
structure the corpus already exhibits**, not from a template. No category. No hardcoded knowledge of
what a payment dispute contains. It cannot be accused of assuming anything, because every role it
names was read off one of the user's own documents. It works in any domain and any language the
extractor supports. And it degrades safely: a case with no roles produces no findings, which is
correct.

This is the version that deserves the word "novel", and it is the one the thesis did not think of.

**Layer 2 — asymmetry gaps.** Where N-1 members of a group have a property and one does not, say so.
Same mechanism, no new knowledge, high hit rate on real case files.

**Layer 3 — the model proposes, the user authorises, the engine computes.** For the thesis's actual
example sentence you do need a checklist. Get it from the model *at case creation*, show it as an
editable list — "disputes like this usually contain: an agreement, an invoice, a stated due date, a
payment record, a chaser message" — and let the user tick, edit and delete. The accepted list is then
**user-authored structure**, stored like `requiredEventIds` is stored now, and the deterministic rule
does the set difference against it.

This is the move that resolves the contradiction: **the knowledge comes from the model, the
authority comes from the user, and the finding stays deterministic.** It is not hardcoded (no
template ships in the binary). It is not a model opinion presented as fact (the user authorised
every line). And "Certain" attaches honestly to the difference, while the checklist itself is
labelled as what it is.

**And regardless of all of the above: build the UI for `requiredEventIds`.** The data model has
supported this since day one and two rules depend on it. A multi-select of events on the claim
screen is perhaps eighty lines of code and it resurrects the rule that the thesis calls its best
idea. **Delete the `SUGGESTIONS` table when you do** — replace the suggestion string with the roles
the corpus is missing (Layer 1), which is both more specific and free of assumptions.

---

# Attack 4 — "OCR values are quarantined until confirmed"

> **Claim** (§4, §6.2). "`method: 'OCR'` cannot trigger a conflict finding. It routes to a
> confirmation step first. **This is the single most important safety property in the pipeline.**"

### My attack

**It is not implemented, on either side, and the failure is worse than absence.**

**Side one — the stamp is wrong.** `app/case/[caseId]/upload.tsx:228` calls
`extractEvidenceFromImage`, which recognises the characters on the device with ML Kit and sends only
that recognised text to a Groq chat model to be grouped into fields — no model is shown the pixels,
because Groq serves no multimodal chat model and a Gemini key cannot be stored on the handset at all
(`src/services/ai/multimodal-extractor.ts:283-291,355`, `src/services/ai/credentials.ts:69`). The
transcription is passed as plain `text` to `createFileEvidence` (`upload.tsx:362`). That function
builds the extraction at `src/data/mutations.ts:468`:

```ts
extraction: text ? extractFromText({ evidenceId: id, title, text }) : null,
```

No `method` argument. And `src/domain/extraction/deterministic.ts:342`:

```ts
const method = input.method ?? 'DETERMINISTIC';
```

So **every value a vision model read off a photograph is stored as `DETERMINISTIC`** — the
second-highest trust tier, the one reserved for characters lifted out of a PDF text layer.
`deterministic.ts:36` declares `method?: 'DETERMINISTIC' | 'OCR'` as an optional parameter; **no
caller in the repo ever supplies it.** The string `method: 'OCR'` is passed nowhere.

**Side two — there is no gate.** Searching all of `src/domain/rules/` for `method`, `OCR`,
`confirmed` or `provenance` returns **zero gating logic**. Not one of the twelve rules in
`registry.ts:31-44` inspects provenance. `effectiveExtraction` (`src/domain/extraction/merge.ts:38`)
hands every field to the engine regardless of how it was obtained. So even with a correct stamp,
nothing would consume it. Both halves of §6.2 are unbuilt.

**Side three, and this is the part that turns a missing feature into a live defect.** The provenance
UI is the product's credibility mechanism — `ProvenanceValue.tsx` encodes method in typeface, colour
and icon. `src/ui/semantics.ts:231-236`:

```ts
MANUAL: 'Entered by you',
DETERMINISTIC: 'Read from the document',
OCR: 'Read by OCR',
AI: 'Suggested by AI',
```

A digit that Gemini guessed from a blurry photo of a mall bill is rendered to the user under the
words **"Read from the document."** That is not a missing safeguard. That is the app **asserting the
opposite of the truth**, in the one component whose stated purpose is that "a user can always tell
what a document said from what the system concluded". The thesis names this the single most
important safety property; the implementation is an active misstatement. (`ProvenanceValue.tsx:161`
compounds it — OCR and DETERMINISTIC share the `text-search` icon, so even a correct stamp would
render identically.)

Credit where due: the **AI** path is done properly. `src/services/ai/provenance.ts:94` hardcodes
`method: 'AI'`, `:305` hardcodes `status: 'SUGGESTED'`, and `occursInSource` (`:109-114`) discards
any model value not present verbatim in the source text while re-deriving `iso`/`minorUnits` through
the deterministic normalizers. The discipline exists. It was simply never applied to the vision path.

**Now the thesis's own question: would a strict quarantine make the app useless?**

As the thesis words it — **yes, and it also has the granularity wrong.** "Routes to a confirmation
step first" implies field-level confirmation. A photographed invoice yields four amounts, three
dates, two parties and a reference: ten-plus fields. Ten photos is a hundred-plus confirmations
before the app says anything. That is not a middle path, it is data entry with a review queue, and
it kills §8 outright.

But the thesis also has the *risk model* wrong, and getting it right is what unlocks the middle
path. **The danger is asymmetric.** A misread digit can fabricate a conflict where none exists —
`₹7,000` read as `₹1,000` invents a ₹6,000 discrepancy, and the user acts on it. A misread digit can
also *destroy* a real conflict — but that failure mode is **silence**, not a false accusation, and
silence is the safe direction. Two independent misreads landing on the same wrong value is
vanishingly unlikely. So:

> **OCR values may not create a conflict. OCR values may safely create a grouping, an ordering, or a
> corroboration at reduced confidence.**

That asymmetry is derivable from first principles, it is more permissive than §6.2, and it is
strictly safer than what ships today.

### Verdict

**Right in principle, unimplemented in fact, and wrong in granularity.** The safety property is
correct and urgent. Field-level confirmation as the mechanism would kill the product. And the status
quo is not merely "quarantine missing" — it is a positive misstatement in the provenance UI.

### What to do instead

**Fix the stamp today.** One argument at `src/data/mutations.ts:468`. `createFileEvidence` needs an
`extractionMethod` on its input and `upload.tsx` must pass `'OCR'` when the text came from
`extractEvidenceFromImage`. Give OCR its own icon and colour at `ProvenanceValue.tsx:161` and
`semantics.ts`. Nothing else in this critique is cheaper or more urgent.

**Then quarantine at the *finding* level, not the value level.** This is the middle path. A rule
computes its finding as normal; the engine then inspects the provenance of the compared fields. If
any is `OCR` and unconfirmed, the finding is emitted as **provisional** rather than suppressed — and
the finding itself becomes the confirmation prompt:

> **Possible ₹900 difference — needs your eye**
> The mall bill appears to say **₹100**. We read that from a photo, so it may be wrong.
> [ It says ₹100 ] [ It says something else ]

One tap. The user confirms **only the values that would change an answer**, which for ten documents
is perhaps three taps rather than a hundred. The confirmation burden drops from O(fields) to
O(candidate findings), and — the part that matters commercially — **the confirmation stops feeling
like data entry and starts feeling like the product**. The app is showing you something you did not
know and asking one question about it. That is a good screen. A form with a hundred checkboxes is
not.

**Concretely, what an unconfirmed OCR value may legitimately do:**

| Participate in | Allowed | Why |
|---|---|---|
| Identifier grouping (`support.ts:101`) | **Yes** | A misread reference causes a *missed* group. Failure mode is silence. |
| Timeline ordering | **Yes**, marked provisional | Wrong position is visible and self-correcting; the user is looking at the dates. |
| Corroboration (`consistent-amount@1`) | **Yes**, confidence downgraded from `EXACT_MATCH` | Two independent misreads agreeing is improbable. |
| Duplicate detection | **Yes** | Runs on file bytes (`duplicate-evidence.ts:28-29`), not on extracted text. Unaffected. |
| Conflict findings (`amount-mismatch@1`, `event-date-conflict@1`, `impossible-sequence@1`) | **Provisional only, never asserted** | The only path where a misread manufactures a false accusation. |

Add `provisional: boolean` to `RuleFinding` derived from the methods of the compared fields. The
information is already present — rules receive `Extraction` objects with per-field `method`. The
engine simply ignores it today.

---

# Attack 5 — Do the rules do what their names claim?

> **Claim** (§4). Duplicate detection, amount conflicts, date conflicts, shared identifiers and
> entity resolution are all **Certain**. (§3) "A program does all 45, every time, identically."

Rule by rule. Two are honest, two are misleadingly described, one is dangerous, one is unreachable
(Attack 3), and the AI layer bolted alongside them repudiates the whole document.

### 5a. `duplicate-evidence@1` — honest

`src/domain/rules/definitions/duplicate-evidence.ts:28-29` groups on SHA-256 of the file bytes and
nothing else; `confidence: 'EXACT_MATCH'`. Does exactly what the name says and claims exactly what it
can support. **Correct, well-founded, no notes.** One small caveat worth stating in the UI: this
catches *byte-identical* files, so the same receipt re-photographed, or a PDF re-saved, will not
match. Users will read "duplicate detection" more broadly than the rule delivers, and the copy should
close that gap.

### 5b. `amount-mismatch@1` — grounded, but double-reports

The design discipline is good: it only fires inside an `identifierGroups` bucket, so two documents
must already quote the same normalised reference (`amount-mismatch.ts:53`); `headlineAmount`
(`:15-21`) avoids comparing a line item against a total; comparison is integer minor units;
tolerances at `:7-8` suppress rounding and fee noise; the explanation at `:92-97` is a model of
honest wording. Concede all of that.

**But there are two independent emit paths that do not know about each other.** Path 1 (`:53-108`)
keys on `[group.field, group.value, currency]` (`:90`). Path 2 (`:112-174`) keys on
`['claim-amount-mismatch', claim.id, currency, ...involved]` (`:157`). The `processedPairs` guard at
`:111` only dedupes *within* path 2. So an invoice and a receipt that both quote `INV-2024-018` **and**
are both linked to the same claim — the single most likely configuration in a well-organised case —
generate **two findings for one ₹900 gap**, with different titles and different `inputs`, both
`severity: 'HIGH'`. The engine's own dedupe (`engine.ts:179`) is by derived id, and the ids differ,
so it does not catch this.

Two consequences. The "Conflicts" count on the dashboard double-counts, so the user's headline number
is wrong. And more corrosively, it breaks the thesis's central promise: **an engine that reports one
fact twice is not "computed, not generated" in the way §3 means**. The user who notices will trust
nothing else on the screen.

**Fix:** make path 2 skip any pair already emitted by path 1 — carry one `Set` of sorted pair keys
across both loops. Ten lines.

### 5c. `consistent-amount@1` — this one is dangerous

The mirror of 5b, and it has none of 5b's discipline. `consistent-amount.ts:67` groups amounts across
**all** evidence in the case by `${currency}:${minorUnits}`, with **no shared reference, no shared
claim, no shared date, no grounding of any kind**, and reports the group as corroboration with
`confidence: 'EXACT_MATCH'`.

So two unrelated ₹5,000 rent receipts, from different months, become *"Matching amount INR 5,000.00
corroborated across 2 sources."* Round numbers are the norm in exactly this app's domain — rent,
deposits, fees, EMIs. This rule will fire constantly and it will almost always be wrong.

Look at the asymmetry it creates. The rule that says *your documents disagree* demands a shared
reference number before it will speak. The rule that says *your documents agree* demands nothing at
all. **The app is structurally biased toward telling users their evidence corroborates itself** — and
it stamps that reassurance `EXACT_MATCH`, the highest confidence band in the system
(`enums.ts:89`). In a product whose entire purpose is to find problems before an opponent does, and
whose §1 explicitly warns that *"agreeing documents are the easy thing to fake"*, this is failure in
the worst available direction: false comfort, delivered with maximum confidence, to someone about to
walk into a hearing.

This is a §4 violation too. "Corroborated across 2 sources" with `EXACT_MATCH` is, to a normal
reader, a claim of verification.

**Fix, urgently:** gate `consistent-amount@1` behind the same `identifierGroups` / shared-claim
grounding as `amount-mismatch@1`. If two documents have no established relationship, the fact that
both mention ₹5,000 is not corroboration and must not be reported as such. Downgrade the confidence
band and reword to "Both documents state ₹5,000" — a statement of fact rather than a conclusion about
support.

### 5d. `impossible-sequence@1` — right logic, fragile foundation

`impossible-sequence.ts` checks four orderings (paid-before-issued, delivered-after-paid,
due-before-issued, short-payment) with `SLACK_DAYS = 1` (`:14`), scoped to `identifierGroups`. The
logic is sound and the scoping is correct.

"Paid before billed" is close to an accusation of fabrication, and it ships at HIGH severity. So the
inputs deserve scrutiny — and they are the weakest in the system:

- Roles come from a **40-character lookbehind** for dates (`deterministic.ts:114-123`) and a
  **50-character lookbehind** for amounts (`:177-186`). A two-column invoice layout, a line break
  between label and value, or a table cell puts the label outside the window and the role is lost —
  or, worse, attaches the label from an adjacent row.
- PDF reading order is explicitly not guaranteed. `src/services/ingestion/pdf-text.ts:19-31`
  documents that multi-column text interleaves. So the 40 characters preceding a date in the
  extracted string may be from a different column of the page.
- `extractAmounts` dedupes by `${currency}:${minorUnits}` keeping the **first** occurrence
  (`deterministic.ts:173-175`). If a figure appears once unlabelled and once under "Paid", the
  labelled instance is discarded and the role is lost entirely.

None of this makes the rule wrong. It makes its **severity** wrong. A HIGH finding that a document is
impossible should not rest on a regex window over text with no guaranteed order.

**Fix:** propagate role confidence. If a role was assigned from a lookbehind (rather than an explicit
adjacent label match), emit at MEDIUM and word it as *"the labels we read suggest this order, which
would be unusual — please check"*. Reserve HIGH for roles the user has confirmed. This is the same
provisional mechanism Attack 4 needs; build it once.

### 5e. `event-date-conflict@1` — genuinely careful, concede it

`event-date-conflict.ts:19-27` abstains entirely unless there is exactly one role-labelled date or
exactly one day-precision date, and `:92` downgrades severity when `ambiguous` is set — the DMY/MDY
trap that `dates.ts:106-112` detects. `datesConflict` compares at the coarser of the two precisions
(`dates.ts:168-173`), so `March 2024` does not conflict with `15/03/2024`. This is exactly the
discipline §4 promises and it is rare to find it actually implemented. **Right, well-founded, no
notes.**

### 5f. `orphaned-evidence@1` — fine, but note the early return

`orphaned-evidence.ts:42` returns immediately when the case has no claims and no events. Correct (a
case that is purely a document pile has no orphans by definition), but it means that a user who
uploads ten files and creates nothing else gets **no findings at all from five of the twelve rules** —
and the app's empty result will read to them as "your evidence is clean". See the silence problem in
Attack 1.

### 5g. The AI layer repudiates the entire thesis

This is not a rule, but it ships in the same screen as the rules and users cannot tell them apart.

`src/services/ai/prompts.ts:53-60` contains a guard-rail preamble that is genuinely excellent — rule
4 forbids stating or implying that anything is "proven, verified, authenticated, genuine, fraudulent,
or legally established". Then `MULTI_ANGLE_FORENSIC_PROMPT` (`:228-286`), in the same file, asks the
model for:

- `"confidenceScore": 85` (`:251`) — §4: *"A numeric confidence for a model's own opinion… is a
  fabricated measurement. Bands only."*
- `"fact": "Description of the verified fact"` (`:255`) — the banned word, in the schema.
- `"credibilityObservation"` (`:272`) — a judgement about a source's trustworthiness.
- *"potential alterations"* (`:237`) — §4: *"An edited screenshot is indistinguishable from a real
  one at this level of analysis. Full stop."* This asks a text model to detect image tampering.
- `posture: "STRONGLY_SUPPORTED"` (`:250`) and the persona *"a senior forensic evidence examiner"*
  (`:229`).

And `CLAIM_PROOF_PROMPT:179` retains a `PROVED` verdict (the file's own comment at `:156-165`
acknowledges this and calls `SUPPORTED` the honest name).

It renders as: `Multi-Angle AI` chip (`app/case/[caseId]/index.tsx:552-553`), `EXECUTIVE DISPUTE
ASSESSMENT` (`:803`), `Critical Dispute Inconsistency` (`:815`), `CLAIM EVIDENTIARY STRENGTH` with
STRONG / MODERATE / WEAK chips (`:826-849`), and **`ARBITRATOR RECOMMENDATION`** (`:882`). Plus
`app/case/[caseId]/evidence/[evidenceId].tsx:217` — *"Evidence verified and confirmed."*

**The thesis was written as if this did not exist.** §5's cut-list ("what would be decorative")
names confidence percentages and "PROOF" tags, and does not mention the LLM verdict layer that is
the largest feature in the case screen. A document that says "wording is a hard constraint" while the
shipped app recommends an arbitration outcome with an 85% confidence score has not confronted its own
product.

### Verdict (Attack 5 overall)

**Mixed, and §4's certainty table is wrong in two rows.** Duplicate detection and date conflicts are
exactly as advertised. Amount conflicts are grounded but double-report. Missing-evidence is
unreachable and misdescribed. `consistent-amount@1` is an ungrounded reassurance machine. And the AI
verdict layer contradicts §4 line by line, in the same screen as the honest rules.

### What to do instead

1. **Ground `consistent-amount@1` or delete it.** Highest-priority rule fix.
2. **Dedupe the two `amount-mismatch@1` paths.**
3. **Cut or rewrite `MULTI_ANGLE_FORENSIC_PROMPT`.** Remove `confidenceScore`, `verified fact`,
   `credibilityObservation` and "potential alterations". Drop the "forensic examiner" persona.
   Bump `PROMPT_VERSION` — `prompts.ts:12` says to, and it is right.
4. **Delete `ARBITRATOR RECOMMENDATION` outright.** There is no wording of it that is honest.
5. **Rename `PROVED` → `SUPPORTED`** and migrate. The file already knows.
6. **Visually separate computed findings from model output.** Right now they share a screen and a
   vocabulary. Every AI surface needs the same treatment `provenance.ts` gives AI field values.
7. **Split §4's certainty column** into *certain*, *certain given correct extraction*, and *depends
   on a judgement*. Duplicate detection is the first. Amount and date conflicts are the second —
   the arithmetic is certain but the extraction is not, and §4 currently conflates these.
   Missing-evidence is the third.

---

# Attack 6 — What is missing from the thesis entirely

Eight things. The first is an existential product question the thesis does not know it has raised.

### 6a. What happens when the user is the dishonest party — **the unasked question**

§1 says, correctly: *"agreeing documents are the easy thing to fake."* §2 then defines the product
as *"finds where a person's own evidence disagrees with itself, and shows exactly where and by how
much."*

Read those together. **Ddetect is a quality-assurance tool for fabricated evidence.** A user who has
forged one document uploads their set, and the app tells them — precisely, with the exact rupee gap,
the exact date inconsistency, and a page reference — which of their documents will betray them. They
fix it. They upload again. They iterate until the app is silent. Then they file.

The thesis identified the exact mechanism and did not turn it around. This is not a hypothetical
abuse case; it is the *primary use case run by a dishonest user*, and it works better for them than
for an honest one, because an honest user's inconsistencies are usually real and unfixable while a
forger's are edits.

It gets worse in the code. §5.5 makes the manual override *permanent* — no machine pass can overwrite
`MANUAL` provenance (`merge.ts:24-32,60-81`). So the **highest-trust tier in the provenance hierarchy
is the one with zero verification**. A user can overwrite any extracted value with anything, the
conflict disappears, the export renders the doctored figure in the "Entered by you" style, and the
audit log records a correction — not a falsification — because nothing distinguishes the two.

I do not think this kills the product. Every organisational tool can be misused this way, and a
spreadsheet is worse. But the thesis **must** address it, because it determines wording, export
design and legal posture.

**What to do:** (i) the export must render manual overrides *alongside* the original machine-read
value, never in place of it — "Entered by you: ₹1,000 (document reads: ₹100)". That single change
makes the app useless for polishing a forgery while remaining fully useful for correcting an OCR
error, because the honest correction survives disclosure and the dishonest one does not. (ii) Never
show a "0 conflicts" state as an achievement (Attack 1). (iii) Add to §4: *the app must never imply
that an absence of findings indicates honesty.*

### 6b. Deletion — soft-only, and the bytes never leave

- `deleteCase` (`mutations.ts:171`) and `deleteEvidence` (`:576`) set `deletedAt` and nothing more.
  There is **no hard delete anywhere** — `deleteDoc` has zero occurrences in `src/`.
- `deleteCase` has **no caller in any screen**. A user cannot delete a case at all.
- Files go to Cloudinary via an unsigned preset (`src/services/storage/cloudinary.ts:221,336`) and
  land at a **public `secure_url`** stored as `evidence.storagePath`. `cloudinary.ts` has **no
  destroy function** — correctly, since the Admin API needs the secret that is correctly absent. The
  consequence is unavoidable and permanent: **there is no code path, now or possible, by which a
  user's uploaded evidence can be removed from Cloudinary.** Delete the case, uninstall the app —
  the photograph of your bank statement remains at a public URL forever.

For an app that holds bank statements, medical bills and private chat exports, "we cannot delete your
files and they are publicly addressable" is a consent and disclosure issue, not a backlog item. The
thesis discusses secrets in the APK (§6.3) and never asks where the user's documents go.

**What to do:** disclose it honestly in the upload flow until it is fixed ("files are stored in our
cloud at an unguessable address and cannot currently be deleted"), and treat a real delete path as a
prerequisite for any public release. Also: `upload.tsx:337` silently falls back to a synthetic local
path when the upload fails and creates the evidence record anyway (`:341-363`), so `storagePath` may
point at nothing. The user is never told.

### 6c. Multi-user and sharing — absent, and it breaks the use case

No `memberIds`, no `collaborator`, no `invite`, no `teamId` anywhere. Everything is single-owner by
`ownerId` (`models.ts:37`). The only sharing is `Sharing.shareAsync` handing a generated PDF to the
OS share sheet (`export.tsx:375`).

That is defensible for v1, but the thesis's own scenario — *"a tool whose output someone might take
to a small-claims hearing"* (§3) — means the second user is not optional. The moment a lawyer, a
family member or an opposing party is involved, the app's answer is "export a PDF", and a PDF drops
every property §5 says is the differentiator: no tappable provenance, no re-run, no live links. **The
product's differentiators do not survive the moment it becomes useful.**

**What to do:** either state explicitly that Ddetect is a single-user preparation tool and the PDF is
the handoff (legitimate, and it sets expectations), or design a read-only shared case view. Do not
leave it unexamined, because §3's credibility argument depends on the answer.

### 6d. Export and court use — the letterhead undoes the body

Covered in Attack 1. The body text of `export.tsx:345-352` is careful and honest. The header at
`:281` says *"Autonomous Evidence Analysis & Conflict Verification Platform"*, `:302` says *"Veracity
Analysis"*, and `:446` renders a `file-certificate-outline` icon. §5's cut-list explicitly bans
trust stickers; a certificate icon on the export is a trust sticker.

The hash chain is handled well — `audit-chain.ts:25-37` states plainly that it proves internal
consistency only, nothing is signed, and that "immutable", "tamper-proof" and unqualified "verified"
must never be used about it. `audit.tsx:435-436` carries that through into the UI, including the
sharp distinction between cloud-backed and local cases. **Concede this; it is the best-executed
honesty in the codebase.**

### 6e. Offline — works, but silently produces a different product

The local repository backs the whole app (`repository-provider.tsx:86,110-113`;
`local-repository.ts:39,99`) and Firestore uses `persistentLocalCache`
(`firebase-repository.ts:372-373`). Rules, extraction and analysis are pure and run fine offline.

But offline: Cloudinary upload fails (evidence created with a synthetic path) and Gemini OCR fails
(`NO_KEY` / network). So **the same ten files produce materially fewer findings offline than online,
and nothing tells the user this.** For a tool whose §3 credibility claim is reproducibility, "same
input, different output, no explanation" is a direct contradiction. It is not enough for the engine
to be deterministic if the *pipeline feeding it* is not.

**What to do:** record per-evidence what was and was not attempted, and surface it. "Six documents
were not read because the device was offline" is a finding, and it belongs in the coverage view from
Attack 2.

### 6f. 100 documents instead of 10

- `use-case-store.ts:98` holds the **entire** `Workspace` in React state. No `limit`, no cursor, no
  pagination, no virtualisation.
- `firebase-repository.ts:222,264-286` opens **nine concurrent `onSnapshot` listeners** and
  reassembles the whole workspace object on **every change from any of them**.
- Each evidence record carries up to 40,000 characters of source text
  (`deterministic.ts:27`). 100 documents ≈ **4 MB of strings** in the JS heap, re-materialised on
  every snapshot.
- `duplicate-evidence.ts:28` consumes `evidencePairs` (`support.ts:28`) at **O(n²)** — 4,950
  comparisons at 100 documents — synchronously on the JS thread, and `runCaseAnalysis` fires after
  **every single upload** (`upload.tsx:397`).

§8's bar is ten documents and that will be fine. The point is that the thesis presents ten as an
illustration when it is in fact the **ceiling**, and never says so. A user with a two-year landlord
dispute has sixty documents.

**What to do:** state the supported range in the thesis. Move analysis off the synchronous path
(debounce it; run once per upload *session*, not per file). Paginate the workspace by case.

### 6g. Non-English and Devanagari — the extractor, not just the OCR

§7 asks whether OCR reads Devanagari, calls it "the highest-stakes open question", and stops. The
more important answer is that **the deterministic extractor is English-only regardless of OCR**:

- `text.ts:15` uses NFKC, which does **not** fold Devanagari digits (U+0966–U+096F have no
  compatibility decomposition), so `१२३` survives as `१२३`.
- Every pattern uses JS `\d` without the `u` flag — **ASCII 0-9 only**: dates at
  `deterministic.ts:92-98`, amounts at `:157`.
- `money.ts:70` hard-gates on `/^[\d.,\s]+$/` — any non-ASCII digit is rejected outright.
- Month names are English-only (`dates.ts:33-46`); party labels are English-only
  (`deterministic.ts:250`); keywords are `/\b[a-z]{4,}\b/g` (`:308`).

So perfect Devanagari OCR would still yield **nothing**. The genuinely good news the thesis does not
credit: `money.ts:27` maps `₹ → INR`, `detectCurrency` (`:150`) handles `Rs.`, and lakh grouping
`1,00,000` is parsed correctly (`money.ts:103`). **A Hindi-language bill that prints amounts in ASCII
digits — which most printed Indian bills do — works today.** That is a far more useful answer than
the open question, and it reframes the risk: the exposure is handwritten and Devanagari-numeral
documents, not Hindi documents generally.

**What to do:** move this from §7 (open question) to §4 (declared boundary), with the accurate
statement. Add a Devanagari-digit fold in `normalizeText` — roughly ten lines and it removes most of
the exposure.

### 6h. Legal risk and reliance

§4 lists what the app must never *claim*. It never asks what happens when the app is **wrong** and
someone relied on it. There is no terms-of-service surface, no "not legal advice" gate, no
jurisdiction statement, and no record of what the user was shown at the time they acted. The
`about.tsx:316` line ("nothing it reports should be treated as proof") is good and is buried in a
screen nobody opens.

The concrete exposure is `consistent-amount@1` (5c): the app tells a user their figures are
corroborated, they do not investigate further, and the corroboration was two unrelated documents
that happened to share a round number.

**What to do:** a one-time acceptance gate at first case creation, a persistent honest line on the
findings screen itself rather than in About, and the fix to 5c.

---

# The four questions

## Is there a stronger framing than "consistency engine"?

**Yes, and it fixes the perception problem in Attack 1 rather than working around it.**

"Consistency engine" is accurate, defensive and dull. It describes a mechanism. It puts *documents*
in the subject position, which is why users keep re-reading it as a statement about *people*. And it
has no emotional register at all for someone who is frightened and angry — which is the actual state
of the user.

**The stronger framing: Ddetect plays the other side.**

> **A pre-mortem for your evidence. Before you hand this file to anyone, see what they will attack.**

Same engine, same findings, same honesty — one change: **the subject of every sentence becomes the
opponent, not the user and not the document.**

| Consistency framing | Opposition framing |
|---|---|
| "These two documents state different amounts." | "They will ask why your receipt says ₹100 and your payment says ₹1,000." |
| "This claim has no supporting evidence." | "You have nothing to show for this. They will notice." |
| "No document establishes a payment due date." | "They will say the payment was never late, and nothing here contradicts them." |

Why this is strictly better:

1. **It is not a truth claim, structurally.** "They will ask X" is a prediction about an adversary.
   It cannot be misheard as "you are lying" or "this is proven", because the app is not adjudicating
   — it is forecasting. The thing Attack 1 says cannot be fixed by wording *is* fixed by changing
   the grammatical subject.
2. **It makes NEEDS_REVIEW the point rather than a hedge.** Under "consistency", an unresolved
   finding is the engine failing to conclude. Under "pre-mortem", an unresolved finding **is the
   deliverable** — a question you will be asked. The product's honesty stops being a limitation and
   becomes the feature.
3. **It absorbs the weak differentiators and promotes the strong one.** Missing-evidence,
   unsupported-claim and orphaned-evidence are awkward under "do these agree" — they are not about
   agreement at all. Under "what will they attack", **gaps are the headline**, which is exactly where
   §5.4 wanted them and could not put them.
4. **It survives silence.** "We found nothing to attack in what you uploaded" is a sentence that
   cannot be misread as "your evidence is true", because it names its own scope in its own grammar.
   "Consistency engine" has no such sentence (Attack 1).
5. **It is the register the user is already in.** They are preparing for a fight. A tool that says
   "here is what they will say" is understood instantly, with no explanation of what a consistency
   engine is.

It also stays inside the honest boundary. It never claims truth, authenticity, or completeness. It
claims something the app *can* support: *given only what you uploaded, here is what is attackable.*

**Recommendation:** keep §2's definition as the engineering specification — it is correct and the
build should be checked against it — and adopt the opposition framing as the product's voice, its
naming, and its §4 wording rules. The thesis has the right mechanism and the wrong sentence.

## Is the thesis right to kill video analysis?

**Right about content. Wrong to stop there — it threw away the most thesis-aligned video capability
that exists.**

Concede the content argument entirely: adjudicating an assault allegation from frames would be
reckless independent of feasibility, and §4 is right to refuse. No argument.

But §4 conflates *understanding a video* with *reading a video file*, and they are not the same.
**Container metadata is deterministic, parseable in pure JS, and is exactly the kind of
cross-document consistency check the rest of the thesis is built on.** An MP4 is a flat tree of
atoms: walk to `moov/mvhd` for `creation_time` and `duration`; `moov/udta/©day` for a recording date;
`udta/©xyz` for GPS if present; `moov/trak/mdia/minf/stbl/stsd` for the codec and encoder string. No
ffmpeg, no native module, no model — a few hundred lines over a byte range, the same class of work
`pdf-text.ts` already does for PDFs.

And the finding it produces is *precisely* the shape the engine already emits:

> This video file carries an embedded creation date of **14 March 2024**. Your claim describes the
> incident as happening on **2 March**. The file's own timestamp disagrees with your account by
> twelve days.

That is an `event-date-conflict@1` finding whose source happens to be a video. It needs no new rule,
no new certainty class, and no new wording. It is the *same product*.

Two honesty constraints, both of which the app's existing patterns already handle:

- Metadata is trivially editable, so the finding must say *"the file's embedded date says X"* — never
  *"this video was recorded on X"*. That is the same distinction `ProvenanceValue` exists to draw.
- **Re-sharing strips it.** A video that arrived over WhatsApp has been re-encoded and has no useful
  metadata — and that is most videos. So the capability must be presented as "sometimes available",
  and its absence must never be reported as suspicious. That second point matters: "this file has no
  metadata" is *not* a finding, because it is the normal case.

Two further honest paths §4 did not consider:

- **Audio transcription.** A video's speech, or a voice note, transcribed to text, participates like
  any other document with `method: 'AI'` provenance. Voice notes are extremely common in exactly this
  app's domain and the thesis does not mention them once.
- **Duration and size as consistency inputs.** "You described a ten-minute recording; this file is
  fourteen seconds."

**Verdict: right to kill content analysis, wrong to close the section.** The paragraph at §4:135-148
should be split into "video content understanding — will not build" and "video file metadata —
in scope, deterministic, and the same class of finding as everything else".

## Which of the seven "consequences for the build" are wrong or incomplete?

| # | Consequence | Assessment |
|---|---|---|
| 1 | `claim.state` derived, not stored | **Incomplete, and possibly already satisfied.** `models.ts:165` and `claim-state.ts:123-134` cache it, and the case screen already derives on read. The thesis frames this as a correctness question; it is actually a **query-capability tradeoff** — `app/search.tsx:193` filters on the stored field, and deriving on read means you cannot query by state in Firestore without loading everything. The right answer is a *projection* written only by the analysis run and never read by the UI, which is what the code comment already describes. Also: the far bigger problem with `claim.state` is that it depends on relationships the user must create by hand. Deriving a value correctly from links nobody made is still the wrong answer. |
| 2 | OCR quarantine | **Right and urgent, but wrong in granularity and unimplemented on both sides.** See Attack 4. Field-level confirmation kills §8. Finding-level quarantine does not. |
| 3 | No secret ships in the APK | **Right in principle; the premise is out of date and it names the wrong secret.** Cloudinary no longer signs on-device — `cloudinary.ts:38,45,336` uses an **unsigned upload preset**, which is the right fix and is already done. The live exposure is elsewhere: `groq-client.ts:10-14` documents a bundled `EXPO_PUBLIC_GROQ_API_KEY`, and `EXPO_PUBLIC_` inlines into the bundle by design. `credentials.ts` handles this honestly (BYOK via `expo-secure-store`, bundled key as an eyes-open fallback) but the thesis has not been updated to match. Rewrite §6.3 against what is actually in the tree. **Resolved since this review:** the `EXPO_PUBLIC_GROQ_API_KEY` and `EXPO_PUBLIC_GEMINI_API_KEY` fallbacks have been deleted from `loadKey`, the key removed from `.env`, and the app is now BYOK-only — no model-provider key ships in the bundle. The leaked Groq key still needs revoking at the console, since it was compiled into an earlier release. |
| 4 | No demo case, no seeded data | **Right, and now structurally satisfied.** The seed builder had **no runtime caller** — references were confined to `tests/` — but it lived in `src/`, one autocomplete away from being bundled. **Resolved since this review:** it has been moved to `tests/fixtures/build-sample-workspace.ts` and `tests/fixtures/sample-documents.ts`, so Metro cannot reach it from the entry point and it cannot end up in an APK. The rule-engine coverage it provides (`tests/rule-engine-corpus.test.ts`) is kept: every assertion there is *derived* by the real extractor and the real engine from raw document text, not authored. |
| 5 | Every finding carries its inputs | **Right, implemented, and quietly broken.** `inputs` is `Record<string, string>` **keyed by document title** (`amount-mismatch.ts:100-105,166-171`; `event-date-conflict.ts:99-100`; `consistent-amount.ts:91`). Two files both titled "Screenshot" — the overwhelmingly common case, since `upload.tsx` asks the user to type a title one file at a time — and the object has **one key**. One of the two compared values **silently disappears**, and the finding that exists to make the conclusion checkable becomes uncheckable. Worse, `inputs` carries no `evidenceId` and no source quote, so §5.2's promise — *"tap ₹40,000 anywhere and see the sentence it was lifted from"* — **cannot be honoured from a finding at all**. Change `inputs` to an ordered array of `{ label, value, evidenceId, sourceQuote }`. This is the single highest-value change in the domain layer. |
| 6 | Matrix is a first-class screen | **Wrong as specified.** See Attack 2. Scope it to comparison groups; demote it below provenance and reproducibility. |
| 7 | Wording is a hard constraint | **Right, and already violated in production, because a constraint with no mechanism is a preference.** `index.tsx:98`, `export.tsx:281,302`, `evidence/[evidenceId].tsx:217`, `prompts.ts:251,255,272`, `case/[caseId]/index.tsx:882`. Needs a CI test, not a paragraph. |

**Five consequences the thesis should have listed and did not:**

8. **Multi-file upload is a prerequisite for §8.** The upload screen is strictly single-file —
   `result.assets[0]` at `upload.tsx:123,280,304`, a single `pickedFile` object at `:69-76`, and a
   manually typed title. Ten files is **ten full round trips** through pick → title → upload →
   analyse → `router.back()`. §8's bar — "uploads ten mixed files… within a minute" — is not merely
   unmet, it is **contradicted by the interaction model**. Nothing else in the thesis matters if the
   first minute is ten trips through a form.
9. **Analysis must be batched and moved off the synchronous path.** `runCaseAnalysis` fires after
   every individual upload (`upload.tsx:397`) and again after every claim and event creation
   (`case/[caseId]/index.tsx:217,251`), synchronously, over an O(n²) rule.
10. **Findings must carry provenance, not just values.** The prerequisite for consequence 2, and it
    does not exist in the `RuleFinding` type.
11. **A rule may only assert a relationship it can ground.** `consistent-amount@1` violates this and
    it is the most dangerous rule in the registry.
12. **Deletion must reach the bytes.** Soft-delete plus a public Cloudinary URL with no destroy path
    is not deletion.

## Does the existing domain layer support the thesis, or would the thesis require rewriting it?

**It supports it. The domain layer is the strongest part of this codebase and the thesis does not
require rewriting it. Everything missing is additive.**

What is already right, and is genuinely hard to get right:

- **Per-field provenance** exists in the data model (`models.ts:54-62`) with method, source quote and
  timestamp — §5.2's foundation, already built.
- **Integer minor units + ISO 4217** (`money.ts`), so amount comparison is exact, never float. §4's
  "10000 ≠ 100000" is true as written.
- **Date precision and ambiguity** (`dates.ts:106-112,168-173`) — comparison at the coarser precision
  and an explicit `ambiguous` flag for DMY/MDY collisions, correctly consumed by
  `event-date-conflict.ts:92`. This is the detail almost everyone gets wrong.
- **Pure rule engine** — no I/O, no clock, deterministic ids (`ids.ts:59-64`), memoised extraction,
  deleted endpoints dropped (`engine.ts:63-65`), human `status` preserved across runs (`:149`),
  unmatched findings resolved rather than deleted (`:188-190`). §5.3's reproducibility claim is
  **true**, and it is the best-supported claim in the thesis.
- **Override layering** — `effectiveExtraction` (`merge.ts:24-32,60-81`) makes §5.5's hierarchy real
  rather than aspirational.
- **`independentSources`** (`support.ts:44-71`) excludes derived and duplicate sources and dedupes by
  hash, so "corroborated by two sources" means two genuinely independent ones.
- **AI provenance discipline** — `provenance.ts:94,109-114,305` hardcodes `method: 'AI'` and
  `status: 'SUGGESTED'` and drops any model value not present verbatim in the source.

What must change, none of which is a rewrite:

1. **`RuleFinding.inputs` → ordered array with `evidenceId` and `sourceQuote`** (consequence 5). One
   type change, twelve rule call-sites, one UI component. Unblocks §5.2 and fixes a live data-loss
   bug.
2. **Provenance-aware findings.** Add `provisional: boolean` to `RuleFinding`, derived in the engine
   from the `method` of the compared fields. The information is already in the `Extraction` objects
   the rules receive — the engine simply ignores it (zero matches for `method` in
   `src/domain/rules/`). Small.
3. **`method` plumbed through `createFileEvidence`.** One argument (`mutations.ts:468`).
4. **A comparison-group projection** for the matrix. Derived, not stored. Additive.
5. **`requiredEventIds` needs a UI**, or the Layer-1 role-pairing rule from Attack 3 replaces it.
6. **Dead and stale code to clear:** `mergeAiExtraction` (`merge.ts:114`) has no caller;
   `deleteCase` (`mutations.ts:171`) has no caller; `addresses` (`deterministic.ts:365`) is hardcoded
   `[]`; the DUPLICATE_OF relation promised to the user at `upload.tsx:150-152` is never created.
7. **Multi-user fields** if 6c is answered affirmatively. Genuinely additive.

**The gap between thesis and product is not in `src/domain/`. It is in `app/`** — the screens that
would let a user build the structure the rules need, the upload flow that would make §8's bar
reachable, the compare view that does not exist, and the AI verdict layer that needs removing. The
thesis reads as though the domain layer were the problem. It is the asset.

---

## Where the thesis is right, briefly

Stated so the critique is not mistaken for a verdict on the whole document.

- **§1's central argument is correct and well made.** The app cannot determine truth, the two halves
  of the brief cannot both be built, and the second is the right one. The ₹100/₹1000 reasoning is
  sound even though the implementation does not reach it.
- **§3's reproducibility claim is true and is the product's best asset.** The engine is pure and
  deterministic. It is also the most defensible differentiator and the thesis ranks it third.
- **§4's "must never claim" list is correct, complete, and well argued** — particularly the refusal
  to claim authenticity from an image, and the refusal of numeric confidence for a model opinion.
  `enums.ts:89` and `models.ts:304` show it was already believed before the thesis was written.
- **§5.2 (per-value provenance) and §5.5 (manual-override hierarchy) are real, implemented and
  genuinely hard to replicate in a chat window.** These, not the matrix, are the moat.
- **§5's cut-list is excellent.** "Any count that is really a count of the app's own internals
  dressed up as an insight about the user's case" is the best sentence in the document.
- **§6.1's self-report** ("Currently both — needs fixing") is accurate, and a thesis that audits
  itself is worth more than one that does not.
- **§6.4 is already satisfied** — no demo case is seeded at runtime.
- **§8's "if a screen cannot survive the question *what in the user's data made this appear?* it does
  not ship"** is the right test. Applied honestly today it would delete the entire AI verdict layer,
  which is a point in the test's favour.

---

## If only five things are done

1. **Pass `method: 'OCR'` through `createFileEvidence`** (`mutations.ts:468`) and give OCR its own
   label and colour. The app currently tells users a model's guess was "Read from the document".
2. **Ground `consistent-amount@1`** behind a shared reference or shared claim. It is manufacturing
   false reassurance with maximum confidence, in a dispute tool.
3. **Make `RuleFinding.inputs` an ordered array with `evidenceId` and `sourceQuote`.** Fixes a silent
   data-loss bug and unblocks §5.2, the actual differentiator.
4. **Multi-file upload.** Without it §8 is unreachable and no demo survives contact with a stopwatch.
5. **Delete `ARBITRATOR RECOMMENDATION`, `confidenceScore`, `credibilityObservation` and "potential
   alterations"** from `prompts.ts` and `case/[caseId]/index.tsx`, and add the banned-word test. A
   wording constraint without CI is a preference.

Items 1–3 are each under a day. They are worth more than the matrix.

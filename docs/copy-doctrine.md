# Copy doctrine — what the app is allowed to say, and where

Status: active. Supersedes nothing; this is the rule the rebuild's text work is measured against.

## The measurement that produced this

`scripts/ui-audit.mjs` counts prose per screen and reports ~3,400 words. That number is
misleading and it sent two earlier passes at "reduce the text" to the wrong files. Almost none
of this app's sentences are written in the screen that shows them. `scripts/copy-audit.mjs`
walks `src/` as well and finds the real figure:

```
15,843 words in 1,346 strings across 119 files
```

The heaviest files are not screens:

```
837  src/features/crucible/seal-copy.ts
725  src/services/ai/prompts.ts            (model instruction — not user-facing, exempt)
474  src/services/ai/semantic-assistant.ts (mostly prompt — largely exempt)
406  src/domain/analysis/filing-draft.ts
319  src/domain/analysis/conflict-classification.ts
300  src/domain/analysis/limitation.ts
~1,400 across src/domain/rules/definitions/*  (16 files)
```

Cutting a sentence in a screen removes one sentence. Cutting a sentence in a rule definition
removes it from every case that rule ever fires on.

## The diagnosis

The brief says the interface is "overloaded with ... lengthy descriptions, and excessive text."
Read the strings and the problem is not that the writing is bad. It is careful, specific, and
scrupulous about what the product may claim — which is the single hardest-won property this
codebase has, and the thing §9 of the concept and `tests/*-copy.test.ts` exist to protect.

The problem is that **every sentence is rendered at once, at full length, in the primary
reading path.** A finding's `explanation` runs 200–727 characters. `FindingCard` renders it at
`numberOfLines={3}`, which is roughly 150. So on the most-read screen in the product, the
app's careful reasoning is cut off mid-sentence, and a reader sees a wall of grey clipped text.
That reads as an unfinished demo no matter how good the prose is.

Deleting words would fix the wall and destroy the honesty. So that is not the fix.

## The rule

Every long string in this app is answering one of three questions. They have different
audiences, different urgency, and they must not share a paragraph.

| | Question | Budget | Where it renders |
|---|---|---|---|
| **1. Observation** | What do the records say? | ≤ 180 chars, 1–2 sentences | Always visible, never clipped |
| **2. Caveat** | Why might this reading be wrong? | No budget | Behind a control the reader opens |
| **3. Next step** | What should I do about it? | ≤ 80 chars | A button or row, not prose |

Today all three are concatenated into `explanation` and truncated as one blob.

Worked example, `payment-status-conflict@2`, currently 727 characters in one string:

> `"Screenshot.png"` records the transaction as failed, while the account of events recorded
> for this case says the payment went through. That second half is this app's reading of
> wording you typed — it matched on the word "paid" — not a value read from a document, so the
> two may not be about the same payment and the wording may simply have been read the wrong
> way. Nothing here shows the records disagree. Worth a look if the statement and the document
> were meant to describe the same transfer.

Split:

- **Observation** (118 chars, always shown): `"Screenshot.png" records the transaction as failed, while your account of events says the payment went through.`
- **Caveat** (behind *Why this might be wrong*): the second half — that this rests on wording a
  person typed, matched on one word, and may not be about the same payment.
- **Next step**: the existing *Check the document* button. Already a control; stop also saying
  it in a sentence.

The caveat is not demoted by this. It is *promoted*: it gets a named affordance a reader can
find, instead of being sentence three of a paragraph that is cut off at sentence one.

## What this is not permission to do

- Not permission to drop a caveat. If a finding rests on a guess, the caveat is mandatory —
  `tests/rule-copy.test.ts` fails a hedged finding that has no caveat.
- Not permission to write an observation that asserts more than the records support. A shorter
  sentence is easier to overclaim in. The claims sweep still applies to every field.
- Not permission to touch `src/services/ai/prompts.ts`. Those words are instructions to a
  model, not to a person; length there buys accuracy and the budget does not apply.

## Consequences for the build

1. `RuleFinding` and `analysisResult` grow a `caveat` field. `explanation` narrows to the
   observation. (`src/domain/rules/types.ts`, `src/domain/models.ts`)
2. All 16 rule definitions are re-cut to the split.
3. `FindingCard` stops clipping `explanation` and grows the caveat disclosure.
4. A test pins the observation budget, so the paragraph cannot grow back.

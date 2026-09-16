> Historical working note. This records earlier research or defects and may describe behavior that has since changed. Current implementation and acceptance are documented in [PROJECT_SPEC](../PROJECT_SPEC.md), [ARCHITECTURE](../ARCHITECTURE.md), and [rebuild acceptance](rebuild-acceptance.md). Historical measurements and feasibility assumptions below are not current runtime guarantees.
# Ddetect — product thesis

Written 13 September 2026, before the rebuild. This document exists to be argued with.

Its job is to answer one question precisely enough to build against: **what is this app actually
for?** Everything downstream — the data model, the pipeline, the screens, the wording — follows
from the answer. Get this wrong and no amount of UI work saves it.

---

## 1. The central contradiction in the brief

The brief says both of these things:

> "verify करेगा and then बताएगा कि क्या ये सच है या झूठ है" — *verify it and then tell whether it
> is true or false*

> "The product must not be reduced to a simple 'truth detector' with a binary TRUE or FALSE
> output. Real evidence can be ambiguous, incomplete, conflicting or inconclusive."

These cannot both be built. The second one is correct, and this document proceeds on it. Here is
why, stated as plainly as possible, because this is the decision everything else rests on.

**The app cannot determine truth.** Not as a limitation of effort or budget — as a matter of what
is in the file. Given a photograph of a receipt, software can read the characters on it. It cannot
determine whether the receipt was issued by the merchant named on it, whether the transaction
occurred, whether the image was edited before it arrived, or whether the person who uploaded it is
describing it honestly. A £100 receipt and a £100 payment screenshot that agree are *consistent*.
They are also exactly what someone fabricating a claim would produce, because agreeing documents
are the easy thing to fake. Consistency is evidence. It is not proof, and a product that calls it
proof is lying to a person who may be about to rely on it in a dispute that matters to them.

**But the app can determine something genuinely valuable, and it is not a consolation prize.**

---

## 2. What the app is actually for

> **Ddetect finds where a person's own evidence disagrees with itself, and shows exactly where and
> by how much.**

Not "is this true". Instead: **"do these ten documents tell one story, and if not, precisely where
do they diverge?"**

That question is answerable — deterministically, reproducibly, and with the exact values shown.
And it turns out to be the question that actually matters to someone in a dispute. Consider the
brief's own example, taken literally:

- A mall bill says **₹100**.
- A payment app screenshot for the same purchase says **₹1000**.

The app has no idea which is correct. It does not need to. What it must say is:

> Two documents describe what appears to be the same payment and state different amounts:
> ₹100 (mall bill, read from "TOTAL: ₹100.00") and ₹1000 (payment screenshot, read from
> "₹1,000"). One of these is wrong, or they are different transactions. This needs a person
> to resolve.

That is a finding a user can act on. It is completely honest. It is computed, not guessed. And
critically — **the user did not know it was there.** They had ten files and a vague sense of
unease. Now they have a specific ₹900 discrepancy with a page reference. That is the product.

### The reframe, in one line

| Wrong framing | Right framing |
|---|---|
| Truth engine | **Consistency engine** |
| "Is this real?" | "Do these agree?" |
| Verdict | Findings, each traceable |
| Confidence % | What matched, what didn't, what's missing |

---

## 3. Why this is defensible, and why it is hard

Three reasons this framing is the strong version of the product rather than a hedge:

**It is checkable.** Every statement the app makes can be verified by a user in ten seconds by
tapping through to the source. Nothing rests on trust in a model. That is a property almost no
AI product has, and it is the entire basis of credibility for a tool whose output someone might
take to a small-claims hearing.

**Cross-document comparison at scale is genuinely difficult.** One or two documents, a person can
compare by eye. At ten documents with six extractable fields each, there are 45 document pairs and
hundreds of value comparisons. Nobody does that by hand, and an LLM asked to do it in one pass will
silently skip most of them — it produces a plausible summary, not an exhaustive comparison. A
program does all 45, every time, identically.

**It matches what the user actually needs.** Someone in a dispute does not need to be told their
own evidence is true; they already believe it. They need (a) the specific document that contradicts
the other side, (b) the discrepancy they hadn't noticed in their own file, and (c) to know what
they are *missing* before they find out the hard way.

---

## 4. The honest capability boundary

Committed to in advance, so that no screen can quietly cross it later.

### What the app can do, reliably and deterministically

| Capability | How | Certainty |
|---|---|---|
| Read text from digital PDFs | Content-stream extraction (pako inflate) | Exact, where the PDF has a text layer |
| Byte-identical duplicate detection | SHA-256 of file bytes | **Certain.** Two identical hashes are the same bytes. |
| Amount conflicts | Parse to minor units, compare integers | **Certain.** 10000 ≠ 100000. |
| Date conflicts / impossible ordering | Normalise to ISO, compare | Certain where the date parsed unambiguously |
| Shared identifiers across documents | Normalised string equality on invoice/txn/order refs | Certain |
| Entity resolution | "₹40,000" = "INR 40000" = "Rs. 40,000.00" | Certain, by normalisation |
| Missing-evidence analysis | Structural: what a complete set needs vs. what's here | Certain (it's a set difference) |
| Timeline reconstruction | Order confirmed dates | Certain, for dates that parsed |
| Relationship graph | From stored, user-confirmed links | Certain (it's a projection of stored data) |

### What the app can do, provisionally — always labelled as a suggestion

| Capability | Why it's provisional |
|---|---|
| OCR text from a photo | Misreads happen. `1` vs `7`, `0` vs `8`, decimal points. **An OCR'd value must not drive a conflict finding until a person confirms it** — a hallucinated ₹900 discrepancy from a misread digit is worse than no finding. |
| "These two documents describe the same event" | Semantic judgement. Model's opinion. |
| "This text supports / contradicts this claim" | Semantic judgement. Model's opinion. |
| Document type classification | Usually right, occasionally not. Harmless when wrong. |
| Suggested relationships | Proposals for a human to accept or reject. |

### What the app must never claim

- That a document is **authentic**, unedited, or genuine. An edited screenshot is
  indistinguishable from a real one at this level of analysis. Full stop.
- That a person is **lying**, or that an event **did** or **did not** happen.
- That anything is **legally verified**, **court-admissible**, or constitutes **proof**.
- A **numeric confidence** for a model's own opinion. "97.3% confident" is a fabricated
  measurement. Bands only.
- That analysis is **complete**. It is complete *with respect to what was uploaded* — always a
  different thing, and the app should say so.

### What cannot be built (and the brief asks for)

**Video content analysis.** The brief wants a video of an alleged assault analysed against a chat
message. On-device video understanding in React Native is not feasible — no viable ffmpeg binding
in 2026, no on-device vision model of that capability, and sending video frames to a hosted model
to adjudicate an assault allegation would be reckless even if it were technically clean. What the
app can honestly do with a video: store it, hash it, record its metadata (duration, size, created
date), show a thumbnail, and let the user attach their own written description — which then
participates in analysis as a *user statement*, provenance `MANUAL`, exactly like a note. That is
the honest version and it is still useful: the video is part of the case record, its integrity is
fingerprinted, and the user's account of it is analysable.

*(Pending confirmation from the feasibility research — if frame extraction proves viable, the
ceiling rises to "extract frames, OCR any text in them". Still not content understanding.)*

---

## 5. What makes this better than pasting files into ChatGPT

The sharpest question in the brief. Five answers, in descending order of how hard they are to
replicate in a chat window.

**1. The comparison matrix.** Rows are extracted fields, columns are documents, cells are values.
Agreement, conflict and absence are visible at a glance, across the whole case. This is the
product's signature view. A chat interface fundamentally cannot produce it — not because the model
can't reason, but because the output format is prose. And prose cannot show you 60 cells at once.

**2. Per-value provenance.** Every extracted value carries the document it came from, the exact
snippet it was read from, the method that read it (`MANUAL` > `DETERMINISTIC` > `OCR` > `AI`), and
a timestamp. Tap ₹40,000 anywhere in the app and see the sentence it was lifted from. A chat can
quote a document; it cannot make every number in its answer a live link back to its source, and it
cannot guarantee it didn't paraphrase.

**3. Exhaustiveness, and reproducibility.** The rule engine compares every pair. Ten documents = 45
pairs, every time. And running it twice on unchanged data gives byte-identical results, because the
findings are computed, not generated. Ask ChatGPT the same question twice and you get two different
essays. For something a person might rely on, reproducibility is not a nice-to-have.

**4. Missing-evidence analysis.** The genuinely novel one. The app reasons about the *shape* of a
complete evidence set and reports the holes: "Nothing in this case establishes a payment due date,
so 'the payment was late' cannot be assessed." Chat answers what you asked. It does not tell you
what you failed to bring.

**5. The manual-override hierarchy.** A person can correct any extracted value, and their
correction is permanent — no later machine pass can overwrite `MANUAL` provenance. The case gets
*more* accurate as the user works it, and their contributions are structurally protected. A chat
session's corrections evaporate when the context window rolls.

### And what would be decorative

Cut on sight, whatever it looks like in a screenshot: a chatbot pane ("ask about your case" — the
structured analysis *is* the product); model latency readouts; a "HASH SIGNED" badge in the main UI
(the hash chain is real, but it belongs in the export, not as a trust sticker); infrastructure chips
("Firebase Connected", "Cloud Firestore"); version badges; "PROOF" tags; confidence percentages;
and any count that is really a count of the app's own internals (rules in the registry, extractor
version) dressed up as an insight about the user's case.

---

## 6. Consequences for the build

Falling straight out of the above — recorded here so the implementation plan can be checked
against it.

1. **`claim.state` must be derived, not stored.** A cached verdict that can disagree with the
   evidence is a bug with a UI. Derive it from relationships on read. *(Currently both — needs
   fixing.)*
2. **OCR values are quarantined.** `method: 'OCR'` cannot trigger a conflict finding. It routes to
   a confirmation step first. This is the single most important safety property in the pipeline.
3. **No secret ships in the APK.** Currently the Cloudinary API secret is hardcoded and signs
   uploads on-device — extractable with `unzip`. Must be rotated and moved behind either an
   unsigned upload preset or a function.
4. **No demo case, no seeded data, no hardcoded findings.** Every case originates from a real user
   action. An empty account shows an empty state that invites an upload.
5. **Every finding carries its inputs.** The exact compared values, as strings, stored on the
   finding. This is what makes the detail screen possible and the conclusion checkable.
6. **The comparison matrix is a first-class screen**, not a feature of the case screen. It is the
   thing to demo.
7. **Wording is a hard constraint, not a style preference.** "Consistent with", "no supporting
   evidence found", "needs review", "could not be established from what was uploaded". Never
   "proves", "verified", "confirmed", "authentic", "true", "false".

---

## 7. Open questions for the research agents

Recorded now so the answers can be checked against what was actually asked rather than
rationalised afterwards.

- **OCR:** Is on-device OCR viable in Expo 55 via prebuild, and does it read Devanagari and Indian
  digit grouping? If not, images are near-dead weight and the honest framing of the whole product
  narrows sharply. *This is the highest-stakes open question.*
- **PDFs:** What proportion of real-world bills are text-layer vs image-only? Determines whether the
  existing pure-JS extractor is the main path or an edge case.
- **Secrets:** Does Firebase Blaze's function allowance stay free at this scale? If yes, both the
  Groq key and Cloudinary signing move server-side and the security question closes properly.
- **Google Sign-In:** Which library actually works in Expo 55 + prebuild, and does release-build
  SHA-1 registration have to be done before it will work at all?
- **Model:** Does the Groq model in use accept images? If so, vision-as-OCR becomes a fallback for
  when native OCR is unavailable.
- **Landscape:** Does this product already exist? If so, what do the incumbents do that this
  doesn't?

---

## 8. The bar

A person uploads ten mixed files about one dispute. Within a minute they see: what each document
says, which documents agree, a specific list of conflicts with exact values and sources, which of
their claims are supported and which are not, a timeline, and a clear statement of what evidence
is missing. Every number on every screen is tappable back to the sentence it came from. Nothing on
screen is decorative, and nothing is claimed that the app cannot show.

If a screen cannot survive the question *"what in the user's data made this appear?"* — it does not
ship.

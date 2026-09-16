# Crucible — the hearing before the hearing

**A module for `detact` / ProofChain. Additive. Nothing existing is removed.**

> ProofChain builds the record. Crucible is where it meets a hostile reader.

---

## 0. The pitch, in 30 seconds

ProofChain today builds a perfect private record of a dispute. But a record only *you* can see,
built only from documents *you* produced, proves nothing to the person on the other side of the
table. That is not a bug in the app — it is the boundary the app was honest enough to write down
in its own source.

**Crucible is the other half.** It takes a finished case and puts it through the three things that
actually happen when a dispute becomes real:

1. **The Seal** — the record gets cryptographically sealed by a server, so nobody (including you)
   can backdate, edit or reorder it afterwards. Anyone in the world can verify it from a link.
2. **The Other Side** — the counterparty is pulled into the same record through a scoped link.
   They agree, disagree, or stay silent — *item by item*. What comes out is the thing every real
   forum asks for first and no consumer app produces: **a list of agreed facts and a list of
   contested facts.**
3. **The Adversary** — when the other side refuses to participate (the common case), the app
   plays them. It attacks your case using only your own evidence, and tells you exactly which
   claims collapse and what would fix them.

One sentence for the evaluator: **"Evidence you collected yourself, that only you can see, is not
proof. This module turns a private record into a record that survives a hostile reader."**

---

## 1. Why this specific idea — the gap is already documented in your own code

This is not a feature invented to look impressive. Three files in the existing codebase state the
problem out loud:

**`src/domain/analysis/audit-chain.ts`** — the module's own doc comment:

> *"It does not prove the data is tamper-proof at rest. **Nothing is signed: there is no key**, so
> no one can be shown to have authored a chain. Anyone able to rewrite the stored entries can
> recompute a perfectly valid chain over their rewrite, because the digests are derived rather
> than sealed."*

The app is called **Proof**Chain. The chain exists and is correct. The *proof* part — the key,
the signature, the third party who can check it — is the acknowledged hole.

**`src/domain/analysis/independence.ts`** — computes what fraction of your sources are genuinely
independent of one another. It can only ever measure independence *within one person's pile of
documents*. The screenshot, the PDF, the note — all produced by the same hand. There is currently
no mechanism in the entire app by which a source can enter the case from someone who is not you.
Independence has a ceiling, and the ceiling is structural.

**`src/domain/analysis/escalation.ts`** — encodes redressal ladders and reasons about silence:
*"the most common way a consumer dispute in India is lost has nothing to do with the evidence. It
is lost by waiting."* The app can reason about silence but has no way to **produce** it as a
record — no way to establish that the other side was shown a specific claim on a specific date and
said nothing.

Three modules, one shared missing piece: **the app has no concept of a second party.**

Crucible is not bolted on. It is the thing the existing architecture was already shaped around.

---

## 2. The thesis

> A dispute is not won by having documents. It is won by having documents that a hostile,
> disinterested third party will accept — and by knowing, before they tell you, which of your
> documents they will throw out.

Everything below follows from that one line.

---

## 3. Pillar 1 — **The Seal**

*Technical depth. Closes the gap the codebase names.*

### 3.1 What exists vs what gets added

| | Today | With Crucible |
|---|---|---|
| Chain | Derived at render time from `auditLogs` | Same — unchanged |
| Integrity | Detects an inconsistent history | Same — unchanged |
| Authorship | None. No key. | Server-held Ed25519 key signs the chain head |
| Time | Client clock, trivially faked | Server timestamp inside the signature |
| Third-party check | Impossible | Public verify page, anyone, no account |

The existing chain derivation is **not touched**. Crucible wraps it.

### 3.2 How the seal works

A Cloud Function holds an Ed25519 private key (Secret Manager — never in the app bundle, never in
git). The client sends the current chain head and entry count. The function:

1. Independently recomputes the chain from Firestore — it does **not** trust the client's head.
   (It can, because `functions/tsconfig.domain.json` already compiles selected domain files into
   the functions codebase — today `extraction/deterministic.ts` and `analysis/report-entities.ts`.
   Adding `analysis/audit-chain.ts` and `hashing.ts` to that `include` array means the identical
   `buildAuditChain` runs on device and on the server. One implementation, no drift.)
2. Signs `(caseId, head, entryCount, serverTimeMs, previousSealSignature)`.
3. Writes a `seals/{id}` document. Firestore rules: **create-only, no update, no delete** — the
   same pattern `auditLogs` and `caseAnalyses` already use in `rules/firestore.rules`.

Chaining each seal to the previous seal's signature means the seals themselves form a ladder. You
cannot insert a seal into the past without forging every seal after it.

**No new dependency on the server.** Node 22 (`engines.node: "22"` in `functions/package.json`)
ships Ed25519 in `node:crypto`. Signing is `crypto.sign(null, message, privateKey)`.

**And the secret-handling pattern already exists.** `functions/index.js` already does
`defineSecret("GROQ_API_KEY")` and passes it into a Gen-2 function. The signing key is the same
move with a different name — a proven path in this repo, not new infrastructure.

### 3.3 What a seal proves — stated precisely

- ✅ **"This exact record existed by 14 Sep 2026, 10:42:07 UTC."** An upper bound on creation time,
  attested by a key the user does not control. This is what defeats *"you made this up after the
  fact"* — the single most common attack on a one-sided evidence file.
- ✅ **"Nothing has been altered, reordered, inserted or removed since."**
- ❌ It does **not** prove the contents are true.
- ❌ It does **not** prove a photo was not staged.
- ❌ It is **not** a legal record and the UI must never imply it is.

Say all six of those on screen. The honesty *is* the product — and it is what separates this from
every "blockchain notary" project. **The word "blockchain" must not appear anywhere in this
module.** It is a signed hash chain with a public verification path, which is both more accurate
and more defensible.

### 3.4 Sealed capture

`expo-image-picker` (already installed) can launch the camera directly; `expo-audio` (already
installed) records. **No new capture dependency is needed.**

Media captured *inside the app* is hashed the instant it is written, appended to the chain, and
sealed within seconds. A file imported from the gallery gets the same hash but carries no claim
about when it was made.

That difference is real, so it becomes a first-class, deterministic property:

**Custody Grade** — computed, never guessed:

| Grade | Meaning |
|---|---|
| `SEALED_CAPTURE` | Created in-app, hashed at capture, sealed within minutes |
| `SEALED_IMPORT` | Imported, hash sealed on import, original metadata intact |
| `IMPORTED` | Hash recorded, no time attestation |
| `DERIVATIVE` | Re-encoded / stripped metadata / screenshot-of-a-screenshot signals |

This feeds straight into the existing rule engine and into `independence.ts`. A claim resting
entirely on `DERIVATIVE` evidence is a weak claim, and now the app can say so with a reason instead
of a vibe.

### 3.5 The public verify page

An Expo Router **web** route — `app/verify/[sealId].web.tsx`, shipped from the same repo
(`react-native-web` is already a dependency and `npm run web` already works).

Drop the exported bundle in → it recomputes every digest in pure JS → green, or red with the exact
entry that broke.

**The demo:** export a case. Open the verify link on the projector — green. Open the JSON in a text
editor, change one character in one summary line, re-upload. The page goes red and names the entry.
Ten seconds, no narration needed.

---

## 4. Pillar 2 — **The Other Side**

*The novel part. Multiplayer. This is what makes it a product rather than a feature.*

### 4.1 The flow

1. **Disclose.** You choose *which* claims and events to show. Disclosure is explicit and partial —
   you are not handing over your whole case. The disclosure set itself is hashed and sealed, so
   later nobody can argue about what was shown.
2. **Invite.** A Cloud Function mints a signed, expiring, single-case token → a web link. Sent over
   WhatsApp, email, whatever.
3. **Respond.** The counterparty opens it — no app install, no account. They see a clean timeline.
   For each item: **Agree / Disagree / Don't know**, with an optional statement and optional file.
4. **Seal.** Every response is written by the Cloud Function (never by an unauthenticated client
   writing to Firestore directly), enters the audit chain, and gets sealed.

### 4.2 The output — the Agreed Facts engine

This is the crown jewel, and it maps onto the existing domain model almost for free:

| Bucket | Derivation | Why it matters |
|---|---|---|
| **AGREED** | Both sides assert it | Closed. Cannot be relitigated. Usually 60–70% of any dispute. |
| **CONTESTED** | Both assert, values conflict | Existing `CONTRADICTS` relationships + `comparison.ts` renders both columns |
| **UNANSWERED** | You asserted, they opened it, they never replied | **Timestamped silence is itself a record** — exactly what `escalation.ts` already reasons about |
| **UNILATERAL** | They assert something you never did | Their new claims, now on the record |

Every real dispute process — consumer commission, mediation, HR inquiry, college grievance
committee, a court's first hearing — **begins by separating agreed facts from contested facts.**
It is the single most valuable document in any dispute. It is also pure drudgery, which is why
nobody does it before they are forced to.

No consumer app produces it. That is the gap.

### 4.3 The independence jump

A counterparty-confirmed event is **the only evidence in the entire app that the user did not
produce.** So `independence.ts` gains a new top tier, and it is not decorative — it is the first
time the independence ratio can honestly exceed the ceiling imposed by single-party authorship.

That is a rigorous, non-gimmicky reason this feature has to exist, and it is a strong thing to be
asked about in a viva.

### 4.4 When they refuse — which is most of the time

Be realistic: most counterparties will ignore the link. **That is not a failure mode, it is an
output.** The record then reads: *disclosed 3 Sep, link opened 4 Sep 11:20, seven claims shown, no
response in 12 days* — all of it sealed, all of it exactly the input `escalation.ts` wants in order
to say a redressal forum may now be open.

And when they ignore it, Pillar 3 takes over.

### 4.5 The Joint Record

One sealed export — PDF via `expo-print` (already installed) plus a machine-verifiable JSON
sidecar — with four sections: Agreed, Contested, Unanswered, Unilateral. Each side's portion signed
over their own assertions. Verifiable by anyone at the public link.

**This is the artifact.** This is the thing a person actually takes to a consumer forum, an HR
desk, a landlord, a college committee, or a group chat to end an argument.

---

## 5. Pillar 3 — **The Adversary**

*The out-of-the-box part. Also the solo-mode fallback when nobody responds.*

### 5.1 Deterministic first, AI second

The same discipline the codebase already uses for the rule engine → AI split. The deterministic
pass finds attackable structure with zero model involvement:

- A claim with no independent source
- A claim resting on an unconfirmed OCR read (`provisional` + `unconfirmedReads` already exist)
- A gap in the timeline at exactly the moment that matters (`timeline-gap` already exists)
- Every source derivative of one original (`independence.ts` already computes this)
- Evidence with a weak Custody Grade (new, from Pillar 1)
- A claim contradicted by **your own** document (`statement-discrepancy`, `amount-mismatch` — exist)
- No counterparty acknowledgement anywhere in the case (new, from Pillar 2)

Then the AI layer phrases the other side's most likely defence — **constrained to cite only
segments from your own evidence**, reusing the citation-checking harness already built for
`caseAnalyses` / `CaseCitation`. If it cannot cite, it does not speak.

### 5.2 Cross-examination mode

One question at a time, the way the other side would ask it. Not a chatbot — a **structured
interrogation** derived from the weaknesses above, in a fixed order, with a fixed end.

Your answer does one of two things: it becomes a new claim or event (marked `USER_STATEMENT`,
untested, clearly distinguished from documented facts), or it is recorded as *unanswered* — which
is itself a finding, and the most useful one in the whole app.

### 5.3 The output — the Weak Points sheet

Ranked by *how cheaply this can be dismissed*, each with a concrete repair:

> **"This claim rests on one number read off a photo, and nobody has confirmed it."**
> → Confirm the amount against the original. *[Confirm]*

> **"Four of your five documents are copies of the same original."**
> → One independent source would fix this. Who else saw this happen?

> **"You never put this in writing to them. There is no record they ever knew."**
> → Send it now. It will be sealed, timestamped, and it starts their reply clock.

### 5.4 The line it must never cross

**It never predicts an outcome.** It never says "you have a strong case," never scores your odds,
never states a filing deadline. It reports **attackability** and **what would fix it** — nothing
else.

This is not timidity, it is the same rule `escalation.ts` already enforces on itself: *"There is a
real way to do harm here: state a deadline... if the scheme, the sector or the starting date is
wrong, it is advice that costs someone their claim."*

Being able to explain *why you refused to build the feature that would have demoed better* is worth
more in an evaluation than the feature.

---

## 6. Domain model deltas

Deliberately small. Three new collections, one new field on `evidence`. Everything else is derived
at render time, exactly like `graph.ts`, `timeline.ts` and `audit-chain.ts` already are.

```
seals            { caseId, chainHead, entryCount, serverTimeMs,
                   previousSealSignature, signature, keyId, algorithm }

disclosures      { caseId, token(hashed), disclosedClaimIds, disclosedEventIds,
                   disclosureHash, createdAt, expiresAt, openedAt[], revokedAt }

counterResponses { caseId, disclosureId, targetRef{kind,id},
                   stance: AGREE | DISAGREE | UNKNOWN,
                   statement, evidenceIds[], respondentLabel, sealedAt }

evidence.custodyGrade : SEALED_CAPTURE | SEALED_IMPORT | IMPORTED | DERIVATIVE
```

Derived, stored nowhere:

```
factLedger(workspace) -> { agreed[], contested[], unanswered[], unilateral[] }
adversary(workspace)  -> WeakPoint[]
```

Both are **pure functions of `Workspace`** — same contract as the rule engine, so both are unit
testable with `vitest` (already configured) and neither can drift out of sync with the records.

New `RelationshipType` values: `CONFIRMED_BY_COUNTERPARTY`, `DISPUTED_BY_COUNTERPARTY`. New
`AuditAction` values: `SEAL_CREATED`, `DISCLOSURE_SENT`, `DISCLOSURE_OPENED`, `COUNTER_RESPONSE`.
Additive enum extensions only — nothing existing changes meaning.

Note that `enums.ts` keeps `RELATIONSHIP_LABELS: Record<RelationshipType, string>` beside the enum
specifically so *"a new member cannot be added without one"*. That is a compile error waiting for
you, by design. Add the labels in the same commit.

One rule the existing `rules/firestore.rules` already enforces that matters here:
`relationships` only accepts writes where `origin == 'USER'`. Counterparty relationships must
therefore be written by the Cloud Function through the Admin SDK, which bypasses rules — which is
correct, because a counterparty assertion should never be client-writable in the first place.

---

## 7. UI concept — **"The Seam"**

Do **not** invent a new design system. Extend `src/ui/tokens.ts`. Keep the light-first lavender
canvas, keep IBM Plex Sans / Plex Mono / Jakarta (all three already installed).

**The Seam.** A vertical fracture line down the case view. Your record on the left, theirs on the
right.

- **Agreed facts fuse.** They leave their columns and merge into a single centred row that spans
  the seam — calm, mono type, a small seal sigil. Visually *closed*. Watching a fact fuse when the
  other side agrees is the emotional beat of the whole app.
- **Contested facts straddle the seam**, both versions visible, the fracture glowing between them.
- **Unanswered items** sit on your side with a thread that fades into empty space on theirs. That
  is what silence looks like.

**The Seal ribbon.** A thin persistent strip at the top of every case: chain head (first 8 hex
chars, Plex Mono), entry count, last sealed time. Tap to expand into the **chain ladder** — every
entry a rung, each digest visibly folding into the next. When a new seal lands, the ribbon does a
short *set* animation. It is the app's heartbeat, and it makes an invisible cryptographic property
into something you watch happen.

**Custody grade as texture, not a badge.** Sealed capture draws with a crisp solid rule; imported
with a dashed rule; derivative with a softened, faintly doubled edge. Users *see* weak evidence
before they read a word.

**The hot seat.** Cross-examination breaks the light theme entirely: full-bleed dark canvas, one
question, mono type, no navigation chrome, no way to skip ahead. Deliberately uncomfortable. When
it ends, the room lifts back into the normal theme with the Weak Points sheet. The tonal shift is
the point — for ninety seconds the app stops being on your side.

---

## 8. Why this is actually novel

Honest competitive read, because "nothing like it exists" is usually false:

- **DigiLocker / Google Drive / any vault** — storage. No reasoning, no second party, no sealing.
- **Notarization apps (Proofpoint-style timestamping, OpenTimestamps)** — seal a single file. No
  case structure, no counterparty, no analysis.
- **Legal-tech e-discovery (Relativity, Everlaw)** — enterprise, lawyer-operated, ₹lakhs, assumes
  litigation has already started.
- **ODR platforms (SAMA, Presolv360, CADRE)** — mediation *services*. A human mediator runs it,
  both parties must already have agreed to mediate, and it starts *after* the dispute is formalised.
- **ChatGPT** — will write you a complaint letter from a prompt, with no record, no provenance, no
  seal, and a cheerful willingness to invent an account number.

**Nothing occupies the pre-formal stage:** the weeks where an ordinary person has a pile of
screenshots, no lawyer, no forum, no money, and needs to (a) prove their record is not fabricated,
(b) find out what the other side will actually concede, and (c) discover their own weak points
before a stranger points them out for free.

That is a real, unserved, and — for a college project — completely unclaimed position.

---

## 9. What this must never do

Carry these forward from the existing codebase; they are its best quality.

1. Never say **"tamper-proof"**, **"immutable"**, **"verified"** unqualified, or **"blockchain"**.
   Say *tamper-evident*, *server-sealed*, *existence proof*.
2. Never predict an outcome, score your chances, or state a filing deadline.
3. Never present a counterparty's silence as an admission. It is a timestamped non-response.
4. Never let an unauthenticated client write to Firestore. Every counterparty write goes through a
   Cloud Function that validates the token.
5. Never invent a value to fill a blank — the existing `filing-draft.ts` rule, applied to the
   Joint Record too.
6. Never put the private key anywhere except Secret Manager.

---

## 10. The 15-day plan

Ordered by value. **Cut from the bottom, never the top.** Pillar 1 + Pillar 2 alone is already the
project — Pillar 3 is upside.

**Days 1–3 — The Seal (core)**
`functions/` — Ed25519 keypair via `node:crypto`, key in Secret Manager, `sealCase` callable that
recomputes the chain server-side and signs it. `seals` collection + create-only rules. Client
seal trigger + the Seal ribbon. Verification as a pure shared function so app, functions and web
all use the identical code path.

**Days 4–5 — Sealed capture + custody grades**
In-app capture through `expo-image-picker` / `expo-audio`, hash at capture, immediate chain append.
`custodyGrade` derivation. Wire into `independence.ts` and the rule engine. Texture treatment in UI.

**Days 6–7 — Export bundle + public verify page**
Deterministic JSON bundle format, PDF via `expo-print`. `app/verify/[sealId].web.tsx`. Add a
`hosting` block to `firebase.json` (it has `firestore`, `storage`, `functions`, `emulators` —
hosting is not configured yet) and deploy the Expo web export. **Rehearse the live tamper demo.**

**Days 8–11 — The Other Side**
Disclosure picker + disclosure hash. `createDisclosure` / `submitResponse` Cloud Functions with
token validation. Counterparty web responder — keep this page *ruthlessly* simple; a stranger opens
it once, on an unknown phone, with no instructions. `factLedger()` pure function. The Seam UI.

**Days 12–13 — The Adversary**
Deterministic weak-point pass. AI rebuttal layer reusing the existing citation harness. Cross-exam
flow. Weak Points sheet.

**Day 14 — Joint Record**
Four-section sealed export, both-party signatures, verify-page support for it.

**Day 15 — Demo, seed case, buffer.**

**If you lose 4 days:** ship Pillar 1 + verify page + a read-only agree/disagree counterparty page.
Drop cross-exam, drop the Joint Record, drop sealed video. That is still a complete, novel,
demonstrable project.

---

## 11. Honest technical risks

1. **`@noble/curves` is the one new client dependency.** You have `@noble/hashes` already, from the
   same author — `curves` gives Ed25519 verification in pure JS that behaves identically in RN,
   Node and browser. The alternative (WebCrypto `Ed25519`) is browser-only and would mean two
   different verification code paths, which is exactly how a verifier and a signer drift apart.
   One small audited dependency is the right call here.
2. **The counterparty web page is the highest-risk surface.** `react-native-web` is installed and
   `npm run web` works, but RNW output for a page a stranger loads once on an unknown device is
   where polish goes to die. Budget a full day. If it fights you, serve that one page as plain
   HTML from a Cloud Function — it needs four buttons and a text box, not a framework.
3. **Blaze plan and Secret Manager are already solved.** `functions/index.js` uses Gen-2 `onCall`,
   `onDocumentCreated` and `defineSecret("GROQ_API_KEY")` — all of which require Blaze. This risk
   was on my list until I read the file. It is not a risk; it is an existing, working pattern to
   copy.
4. **Key rotation is out of scope** — one key, `keyId: "v1"`, documented as a known limitation.
   Say so in the viva before you are asked.
5. **Server-side chain recomputation cost** grows with audit entries. Fine at demo scale
   (hundreds). Note it; do not prematurely optimise.
6. **Not verified by me:** I read the architecture, not a running build. `functions/index.js`,
   `functions/src/jobs` and `functions/tsconfig.domain.json` all exist and look coherent, but I did
   not run `npm run build`, `npm test`, `typecheck` or the emulators. Confirm the functions codebase
   builds and deploys before day 1 — the whole of Pillar 1 sits on top of it.

---

## 12. The six-minute demo

1. **(45s)** Open a seeded case — the existing app. Timeline, graph, findings. *"This is what I
   built for the client. Now the problem with it."*
2. **(45s)** Open `audit-chain.ts` on screen and read the comment aloud: *"Nothing is signed: there
   is no key."* Let it land. **Own the weakness before anyone finds it** — it is the strongest move
   available to you in the room.
3. **(60s)** Tap Seal. Ribbon animates, chain head appears. Open the public verify link on a second
   screen — green. Edit one character in the exported JSON. Re-upload. **Red**, with the exact entry
   named.
4. **(90s)** Send a disclosure link to the second phone. A classmate opens it — no install, no
   account. They agree to two events, dispute one, ignore one. On your phone, live: two facts fuse
   across the seam, one fractures, one thread fades into silence.
5. **(60s)** Open the Joint Record. Four sections. Sealed. *"This is the page a consumer commission
   asks for first, and it built itself."*
6. **(60s)** Cross-exam on a case with no counterparty. The app takes your best claim apart in four
   questions. Weak Points sheet. Close on: *"It never tells you that you will win. It tells you
   where you are weak, and it can prove it wasn't written yesterday."*

---

## 13. Naming

**Crucible.** A crucible is the vessel a material is put into and heated until it shows what it is
actually made of. That is this module's whole function in one word, and it maps cleanly onto all
three pillars: the Seal is what survives the heat, the Other Side is the second material that meets
yours inside it, the Adversary is the fire.

It also stays inside §9's discipline without having to try. A crucible **tests**; it never
certifies. The name promises nothing the module cannot deliver — which is precisely the problem
with every alternative built out of *proof*, *verified*, *trust* or *secure*.

Module inside ProofChain, not a rebrand:
**ProofChain builds the record. Crucible is where it meets a hostile reader.**

Considered and rejected. The reasoning is worth keeping, because "why not X" is a question that
gets asked:

- **Sunwai** (सुनवाई — *hearing*) — precise and India-first, but Hindi-only, and the two surfaces a
  stranger actually lands on (the counterparty responder, the public verify page) cannot assume a
  shared language.
- **Standoff** — nails §4.4's silence case better than anything else on this list, but a standoff
  means *stalemate, no output*. The thesis is that silence **is** an output. The name argues with
  the document.
- **Crossfire** — the Seam and cross-examination are both audible in it, but "caught in the
  crossfire" puts the user in the victim seat. Here the user runs the test; it is not run on them.
- **Proving Ground** — strongest pairing with ProofChain, and technically honest (a proving ground
  *tests*; it does not prove things true). Lost on length alone. Keep as the fallback.
- **Counterpoint** — the most literally accurate of all of them: counter (counterparty) + point
  (item-by-item stance), two independent lines that resolve against each other. Too soft to carry
  Pillar 3.

---

*This document is the concept, not the build spec. The per-pillar technical specs — schemas,
function signatures, rules, prompts, test plan — come next.*

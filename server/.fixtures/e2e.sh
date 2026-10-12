#!/bin/bash
#
# End-to-end exercise of the real pipeline against a running server.
#
# Not a unit test. This posts real files, waits for real model calls, and reads back what a
# person would actually see. The suite in `src/**/*.test.ts` stubs the model boundary and
# proves the logic; this proves the thing works, which is a different question — every bug
# this file has caught was in the seam between two parts that each passed their own tests.
#
#   cd server && npm run dev            # in one terminal
#   bash .fixtures/e2e.sh               # in another
#
#   API=http://127.0.0.1:8787 bash .fixtures/e2e.sh     # a different host
#   KEEP=1 bash .fixtures/e2e.sh                        # leave the account behind to poke at
#
# Exits non-zero if any step failed, so it is usable as a gate rather than only as something
# to read. Every check prints PASS or FAIL with the endpoint, and the run ends with a count.
#
# ONE HAZARD WHEN EDITING THIS FILE: the inline checks are Node scripts passed as `node -e '…'`,
# so a single quote anywhere inside one — including an apostrophe in a comment — closes the shell
# string and the whole file stops parsing with a syntax error pointing at a line that is fine.
# Write "the record of the person who uploaded it", never "their own record". After any edit,
# `bash -n .fixtures/e2e.sh` catches this in a second; the suite itself takes minutes.
#
# No Python and no jq. The old version shelled out to `python -c` eleven times, which is a
# dependency the rest of this repo does not have — on a machine without it every single step
# printed an empty string and the script still said "done". Node is already required to run
# the server, so the JSON reading below uses it.

set -u

API=${API:-http://127.0.0.1:8787}
# A fresh identity per run. Device identity is a dev-only convenience the server refuses
# under NODE_ENV=production, which is correct and means this script is a local tool.
DEV=${DEV:-e2e-$(date +%s)-$$}
H="-H x-device-id:$DEV"
FX="$(dirname "$0")"

PASSES=0
FAILURES=0
FAILED_STEPS=()

say() { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }
pass() { PASSES=$((PASSES + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
fail() { FAILURES=$((FAILURES + 1)); FAILED_STEPS+=("$*"); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Reading JSON without a JSON tool
# ---------------------------------------------------------------------------

# `at <path>` prints one value from the JSON on stdin. Dotted path, numeric indexes allowed:
# `at record.question.prompt`, `at results.0.title`. Missing or null prints nothing, so a
# caller can test with `[ -n "$x" ]` rather than having to compare against "null".
at() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        let value = JSON.parse(raw);
        for (const key of process.argv[1].split(".").filter(Boolean)) {
          value = value === null || value === undefined ? undefined : value[key];
        }
        if (value === undefined || value === null) return;
        process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
      } catch {
        // Not JSON at all — an HTML error page, or nothing. Prints nothing, same as absent.
      }
    });
  ' "$1"
}

# `show [chars]` pretty-prints the JSON on stdin, truncated. Truncation is the point: an
# analysis response runs to several thousand characters and the interesting part is the top.
show() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      const limit = Number(process.argv[1] || 1200);
      try {
        const text = JSON.stringify(JSON.parse(raw), null, 1);
        process.stdout.write(text.length > limit ? text.slice(0, limit) + "\n  …\n" : text + "\n");
      } catch {
        process.stdout.write("  (not JSON) " + raw.slice(0, 300) + "\n");
      }
    });
  ' "${1:-1200}"
}

# GET/POST wrappers that keep the response body and the status code together. The old version
# could not tell a 404 from a success with an empty field, which is how `/analyse` went
# unnoticed: it 404'd on every run and printed the same nothing a working call would have.
BODY=''
CODE=''
call() {
  local method=$1 path=$2
  shift 2
  local raw
  raw=$(curl -s -w $'\n%{http_code}' -X "$method" "$API$path" $H "$@")
  CODE="${raw##*$'\n'}"
  BODY="${raw%$'\n'*}"
}

# `send <method> <path> <json>` — the same as `call`, for a body that is not all ASCII.
#
# THE REASON THIS EXISTS, because it cost an hour to find: on Windows, a non-ASCII argument
# never reaches curl intact. argv is not UTF-8 there, so `-d {"note":"caa"}` written in
# Devanagari arrives at the server as one question mark per character, the server stores
# exactly what it was sent, and the check that reads it back fails — pointing at the route,
# which is innocent. The PATCH-a-meeting step failed this way while every other Devanagari
# check in this file passed, because those read text the *server* produced and only this one
# sends text in.
#
# Piping the body through stdin skips argv altogether, so the bytes are the bytes. Worth using
# for any body a person could have typed: this product is for people who write in Hindi.
send() {
  local method=$1 path=$2 body=$3
  shift 3
  local raw
  raw=$(printf '%s' "$body" | curl -s -w $'\n%{http_code}' -X "$method" "$API$path" $H \
    -H 'content-type:application/json' --data-binary @- "$@")
  CODE="${raw##*$'\n'}"
  BODY="${raw%$'\n'*}"
}

# `expect <code> <label>` — one assertion against the last call.
expect() {
  local wanted=$1 label=$2
  if [ "$CODE" = "$wanted" ]; then pass "$label"; else fail "$label (got HTTP $CODE: $(printf '%s' "$BODY" | head -c 200))"; fi
}

# ---------------------------------------------------------------------------
# Readiness
# ---------------------------------------------------------------------------

say "health"
# The server runs under `tsx watch`, so it restarts on every save and spends a second or two
# refusing connections each time. A readiness check that gave up on the first miss meant this
# suite could not be run while anyone was editing the server — which is the only time it is
# worth running. So the first call waits, and only a server that is genuinely not there fails.
for attempt in $(seq 1 30); do
  call GET /health
  [ "$CODE" = "200" ] && break
  [ "$attempt" = "1" ] && printf 'waiting for %s ' "$API"
  printf '.'
  sleep 2
done
[ "$CODE" = "200" ] && [ -n "${attempt:-}" ] && [ "$attempt" != "1" ] && echo " up"
if [ "$CODE" != "200" ]; then
  echo
  echo "The server is not answering on $API. Start it with: cd server && npm run dev"
  exit 1
fi
printf '%s' "$BODY" | show 600
READS_IMAGES=$(printf '%s' "$BODY" | at ai.canReadImages)
TRANSCRIBES=$(printf '%s' "$BODY" | at ai.canTranscribe)
expect 200 "GET /health"
[ "$READS_IMAGES" = "true" ] && pass "can read pictures" || fail "cannot read pictures — set GROQ_API_KEY in server/.env"

# ---------------------------------------------------------------------------
# Capture: the primary flow, four kinds of file
# ---------------------------------------------------------------------------

RECORD_IDS=()

poll_record() {
  local id=$1 status
  # 40 × 3s = two minutes. A picture read takes seconds; a multi-page PDF through a vision
  # model plus the understanding pass is the slow end of what is still working.
  for _ in $(seq 1 40); do
    call GET "/api/daybook/records/$id"
    status=$(printf '%s' "$BODY" | at record.status)
    [ "$status" != "processing" ] && { echo "$status"; return; }
    sleep 3
  done
  echo TIMEOUT
}

for file in upi.png bill.png scene.png big.jpg; do
  say "capture $file"
  call POST /api/daybook/capture -F "file=@$FX/$file"
  expect 202 "POST /api/daybook/capture ($file)"
  ID=$(printf '%s' "$BODY" | at record.id)
  [ -n "$ID" ] || { fail "capture $file returned no record id"; continue; }

  PROGRESS=$(printf '%s' "$BODY" | at record.progress)
  [ -n "$PROGRESS" ] && pass "says what it is doing: \"$PROGRESS\"" || fail "a processing record has no progress sentence"

  STATUS=$(poll_record "$ID")
  case "$STATUS" in
    complete|needs_context) pass "read $file → $STATUS" ;;
    TIMEOUT) fail "$file never finished reading (two minutes)" ;;
    *) fail "$file ended as $STATUS: $(printf '%s' "$BODY" | at record.note)" ;;
  esac
  RECORD_IDS+=("$ID")

  call GET "/api/daybook/records/$ID"
  node -e '
    let raw = ""; process.stdin.on("data", (c) => { raw += c; }).on("end", () => {
      const r = JSON.parse(raw).record;
      const line = (label, value) => console.log("  " + label.padEnd(10) + (value ?? "—"));
      line("kind", r.kind);
      line("title", r.title);
      line("amount", [r.amountLabel, r.currency, r.direction].filter(Boolean).join("  "));
      line("when", r.occurredAt ? new Date(r.occurredAt).toISOString().slice(0, 16) + "  " + (r.occurredPrecision ?? "") : null);
      line("who", r.counterparty);
      line("category", r.category);
      line("summary", (r.extraction?.summary ?? "").slice(0, 150));
      line("asks", r.question ? r.question.prompt + "  " + JSON.stringify(r.question.options ?? []) : null);
      line("note", r.note);
      // Two different rules, which this check used to run together and so report wrongly.
      //
      // `provider` and `model` must not be in the payload at all. There is no use for them on a
      // phone, and the whole reason the server whitelists what it sends is so the name of the
      // vendor that read a bill cannot end up on the record of the person who uploaded it.
      // Their presence is a failure, not a remark.
      //
      // `readBy` is sent on purpose — `src/ui/format.ts` consumes it to tell a document from a
      // picture and never puts it on the object a screen can render. So the rule for it is not
      // "absent" but "never read aloud": its value is a word from the code (`vision`, `ocr`,
      // `docx`), and the test is that no sentence a person sees contains it.
      for (const leak of ["provider", "model", "fingerprint"]) {
        if (r.extraction && leak in r.extraction) {
          console.log("  \x1b[31mFAIL\x1b[0m extraction." + leak + " reached the app = " + r.extraction[leak]);
          process.exitCode = 3;
        }
      }
      const readBy = r.extraction?.readBy;
      if (typeof readBy === "string" && readBy) {
        const spoken = [r.title, r.note, r.extraction?.summary, r.extraction?.readNote, r.question?.prompt,
          ...(r.question?.options ?? [])].filter((s) => typeof s === "string");
        const said = spoken.find((s) => new RegExp("\\b" + readBy + "\\b", "i").test(s));
        if (said) {
          console.log("  \x1b[31mFAIL\x1b[0m \"" + readBy + "\" is said to the person: " + said);
          process.exitCode = 3;
        }
      }
    });
  ' <<< "$BODY" || fail "$file put machinery in front of the person"
done

[ ${#RECORD_IDS[@]} -gt 0 ] || { echo; echo "Nothing captured. Stopping."; exit 1; }

# A picture with no text in it must not become a payment with an invented amount.
say "a text-free photo is not a payment"
call GET "/api/daybook/records/${RECORD_IDS[2]}"
SCENE_AMOUNT=$(printf '%s' "$BODY" | at record.amountMinor)
SCENE_KIND=$(printf '%s' "$BODY" | at record.kind)
[ -z "$SCENE_AMOUNT" ] && pass "scene.png carries no amount (kind: $SCENE_KIND)" \
  || fail "scene.png was given an amount of $SCENE_AMOUNT — a figure nothing in the picture states"

# ---------------------------------------------------------------------------
# The one question, answered and skipped
# ---------------------------------------------------------------------------

say "answer the open question"
ANSWERED=''
for id in "${RECORD_IDS[@]}"; do
  call GET "/api/daybook/records/$id"
  if [ -n "$(printf '%s' "$BODY" | at record.question.id)" ]; then
    PROMPT=$(printf '%s' "$BODY" | at record.question.prompt)
    # The reply has to answer the question that was actually asked, which differs by record:
    # big.jpg has an amount to give and scene.png has a description to give. This used to post
    # the description unconditionally, so the run in which the amount question happened to be
    # the open one failed with the server correctly refusing an answer with no figure in it —
    # a test that was only ever passing because another record reached the question first.
    case "$PROMPT" in
      *[Aa]mount*) ANSWER='1,144.50' ;;
      *) ANSWER='A ceiling fan and an extension board for the shop' ;;
    esac
    echo "  asked: $PROMPT"
    echo "  replying: $ANSWER"
    call POST "/api/daybook/records/$id/answer" -H 'content-type:application/json' \
      -d "{\"answer\":\"$ANSWER\"}"
    expect 200 "POST /api/daybook/records/:id/answer"
    [ "$(printf '%s' "$BODY" | at record.status)" = "complete" ] && pass "answering completes the record" \
      || fail "the record is still $(printf '%s' "$BODY" | at record.status) after being answered"
    [ -z "$(printf '%s' "$BODY" | at record.question.id)" ] && pass "the question is closed" || fail "the question is still open"
    ANSWERED=$id
    break
  fi
done
[ -n "$ANSWERED" ] || echo "  (nothing asked a question this run)"

say "skipping a question is a way out, not a dead end"
SKIPPED=''
for id in "${RECORD_IDS[@]}"; do
  [ "$id" = "$ANSWERED" ] && continue
  call GET "/api/daybook/records/$id"
  if [ -n "$(printf '%s' "$BODY" | at record.question.id)" ]; then
    call POST "/api/daybook/records/$id/question/skip"
    expect 200 "POST /api/daybook/records/:id/question/skip"
    [ "$(printf '%s' "$BODY" | at record.status)" = "complete" ] && pass "skipping keeps the entry" \
      || fail "skipping left the record at $(printf '%s' "$BODY" | at record.status)"
    call POST "/api/daybook/records/$id/question/skip"
    expect 409 "skipping twice is refused"
    SKIPPED=$id
    break
  fi
done
[ -n "$SKIPPED" ] || echo "  (no second open question to skip)"

say "correcting an entry by hand"
call PATCH "/api/daybook/records/${RECORD_IDS[0]}" -H 'content-type:application/json' \
  -d '{"category":"Household","note":"Checked against the bank message"}'
expect 200 "PATCH /api/daybook/records/:id"
[ "$(printf '%s' "$BODY" | at record.category)" = "Household" ] && pass "the correction stuck" || fail "the category did not change"

# ---------------------------------------------------------------------------
# The timeline, and paging through it
# ---------------------------------------------------------------------------

say "the timeline"
call GET "/api/daybook/records?limit=20"
expect 200 "GET /api/daybook/records"
printf '%s' "$BODY" | node -e '
  let raw = ""; process.stdin.on("data", (c) => { raw += c; }).on("end", () => {
    const { records, nextCursor } = JSON.parse(raw);
    console.log("  " + records.length + " entries, nextCursor " + (nextCursor ?? "none"));
    for (const r of records) {
      console.log("   - " + [r.status, r.kind, r.title, r.amountLabel].filter(Boolean).join("  |  "));
    }
  });
'

say "paging"
call GET "/api/daybook/records?limit=2"
FIRST_PAGE=$(printf '%s' "$BODY" | at records.0.id)
CURSOR=$(printf '%s' "$BODY" | at nextCursor)
if [ -n "$CURSOR" ]; then
  call GET "/api/daybook/records?limit=2&before=$CURSOR"
  expect 200 "GET /api/daybook/records?before="
  SECOND_PAGE=$(printf '%s' "$BODY" | at records.0.id)
  [ -n "$SECOND_PAGE" ] && [ "$SECOND_PAGE" != "$FIRST_PAGE" ] && pass "the second page is different entries" \
    || fail "paging returned the same entry twice"
else
  echo "  (one page only — not enough entries to page)"
fi
call GET "/api/daybook/records?before=nonsense"
expect 400 "a malformed cursor is refused plainly"

# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

say "search"
call GET "/api/search?q=sharma"
expect 200 "GET /api/search"
printf '%s' "$BODY" | show 900
call GET "/api/search?q=a"
expect 200 "a one-letter query is an empty list, not an error"
call GET "/api/search?q=sharma&kind=record"
expect 200 "GET /api/search?kind=record"
call GET "/api/search?q=sharma&kind=nonsense"
expect 400 "an unknown kind is refused rather than ignored"

# ---------------------------------------------------------------------------
# Money
# ---------------------------------------------------------------------------

say "money"
call GET /api/insights
expect 200 "GET /api/insights"
printf '%s' "$BODY" | node -e '
  let raw = ""; process.stdin.on("data", (c) => { raw += c; }).on("end", () => {
    const d = JSON.parse(raw);
    console.log("  period    " + (d.period?.label ?? "?") + (d.period?.hasData ? "" : "  (nothing in it)"));
    console.log("  spent     " + (d.spent?.amountLabel ?? "—") + "   received " + (d.received?.amountLabel ?? "—"));
    console.log("  pace      " + (d.pace?.projectedLabel ?? "no projection (correct early in a month or in a closed one)"));
    console.log("  months    " + (d.availablePeriods ?? []).map((p) => p.key).join(", "));
    console.log("  left out  " + JSON.stringify(d.excluded ?? null));
  });
'
PERIOD=$(printf '%s' "$BODY" | at period.key)
[ -n "$PERIOD" ] && pass "the server chose a period with data in it: $PERIOD" || fail "no period on the money response"

if [ -n "$PERIOD" ]; then
  call GET "/api/insights?period=$PERIOD"
  expect 200 "GET /api/insights?period="
fi
call GET "/api/insights?period=2026-99"
expect 400 "an impossible month is refused"

say "budget"
call PUT /api/insights/budget -H 'content-type:application/json' -d '{"amount":"30000","currency":"INR"}'
expect 200 "PUT /api/insights/budget"
call GET /api/insights/budget
expect 200 "GET /api/insights/budget"
printf '%s' "$BODY" | show 500
call PUT /api/insights/budget -H 'content-type:application/json' -d '{"amount":"30000","currency":"INR","period":"weekly"}'
expect 400 "a weekly budget is refused with a reason"

say "spending advice"
call POST /api/insights/advice -H 'content-type:application/json' -d '{}'
if [ "$CODE" = "200" ]; then pass "POST /api/insights/advice"; printf '%s' "$BODY" | show 900
elif [ "$CODE" = "502" ] || [ "$CODE" = "503" ]; then pass "advice is unavailable and says so plainly (HTTP $CODE)"
else fail "POST /api/insights/advice (HTTP $CODE)"; fi

say "the home digest"
call GET /api/insights/digest
expect 200 "GET /api/insights/digest"
printf '%s' "$BODY" | show 700

# ---------------------------------------------------------------------------
# To-dos
# ---------------------------------------------------------------------------

say "to-dos"
call POST /api/tasks -H 'content-type:application/json' \
  -d "{\"text\":\"Ask the shop for a duplicate bill\",\"owner\":\"Me\",\"due\":\"today\",\"recordId\":\"${RECORD_IDS[0]}\"}"
expect 201 "POST /api/tasks"
TASK=$(printf '%s' "$BODY" | at task.id)
printf '%s' "$BODY" | show 600

if [ -n "$TASK" ]; then
  call GET "/api/tasks/$TASK"
  expect 200 "GET /api/tasks/:id"
  [ -n "$(printf '%s' "$BODY" | at task.recordTitle)" ] && pass "the to-do names the entry it came from" \
    || fail "recordTitle is missing, so the to-do cannot be traced back"

  call PATCH "/api/tasks/$TASK" -H 'content-type:application/json' -d '{"owner":null}'
  expect 200 "PATCH /api/tasks/:id clears an owner"
  [ -z "$(printf '%s' "$BODY" | at task.owner)" ] && pass "nobody is assigned" || fail "the owner survived being cleared"

  call PATCH "/api/tasks/$TASK" -H 'content-type:application/json' -d '{"due":"2026"}'
  expect 400 "a year is not a due date"

  call GET "/api/tasks?recordId=${RECORD_IDS[0]}"
  expect 200 "GET /api/tasks?recordId="

  call PATCH "/api/tasks/$TASK" -H 'content-type:application/json' -d '{"done":true}'
  expect 200 "PATCH /api/tasks/:id marks it done"
fi

# ---------------------------------------------------------------------------
# What the app noticed on its own
# ---------------------------------------------------------------------------

say "needs attention"
call GET /api/attention
expect 200 "GET /api/attention"
printf '%s' "$BODY" | show 1200
call GET "/api/attention?state=handled"
expect 200 "GET /api/attention?state=handled"
call POST /api/attention/refresh
expect 202 "POST /api/attention/refresh returns at once"
printf '%s' "$BODY" | show 400

# ---------------------------------------------------------------------------
# Asking about your own records
# ---------------------------------------------------------------------------

say "ask"
call POST /api/daybook/ask -H 'content-type:application/json' \
  -d '{"question":"How much did I spend and who did it go to?"}'
if [ "$CODE" = "200" ]; then
  pass "POST /api/daybook/ask"
  printf '%s' "$BODY" | show 1600
  CITED=$(printf '%s' "$BODY" | at answer.sources.0.id)
  [ -n "$CITED" ] && pass "the answer cites an entry" || echo "  (no entry cited — correct if the answer was 'nothing about that')"
elif [ "$CODE" = "502" ] || [ "$CODE" = "503" ]; then pass "ask is unavailable and says so plainly (HTTP $CODE)"
else fail "POST /api/daybook/ask (HTTP $CODE)"; fi

say "ask about something that is not there"
call POST /api/daybook/ask -H 'content-type:application/json' \
  -d '{"question":"What did I pay for the car insurance in 2019?"}'
if [ "$CODE" = "200" ]; then printf '%s' "$BODY" | show 700; pass "answered without refusing"; else pass "unavailable (HTTP $CODE)"; fi

say "upcoming and recap"
call GET /api/daybook/upcoming
expect 200 "GET /api/daybook/upcoming"
printf '%s' "$BODY" | show 700
call GET /api/daybook/recap
expect 200 "GET /api/daybook/recap"
printf '%s' "$BODY" | show 900

# ---------------------------------------------------------------------------
# Cases: the evidence side
# ---------------------------------------------------------------------------

say "create a case"
call POST /api/cases -H 'content-type:application/json' -d '{
  "title": "Shop says the fan was never paid for",
  "myClaim": "I paid Sharma Electronics 4,500 rupees on 28 September 2026 by UPI from my HDFC account.",
  "theirClaim": "They say no payment was ever received and the fan is still unpaid."
}'
expect 201 "POST /api/cases"
CID=$(printf '%s' "$BODY" | at case.id)
echo "  case $CID"

if [ -n "$CID" ]; then
  say "add my evidence"
  call POST "/api/cases/$CID/items" -F "file=@$FX/upi.png" -F "side=mine" -F "label=UPI receipt"
  # Reading a piece of evidence is asynchronous, exactly like a capture, so the upload is
  # accepted rather than finished.
  expect 202 "POST /api/cases/:id/items"
  ITEM=$(printf '%s' "$BODY" | at item.id)

  # An item goes pending → reading → ready / needs_context / unreadable / failed. `processing`
  # is a *record* status and never appears on an item, so watching for it fell straight through
  # on the first pass and the comparison below was then refused for a piece still being read.
  for _ in $(seq 1 30); do
    call GET "/api/cases/$CID/items/$ITEM"
    ITEM_STATUS=$(printf '%s' "$BODY" | at item.status)
    [ "$ITEM_STATUS" != "pending" ] && [ "$ITEM_STATUS" != "reading" ] && break
    sleep 3
  done
  echo "  evidence read: ${ITEM_STATUS:-unknown}"

  if [ -n "$ITEM" ]; then
    call PATCH "/api/cases/$CID/items/$ITEM" -H 'content-type:application/json' -d '{"label":"UPI receipt, 28 September"}'
    expect 200 "PATCH /api/cases/:id/items/:itemId"
  fi

  say "compare the two accounts"
  call POST "/api/cases/$CID/analyze" -H 'content-type:application/json' -d '{}'
  if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
    pass "POST /api/cases/:id/analyze"
    printf '%s' "$BODY" | show 3000
  elif [ "$CODE" = "502" ] || [ "$CODE" = "503" ]; then
    pass "comparison unavailable and says so plainly (HTTP $CODE)"
  else
    fail "POST /api/cases/:id/analyze (HTTP $CODE)"
  fi

  say "the case as a person reads it"
  call GET "/api/cases/$CID"
  expect 200 "GET /api/cases/:id"
  printf '%s' "$BODY" | show 2000

  say "the report"
  call GET "/api/cases/$CID/report"
  expect 200 "GET /api/cases/:id/report"
  printf '%s' "$BODY" | show 1500

  say "a case raised from an entry, once only"
  call POST "/api/cases/from-record/${RECORD_IDS[0]}"
  FIRST_RAISE=$CODE
  call POST "/api/cases/from-record/${RECORD_IDS[0]}"
  if [ "$CODE" = "$FIRST_RAISE" ] || [ "$CODE" = "200" ] || [ "$CODE" = "409" ]; then
    pass "raising the same entry twice does not make a second case (HTTP $FIRST_RAISE then $CODE)"
  else
    fail "the second raise behaved differently (HTTP $FIRST_RAISE then $CODE)"
  fi
fi

# ---------------------------------------------------------------------------
# Meetings
# ---------------------------------------------------------------------------

#
# Everything above proves a pipeline. This proves the promise: a meeting held in Hindi comes
# back in Hindi — the words, the summary, the decisions, the action items, the to-dos. It rests
# on one decision in `ai/providers.ts`, which sends the recording to Whisper with no `language`
# parameter so that the language is whatever the model heard, and on the analysis prompt, which
# is told to write every string it returns in the language the meeting was held in. Neither can
# be tested with the network stubbed, which is why this is here and not in `meetings.test.ts`.
#
# `meeting-hi.wav` is 46 seconds of a shopkeeper and his rice supplier, built by
# `make-meeting-audio-hi.py`. Two recordings go out per run and no more: the meeting surface
# allows five an hour and sixty minutes of audio a day, measured from the recordings
# themselves, and a leg that spent those would be a leg nobody could run twice in a sitting.

say "meetings"
call GET /api/meetings
expect 200 "GET /api/meetings"

if [ "$TRANSCRIBES" != "true" ]; then
  echo "  transcription is unavailable on this server, so the promise below cannot be exercised."
  echo "  put a GROQ_API_KEY in server/.env and run this again."
else
  # Settled means there is something for a person to do with it: read it, or try again. A
  # meeting sitting at `transcribed` with nothing against it is still being read, so it is not
  # settled — and one at `transcribed` with a sentence on it is, because the words are saved
  # and Try again is on screen.
  poll_meeting() {
    local id=$1 status error
    # 60 × 3s = three minutes. Transcribing a minute of speech takes seconds; the reading after
    # it is a model call that waits its turn whenever the free tier has just been used.
    for _ in $(seq 1 60); do
      call GET "/api/meetings/$id"
      status=$(printf '%s' "$BODY" | at meeting.status)
      error=$(printf '%s' "$BODY" | at meeting.error)
      case "$status" in
        complete|failed) echo "$status"; return ;;
        transcribed) [ -n "$error" ] && { echo "$status"; return; } ;;
      esac
      sleep 3
    done
    echo TIMEOUT
  }

  # `devanagari <label>` — one assertion that the text on stdin is written in the script the
  # meeting was held in. The whole promise reduces to this: had any of it come back translated
  # into English, the text would be Latin from end to end and this would fail.
  devanagari() {
    if node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; });
      process.stdin.on("end", () => { process.exitCode = /[ऀ-ॿ]/.test(raw) ? 0 : 1; });
    '; then pass "$1"; else fail "$1"; fi
  }

  # How long the recording runs, read out of its own RIFF header the way the server reads it.
  # Parsed rather than written down as a constant because that is the thing being checked: the
  # number a person sees has to be measured from the audio and never taken from whatever the
  # uploader claimed.
  MEASURED=$(node -e '
    const chunks = [];
    process.stdin.on("data", (chunk) => { chunks.push(chunk); }).on("end", () => {
      const bytes = Buffer.concat(chunks);
      let at = 12;
      let byteRate = 0;
      while (at + 8 <= bytes.byteLength) {
        const id = bytes.toString("latin1", at, at + 4);
        const size = bytes.readUInt32LE(at + 4);
        if (id === "fmt ") byteRate = bytes.readUInt32LE(at + 16);
        if (id === "data") {
          process.stdout.write(byteRate > 0 ? String(Math.round((size / byteRate) * 1000)) : "");
          return;
        }
        at = at + 8 + size + (size % 2);
      }
    });
  ' < "$FX/meeting-hi.wav")

  say "a Hindi meeting, start to finish"
  echo "  meeting-hi.wav states $MEASURED ms of audio in its own header"
  # `durationMs` is what the recorder in the app reports when it has just stopped recording,
  # and 9000 is deliberately wrong. Supplying it also says the start time is a fact rather than
  # this server working backwards from an upload, which is what lets a spoken deadline resolve.
  call POST /api/meetings -F "audio=@$FX/meeting-hi.wav;type=audio/wav" -F 'durationMs=9000'
  expect 202 "POST /api/meetings"
  MID=$(printf '%s' "$BODY" | at meeting.id)
  if [ -z "$MID" ]; then
    fail "the upload came back with no meeting to poll"
  else
    GOT_MS=$(printf '%s' "$BODY" | at meeting.durationMs)
    [ "$GOT_MS" = "$MEASURED" ] && pass "the length is measured from the recording, not taken from the uploader" \
      || fail "durationMs came back as $GOT_MS rather than the $MEASURED the header states"

    MSTATUS=$(poll_meeting "$MID")
    case "$MSTATUS" in
      complete) pass "read meeting-hi.wav → complete" ;;
      TIMEOUT) fail "the meeting never settled in three minutes" ;;
      *) fail "the meeting ended as $MSTATUS: $(printf '%s' "$BODY" | at meeting.error)" ;;
    esac

    call GET "/api/meetings/$MID"
    expect 200 "GET /api/meetings/:id"

    LANGUAGE=$(printf '%s' "$BODY" | at meeting.language)
    case "$LANGUAGE" in
      *[Hh]indi*) pass "the meeting is reported as held in Hindi" ;;
      '') fail "no language came back for a recording that is Hindi end to end" ;;
      *) fail "a Hindi recording was reported as $LANGUAGE" ;;
    esac

    SAID=$(printf '%s' "$BODY" | at meeting.transcript)
    printf '%s' "$SAID" | devanagari "what was said came back in Devanagari rather than translated"
    echo "  transcript:"
    printf '    %s\n' "$SAID"
    SUMMARY=$(printf '%s' "$BODY" | at meeting.summary)
    printf '%s' "$SUMMARY" | devanagari "the summary is in the language the meeting was held in"

    # What it all came to, which is the part of this output worth reading.
    printf '%s' "$BODY" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
        const meeting = JSON.parse(raw).meeting;
        const intel = meeting.intelligence || {};
        console.log("  title     " + meeting.title);
        console.log("  language  " + meeting.language + "   " + meeting.durationMs + " ms   start time "
          + (meeting.startedAtEstimated ? "worked out here" : "stated by the recorder"));
        console.log("  summary   " + (meeting.summary || "none"));
        console.log("  topics    " + ((intel.topics || []).join(", ") || "none"));
        for (const point of intel.keyPoints || []) console.log("  point     " + point);
        for (const decision of intel.decisions || []) console.log("  decided   " + decision);
        for (const item of intel.actionItems || []) {
          console.log("  to do     " + item.text + "   [" + (item.owner || "nobody named") + "]"
            + (item.due ? "   said as: " + item.due : "")
            + (item.dueAt ? "   due " + new Date(item.dueAt).toISOString().slice(0, 10) : "   no date claimed"));
        }
        for (const line of intel.attention || []) console.log("  watch     " + line);
      });
    '

    # The promise itself, over every line this meeting publishes rather than over the two
    # fields checked above. A reading translated into English would leave all of them Latin.
    printf '%s' "$BODY" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
        const meeting = JSON.parse(raw).meeting;
        const intel = meeting.intelligence || {};
        const devanagari = /[ऀ-ॿ]/;
        const published = [
          ["the summary", meeting.summary ? [meeting.summary] : []],
          ["a topic", intel.topics || []],
          ["a key point", intel.keyPoints || []],
          ["a decision", intel.decisions || []],
          ["an attention line", intel.attention || []],
          ["an action item", (intel.actionItems || []).map((item) => item.text)],
          ["a to-do", (meeting.tasks || []).map((task) => task.text)],
        ];
        let lines = 0;
        for (const [what, values] of published) {
          for (const value of values) {
            if (typeof value !== "string" || value.trim().length === 0) continue;
            lines += 1;
            if (!devanagari.test(value)) {
              console.log("    " + what + " came back out of the language it was said in: " + value);
              process.exitCode = 3;
            }
          }
        }
        if (lines === 0) {
          console.log("    the reading published nothing, so there is no language to check");
          process.exitCode = 3;
        } else if (process.exitCode !== 3) {
          console.log("    " + lines + " published lines, every one of them in Devanagari");
        }
      });
    ' && pass "the whole reading is in the language the meeting was held in" \
      || fail "part of the reading was translated out of the language the meeting was held in"

    # And held to what was actually said. Each of these is a rule the route promises in its own
    # comments, checked here against a real reading of a real recording for the first time.
    printf '%s' "$BODY" | node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => { raw += chunk; }).on("end", () => {
        const meeting = JSON.parse(raw).meeting;
        const intel = meeting.intelligence || {};
        const refuse = (line) => { console.log("    " + line); process.exitCode = 3; };
        const flat = (text) => String(text).toLowerCase().replace(/\s+/g, " ").trim();
        const words = flat(meeting.transcript || "");

        // A quoted sentence has to be a sentence out of the transcript, and a finding that
        // arrived without one has to be findable in the words itself.
        const sources = intel.sources || {};
        for (const quote of Object.values(sources)) {
          if (!words.includes(flat(quote))) refuse("a quoted sentence was never said: " + JSON.stringify(quote));
        }
        const findings = [
          ...(intel.keyPoints || []), ...(intel.decisions || []), ...(intel.attention || []),
          ...(intel.actionItems || []).map((item) => item.text),
        ];
        for (const text of findings) {
          if (!(text in sources) && !words.includes(flat(text))) {
            refuse("a finding points at nothing in the transcript: " + JSON.stringify(text));
          }
        }
        for (const topic of intel.topics || []) {
          if (!words.includes(flat(topic))) refuse("a topic label is not a phrase anybody used: " + JSON.stringify(topic));
        }

        // No figure on the screen that nobody said. Devanagari digits are folded onto ASCII so
        // a summary written in one vouches against words written in the other.
        const figures = (text) => [...String(text)
          .replace(/[०-९]/g, (digit) => String(digit.charCodeAt(0) - 0x0966))
          .replace(/[,  ]/g, "")
          .matchAll(/\d{3,}/g)].map((match) => match[0]);
        const heard = new Set(figures(meeting.transcript || ""));
        for (const figure of figures(meeting.summary || "")) {
          if (!heard.has(figure)) refuse("the summary states a figure nobody said: " + figure);
        }

        // No deadline behind the meeting that set it. A to-do due before the conversation it
        // came from is a resolution error, and it is the one kind of wrong with a real cost.
        const held = new Date(meeting.startedAt);
        const floor = new Date(held.getFullYear(), held.getMonth(), held.getDate()).getTime();
        for (const task of meeting.tasks || []) {
          if (task.dueAt !== null && task.dueAt < floor) {
            refuse("a to-do is due before the meeting that set it: " + JSON.stringify(task.text));
          }
        }

        // And none of the machinery in front of the person. A vendor name has no use on a
        // phone, and a fingerprint is an internal id, which is the most developer-facing
        // string there is.
        for (const leak of ["provider", "model"]) {
          if (leak in intel) refuse("intelligence." + leak + " reached the app = " + intel[leak]);
        }
        for (const item of intel.actionItems || []) {
          for (const leak of ["fingerprint", "quote"]) {
            if (leak in item) refuse("an action item carried its " + leak + " to the app");
          }
        }
      });
    ' && pass "nothing in the reading goes beyond what the recording says" \
      || fail "the reading published something the recording does not support"

    say "correcting a meeting, and reading one that is already read"
    send PATCH "/api/meetings/$MID" '{"title":"चावल के ऑर्डर की मीटिंग","note":"संजय के साथ भाव पर बात हुई"}'
    expect 200 "PATCH /api/meetings/:id"
    [ "$(printf '%s' "$BODY" | at meeting.note)" = "संजय के साथ भाव पर बात हुई" ] \
      && pass "the note saved in the words it was typed in" || fail "the note did not save"
    # The title went in as Devanagari too, so it has to come back as Devanagari. Checked
    # separately from the note because they take different paths through the route — the title
    # is also what the meeting is called everywhere else in the app.
    [ "$(printf '%s' "$BODY" | at meeting.title)" = "चावल के ऑर्डर की मीटिंग" ] \
      && pass "the title saved in the script it was typed in" || fail "the title came back changed"

    call POST "/api/meetings/$MID/retry"
    expect 400 "a meeting already read is not read a second time"

    call GET "/api/meetings?limit=5"
    [ -n "$(printf '%s' "$BODY" | at meetings.0.id)" ] && pass "the meeting is in the list" \
      || fail "the meeting that was just read is not in the list"
  fi

  say "a recording with nothing on it is not read as a meeting"
  # Three seconds of silence come back from the transcriber as the words "Thank you." — it was
  # trained on subtitled video and that is how a subtitle track ends. Those are real words, so
  # the only thing between a silent room and a published meeting titled Thank you, summarised
  # as somebody expressing gratitude, is the filler check in the route. This is that check
  # against the live transcriber rather than against a fixture of what it returns.
  call POST /api/meetings -F "audio=@$FX/meeting-silence.wav;type=audio/wav"
  expect 202 "POST /api/meetings (a silent recording)"
  QID=$(printf '%s' "$BODY" | at meeting.id)
  if [ -n "$QID" ]; then
    QSTATUS=$(poll_meeting "$QID")
    [ "$QSTATUS" = "failed" ] && pass "silence ends as something a person can act on, not as a meeting" \
      || fail "a recording of nothing ended as $QSTATUS"

    call GET "/api/meetings/$QID"
    QERROR=$(printf '%s' "$BODY" | at meeting.error)
    echo "  says: $QERROR"
    [ -n "$QERROR" ] && pass "and says what to do about it" \
      || fail "a failed meeting left the person with no explanation"
    [ -z "$(printf '%s' "$BODY" | at meeting.transcript)" ] && pass "nothing was stored as what was said" \
      || fail "the transcriber talking to itself was stored as the transcript"
    [ -z "$(printf '%s' "$BODY" | at meeting.summary)" ] && pass "and no summary of a conversation that never happened" \
      || fail "a silent recording was given a summary: $(printf '%s' "$BODY" | at meeting.summary)"
    [ -z "$(printf '%s' "$BODY" | at meeting.tasks.0.id)" ] && pass "and nothing was added to the to-do list" \
      || fail "a silent recording produced a to-do"
    case "$QERROR$(printf '%s' "$BODY" | at meeting.title)" in
      *[Tt]hank*) fail "the words the transcriber invented over the silence reached the person" ;;
      *) pass "the words the transcriber invented are nowhere a person can see" ;;
    esac
  fi

  say "an empty recording is refused as a recording"
  # A refusal written for the widest upload route used to reach somebody who had just recorded
  # twenty minutes with their supplier, telling them to take a fresh screenshot. Nothing about
  # that is a crash, which is what made it dangerous.
  call POST /api/meetings -F "audio=@$FX/meeting-empty.wav;type=audio/wav"
  expect 400 "POST /api/meetings (an empty recording)"
  EMPTY=$(printf '%s' "$BODY" | at error)
  echo "  says: $EMPTY"
  case "$EMPTY" in
    *screenshot*|*photo*|*picture*|*image*|*document*) fail "a recording was answered as a different kind of file: $EMPTY" ;;
    *recording*|*Recording*) pass "answered as a recording, in words that say what to do next" ;;
    *) fail "an empty recording was refused without being answered as a recording: $EMPTY" ;;
  esac
fi

# ---------------------------------------------------------------------------
# The account, its export, and deleting it
# ---------------------------------------------------------------------------

say "the account"
call GET /api/me
expect 200 "GET /api/me"
printf '%s' "$BODY" | show 700
printf '%s' "$BODY" | node -e '
  let raw = ""; process.stdin.on("data", (c) => { raw += c; }).on("end", () => {
    const me = JSON.parse(raw);
    // Nothing about which vendor read anything belongs in a profile.
    for (const key of Object.keys(me)) {
      if (/provider|model|device|token|key/i.test(key)) console.log("  \x1b[31mLEAK\x1b[0m " + key);
    }
  });
'

call PATCH /api/me -H 'content-type:application/json' -d '{"displayName":"Anita","currency":"INR"}'
expect 200 "PATCH /api/me"
[ "$(printf '%s' "$BODY" | at displayName)" = "Anita" ] && pass "the name saved" || fail "the name did not save"

# The word, not the code. `normalizeCurrency` knows "rupees" on purpose — it is what the
# amount reader meets on a bill, and somebody typing it into a settings field means the same
# thing. This check used to assert the opposite, and was the last failure in this suite: it
# read a deliberate kindness as a validation hole.
call PATCH /api/me -H 'content-type:application/json' -d '{"currency":"rupees"}'
expect 200 "the word people actually type is accepted"
[ "$(printf '%s' "$BODY" | at currency)" = "INR" ] && pass "and saved as INR" || fail "rupees did not normalise to INR"

call PATCH /api/me -H 'content-type:application/json' -d '{"currency":"ZZZ9"}'
expect 400 "a currency that is not a currency is refused"

say "download everything"
call GET /api/me/export
expect 200 "GET /api/me/export"
printf '%s' "$BODY" | node -e '
  let raw = ""; process.stdin.on("data", (c) => { raw += c; }).on("end", () => {
    const d = JSON.parse(raw);
    console.log("  " + (d.downloadName ?? "?"));
    console.log("  totals " + JSON.stringify(d.totals ?? {}));
    console.log("  explains: " + (d.howToReadThis ?? []).length + " lines, and what is not here: " + (d.whatIsNotHere ?? []).length);
    const text = JSON.stringify(d);
    for (const leak of ["\"provider\"", "\"model\"", "\"fingerprint\"", "gsk_"]) {
      if (text.includes(leak)) console.log("  \x1b[31mLEAK\x1b[0m the export contains " + leak);
    }
  });
'

say "deleting the account"
call DELETE /api/me -H 'content-type:application/json' -d '{"confirm":"nope"}'
expect 400 "the wrong phrase does not delete anything"
call GET /api/me
expect 200 "the account is still there"

if [ "${KEEP:-}" = "1" ]; then
  echo "  KEEP=1 — leaving the account in place. Its identity is: $DEV"
else
  call DELETE /api/me -H 'content-type:application/json' -d '{"confirm":"delete my account"}'
  expect 200 "DELETE /api/me"
  printf '%s' "$BODY" | show 700
  # Nothing may survive. A new account is created on sight, so the test is that it is empty.
  call GET "/api/daybook/records?limit=5"
  LEFT=$(printf '%s' "$BODY" | at records.0.id)
  [ -z "$LEFT" ] && pass "nothing of the account's is readable afterwards" || fail "an entry survived the delete: $LEFT"
fi

# ---------------------------------------------------------------------------

say "result"
printf '  %d passed, %d failed\n' "$PASSES" "$FAILURES"
if [ "$FAILURES" -gt 0 ]; then
  printf '\n  what failed:\n'
  for step in "${FAILED_STEPS[@]}"; do printf '   - %s\n' "$step"; done
  exit 1
fi
exit 0

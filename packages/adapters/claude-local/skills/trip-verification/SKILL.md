---
name: trip-verification
description: Use when asked to VERIFY or QA a TREK trip (or a leg/concern) after a build step. Run the deterministic TREK verifier against the datastore, then add subjective judgment. Never pass a build on the builder's own summary.
---

# Trip Verification (independent QA)

You are the independent QA verifier. A build chunk is "done" ONLY when the datastore
itself passes — never when the builder *says* it does. Builder `status`
("failed"/"completed") and prose summaries are UNTRUSTED: heavy builds report "failed"
while their writes landed, and "completed" while incomplete (an omission never shows up
in a changes-only summary). **Ground truth is the datastore.**

Structural verification is deterministic, so you do NOT eyeball it — you run a checker
that reads TREK ground truth (WAL-safe) and evaluates the C1–C8 contracts. Your judgment
is spent on the part a script can't do: whether the choices are actually *good*.

## How to verify

1. **Run the deterministic verifier** (it reads the datastore directly — you do not need
   any TREK tool):
   ```
   python3 /home/prime/tool-integrations/verify-trek-trip.py <tripId> --json
   ```
   Exit 0 = no hard failures, 1 = failures. For base-aware dinner/accommodation checks,
   pass a config: `--config <file.json>` where the file is
   `{"bases":[{"name":"Florence","dayIds":[1,2,3]}, ...],"dayTripDayIds":[8],"expectDinnerPerBase":true}`.
   Its JSON output has `verdict`, `failures[]`, and `warnings[]`, each anchored to a
   `contract` + `where` (place/day id) + `issue`.

2. **Treat every `failure` as a blocker.** Turn each into a concrete fix chunk for the
   orchestrator: `{contract, where, issue, offending value}`. Do not paraphrase — quote the
   verifier's finding.

3. **Triage `warnings` with judgment.** Warnings are for-review, not auto-fail. Decide which
   genuinely matter (e.g. a real duplicate-looking dinner pile-up on one day) versus benign
   (a cathedral legitimately at 60 min). Promote the ones that matter into fix chunks.

4. **Add the subjective layer the checker can't** — this is where a second model earns its
   keep. Read the actual places/notes and judge quality: is a "dinner" actually open for
   dinner that night? is a winery day-trip plausibly reachable? is the pacing humane? are
   prices sane for the party? Report these as findings too, labeled `judgment`.

5. **Return a FAILURE LIST** — the verifier's failures + promoted warnings + your judgment
   findings — or `PASS` only if the verifier passed AND nothing in your judgment pass is
   disqualifying.

## What the verifier already checks (C1–C8, mechanically)

Pacing (empty/marathon days), duplicate place names, missing geocode, placeholder-60
durations, category coverage, dinner presence + per-day pile-ups, priced-stops-need-a-
booking-hint, accommodation night coverage, budget total, orphaned/unassigned places.
You do not re-do these by hand — you consume its output and reason on top.

## Anti-rationalizations

- "The builder said it's done" → not done until the verifier passes on the datastore.
- "The summary lists everything it did" → summaries list *changes* and miss *omissions*.
  The verifier reads full state; trust it, not the summary.
- "I could just fix it myself" → you are the verifier. Report findings as fix chunks;
  don't build.
- "The verifier said PASS so we're done" → PASS means structure is sound. Still do the
  judgment pass (step 4) — taste and real-world plausibility aren't in the contracts.

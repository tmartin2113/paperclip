# CEO Orchestration Playbook — Scope

**Goal:** turn "file a Paperclip issue: *plan a 2-week Tuscany trip*" into an autonomous
**decompose → delegate → verify-against-truth → iterate** loop run by the CEO, using the
pattern proven by hand in the 2026-07-30 Tuscany build. Generalizes to any long,
verify-heavy build that mutates an external datastore (TREK, and beyond).

## Why this is needed (the lessons being encoded)
From the Tuscany build, four things had to be judgment-in-the-loop and must become CEO behavior:
1. **Decompose.** Handing one doer "build the whole trip" overflowed context and failed.
   Bounded single-concern chunks (~15–25 tool calls) each completed cleanly.
2. **Verify against the datastore, not the doer's self-report.** Every clean "done" hid a
   gap (missing Uffizi/David, stale day titles, flat-60 durations, leftover Pisa notes).
   The doer's `status` ("failed"/"completed") is *untrusted*.
3. **Iterate.** Catch the gap → dispatch a fix chunk → re-verify → loop until a checklist passes.
4. **KG-first, bounded, sequential.** Research once into the pooled KG; build from it; one
   doer chunk at a time (single-27B contention).

## Role mapping (Paperclip)
| Role | Adapter | Job in the loop |
|---|---|---|
| **CEO** | claude_local | Orchestrator: frames task, decomposes, sequences chunks, drives the iterate loop, talks to the user. Runs the playbook below. |
| **Researcher / Builder doer** | ironclaw_gateway | Executes one bounded chunk (has `travel-planning` skill + `trek_*` tools + pooled KG). |
| **QA** | claude_local or ironclaw | Re-reads the DATASTORE (TREK/KG) after each chunk and checks it against the chunk's verification contract. The crucial, currently-missing step. |
| **Pooled KG** | ironclaw-pg | Shared research substrate; asserted once, queried by all. |

## The orchestration loop (CEO state machine)
```
1. FRAME      parse task (dest, dates, travelers, constraints); kg_query for existing research.
2. RESEARCH   if KG thin → delegate region research chunks to Researcher (assert into KG). Bounded per region.
3. DESIGN     Researcher queries KG → proposes bases + day skeleton. CEO posts it to the user for
              approval (Paperclip comment/gate) on large trips. [human checkpoint]
4. PLAN CHUNKS CEO builds a chunk list, each ONE base or ONE concern:
              [per-base legs] → [accommodations] → [budget] → [transport] → [durations] → [dining/base] → [notes]
5. BUILD+VERIFY LOOP  for each chunk, sequentially:
              a. delegate chunk to Builder doer (bounded scope, explicit "do ONLY this").
              b. QA re-reads TREK/KG and checks the chunk's VERIFICATION CONTRACT.
              c. if gaps → CEO dispatches a fix chunk for those gaps; re-verify (max K retries).
6. FINALIZE   full-trip verification pass + summary to the user; stop.
```

## Verification contracts (makes "verify" mechanical, not vague)
Each chunk type carries a checklist QA asserts against the datastore. Examples:
- **Base leg:** every day in the base's span has 2–4 stops, each with a category, geocode
  (lat/lng), realistic duration (not flat-60), and a price where relevant; no duplicate names;
  day titles match content.
- **Accommodations:** exactly one linked stay per base, night spans contiguous and covering all nights.
- **Budget:** ≥1 line item per hotel + per priced stop + meals + car + contingency; total is non-zero
  and within ~sane range for the trip length/party.
- **Transport:** a leg for each base change + each day trip.
- **Dining:** each base has ≥1 dinner + day-trip lunches; category=Restaurant, priced, geocoded.
This is the hard/high-value part — specific enough to catch a missing Uffizi, not so brittle it false-flags.

## Invariants (hard rules baked into the CEO prompt/playbook)
- **Chunk budget:** never delegate a task expected to exceed ~25 tool calls. Split it.
- **Truth over report:** QA reads the datastore; ignore the doer's status/self-summary for pass/fail.
- **Sequential doers:** one Builder chunk at a time (single local model).
- **Graceful degradation** is already deployed (force_text tool-strip; AGENT_MAX_TOOL_ITERATIONS=150).
- **KG-first:** research → pooled KG → build-from-KG; refresh stale facts via kg_invalidate.

## What has to be built
1. **CEO orchestration playbook** — the loop + invariants + verification contracts, encoded as the
   CEO's system-prompt guidance OR (cleaner) a saved Paperclip **workflow/skill** the CEO invokes for
   "plan/modify a trip" intents.
2. **Verification-contract library** — the per-chunk-type checklists (start with TREK trips).
3. **QA agent wired to read TREK/KG** — the QA doer needs the read tools + the contract to check against.
4. **Chunk ledger** — CEO tracks done/verified/pending chunks so it iterates correctly. Paperclip's
   issue/subtask model is the natural home (one subtask per chunk, closed only when QA passes).
5. **Bounds & escalation** — max chunks, max fix-retries per chunk, cost/turn budget; surface to the
   user on completion or if stuck.

## Phasing
- **Phase 1 (MVP, semi-autonomous):** CEO decomposes + delegates + QA verifies per chunk, TREK trips
  only; human approves the DESIGN (step 3) and reviews the FINALIZE (step 6). = what was hand-driven,
  minus the hand-driving.
- **Phase 2:** generalize decompose/verify/iterate to any datastore-mutating build; verification
  contracts become a reusable pattern.
- **Phase 3:** fuller hands-off autonomy with only a final human review.

## Risks / open questions
- **CEO turn budget:** orchestrating ~15 chunks + verifications = many CEO turns. Confirm the CEO's
  `maxTurnsPerRun` / cost budget has headroom (or the CEO checkpoints state to the issue and resumes).
- **Cost/GPU:** a full autonomous build is many doer + QA runs. Bound it; make cost visible.
- **Delegation mechanism:** confirm exactly how the CEO dispatches to doers in Paperclip (subtask
  issues vs. comments vs. the engine's delegate path) and wire the ledger to it.
- **Contract brittleness:** the verification checklists must catch real gaps without false-flagging.

## Definition of done for THIS playbook
A Paperclip issue "plan/modify trip X" runs the loop end-to-end, produces a structurally-complete
TREK trip, and the CEO's final summary matches an independent datastore verification (no claim/evidence
drift) — reproducing the Tuscany result without a human hand-driving the chunks.

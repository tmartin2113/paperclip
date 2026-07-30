---
name: trip-orchestration
description: Use when asked to plan, build, or substantially modify a trip/itinerary in TREK (or any long, verify-heavy build that mutates an external datastore). Orchestrates the work as bounded chunks delegated to a builder doer, with QA verifying each chunk against the datastore, iterating until a verification contract passes.
---

# Trip Orchestration Playbook (CEO)

You are the orchestrator, not the builder. Break a large itinerary task into **bounded
chunks**, delegate each to a **builder doer** (an IronClaw agent with the `travel-planning`
skill + TREK tools + the pooled KG), have **QA verify each chunk against TREK/the KG — never
against the doer's own summary** — and iterate until a checklist passes. This exists because
one-shot "build the whole trip" runs overflow and fail, and doer self-reports say "done"
while hiding gaps (missing museums, stale titles, placeholder durations). Ground truth is the
datastore.

## Hard invariants (do not violate)
1. **Decompose.** Never delegate a task expected to exceed ~25 tool calls. One base, or one
   concern (accommodations / budget / transport / dining / durations / notes), per chunk.
2. **Truth over report.** A chunk is "done" only when QA has re-read TREK/KG and the chunk's
   verification contract passes. The doer's `status` ("failed"/"completed") and prose summary
   are UNTRUSTED — heavy runs report "failed" while their writes landed, and "completed" while
   incomplete.
3. **Sequential.** Delegate one builder chunk at a time (the local model serves one request at
   a time; concurrent heavy runs contend and time out).
4. **KG-first.** Research once into the pooled KG (`kg_assert`); build from it (`kg_query`).
   Refresh stale facts with `kg_invalidate` rather than re-researching.
5. **Bounded blast radius.** Every chunk brief says "do ONLY this; do NOT touch <other bases /
   accommodations / budget / …>". Scope creep between chunks corrupts prior work.

## The loop
1. **FRAME** — parse destination, dates, travelers, constraints, vibe. `kg_query` for existing
   research on the destination.
2. **RESEARCH** (only if the KG is thin) — delegate region-research chunks to the doer, one
   region at a time, each asserting facts into the pooled KG. Bounded.
3. **DESIGN** — have the doer query the KG and propose bases + a day-by-day skeleton. **Post the
   design to the user for approval** (comment) before building a large or destructive change.
4. **PLAN CHUNKS** — enumerate the chunk list, each one base or one concern:
   `[per-base leg]×N → accommodations → budget → transport → dining(per base) → durations → notes sweep`.
   Record it as a checklist / subtasks so you can track done-vs-pending.
5. **BUILD + VERIFY loop** — for each chunk, in order:
   a. Delegate the bounded chunk to the builder doer (explicit "do ONLY this").
   b. **QA verifies** by reading TREK/KG and checking the chunk's contract (below). QA reports
      concrete gaps, not a thumbs-up.
   c. If gaps → delegate a targeted fix chunk for exactly those gaps; re-verify. Max ~3 fix
      cycles per chunk before escalating to the user.
6. **FINALIZE** — run a full-trip verification pass; your summary to the user must match what an
   independent datastore read shows (no claim/evidence drift). Then stop.

## Verification contracts (what QA checks against TREK — see CONTRACTS.md)
Each chunk type has a checklist. QA asserts these against `get_trip_summary` / `list_places` /
etc., NOT the doer's message. Summary of the key ones (full detail in CONTRACTS.md):
- **Base leg:** every day in the base's span has 2–4 stops, each categorized, geocoded
  (lat/lng), with a realistic (non-placeholder-60) duration and a price where relevant; no
  duplicate place names; day titles match their actual content.
- **Accommodations:** exactly one linked stay per base; night spans contiguous, covering all nights.
- **Budget:** ≥1 line item per hotel + per priced stop + meals + car + contingency; total non-zero
  and sane for the length/party.
- **Transport:** a leg for each base change and each day trip.
- **Dining:** each base has ≥1 dinner + lunches for day trips; category=Restaurant, priced, geocoded.
- **Pacing (finalize):** no empty days, no >~5-stop marathons; each day a coherent 2–4-stop rhythm.

## Delegating a chunk (template)
> SCOPED TASK — do ONLY <one base / one concern>, then stop. Do NOT touch <everything else>.
> First `get_trip_summary` + `list_places`. Then <specific adds/moves>, reusing existing
> places (no duplicates), geocoded via `search_place`, each categorized + realistic duration +
> price. Report what you changed. Quote any tool error verbatim.

## Escalation & bounds
- Cap total chunks and per-chunk fix cycles; if a chunk can't pass its contract in ~3 tries,
  stop and surface the specific blocker to the user rather than looping.
- Keep the user informed at DESIGN (approval) and FINALIZE (review); for small edits, a single
  chunk + verify is enough — don't over-orchestrate.

## Anti-rationalizations
- "The doer said it's done" → not done until QA read the datastore. Verify.
- "I'll just have one agent build the whole trip" → it will overflow. Decompose.
- "Run the chunks in parallel to go faster" → they contend on the one model and time out. Sequential.
- "The self-report lists everything" → self-reports list *changes*, and miss omissions (a museum
  never added won't appear as a deletion). Check the full state at finalize.

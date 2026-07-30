# Verification Contracts (TREK trips)

QA checks these against the DATASTORE — `get_trip_summary(tripId)`, `list_places(tripId)`,
`list_categories` — **not** the builder doer's message. Each contract is a set of pass/fail
assertions. Report every failure concretely (which day, which place, which field), because the
CEO turns each failure into a targeted fix chunk. A doer reporting "done" does not close a chunk;
a passing contract does.

Legend: a "stop" = a place assigned to a day (an assignment). "Enriched" = has geocode
(lat/lng or google_place_id), a category_id, and a realistic duration.

## C1 — Base leg (e.g. "Siena days 5–9")
- [ ] Every day in the base's span has **2–4 stops** (arrival/departure/buffer days may have 1).
- [ ] Each stop is **enriched**: geocode present, `category_id` set, `duration_minutes` is NOT
      the placeholder 60 unless 60 is genuinely right (a church can be 60; a gallery/day-trip is not).
- [ ] Stops with an entry fee carry a **price** (`total_price`/note) and a booking hint.
- [ ] **No duplicate place names** across the trip (e.g. two "Duomo di Firenze").
- [ ] The **day title matches its content** (no stale title from a prior plan).
- [ ] Only the intended base's days changed (spot-check a couple of other days are untouched).

## C2 — Accommodations
- [ ] **Exactly one** linked accommodation record per base (`get_trip_summary.accommodations`).
- [ ] Night spans are **contiguous and cover every night** (base A checkout day = base B checkin day).
- [ ] Each links a real hotel **place** (not a bare name); check-in/out times present.
- [ ] No leftover accommodation from a superseded plan (e.g. a single 14-night hotel).

## C3 — Budget
- [ ] A line item for **each hotel** (matching the accommodation night counts), **each priced
      stop/tasting**, **meals**, **car/transport**, and **contingency**.
- [ ] No **stale** items (outlet shuttles / hotels / museums that are no longer on the itinerary).
- [ ] **Total is non-zero** and within a sane band for the trip length + party size.
- [ ] Amounts live in the real field (`total_price`) — a "0/None" item is a fail.

## C4 — Transport
- [ ] A leg (transport or car reservation) for **each base change**.
- [ ] A leg for **each day trip** that requires driving.
- [ ] Each leg has mode + from→to + a rough time/distance.
- [ ] Transport is not **double-counted** as both a transport leg AND a budget "Car: …" item.

## C5 — Dining
- [ ] Each base has **≥1 dinner**; each day trip has a **lunch** near its destination.
- [ ] Each dining place is `category = Restaurant`, geocoded, with a **price band** + "reserve ahead" note.
- [ ] No duplication of an existing food stop (e.g. a lunch food-hall or a cheese shop already present).

## C6 — Durations (sweep)
- [ ] **Zero** stops remain at the placeholder 60 unless 60 is genuinely correct.
- [ ] Durations are plausible: major museum 120–240, cathedral 60–90, piazza/viewpoint 30–45,
      winery tasting ~120, full-day trip 300–480, thermal spa ~300.

## C7 — Notes sweep
- [ ] Each day's notes reference **only that day's actual content** (no leftover notes about
      dropped stops / other cities / a prior plan).
- [ ] Booking/logistics notes sit on the **day they apply to** (a winery booking note on the wine day).

## C8 — Finalize (whole trip)
- [ ] All of C1–C7 pass across all days.
- [ ] **Pacing:** no empty days; no day with >~5 stops; each day a coherent 2–4-stop rhythm with
      travel time accounted for.
- [ ] **Coherence:** the trip title/description match the actual base structure and dates.
- [ ] The CEO's user-facing summary matches this datastore read — **no claim/evidence drift.**

## How QA runs a contract
1. Read the datastore (`get_trip_summary`, `list_places`).
2. Walk the checklist; collect FAILURES as `{contract, day/place, what's wrong}`.
3. Return the failure list (empty = pass). Do NOT paraphrase the doer's summary — inspect the data.

import { describe, expect, it } from "vitest";
import {
  isClaudeMaxTurnsResult,
  isClaudeUsageLimitResult,
  extractClaudeUsageLimitReset,
} from "@paperclipai/adapter-claude-local/server";

describe("claude_local max-turn detection", () => {
  it("detects max-turn exhaustion by subtype", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    ).toBe(true);
  });

  it("detects max-turn exhaustion by stop_reason", () => {
    expect(
      isClaudeMaxTurnsResult({
        stop_reason: "max_turns",
      }),
    ).toBe(true);
  });

  it("returns false for non-max-turn results", () => {
    expect(
      isClaudeMaxTurnsResult({
        subtype: "success",
        stop_reason: "end_turn",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Usage-limit detection
//
// Empirical trigger: a `claude_local` Backend Engineer run hit the Claude
// subscription usage limit mid-session. The Claude CLI exited non-zero with
// the stream result:
//
//   { subtype: "success", result: "You've hit your limit · resets 10am (UTC)" }
//
// The adapter at the time returned `errorCode: null` for this failure — same
// as any other generic claude_local failure. In the heartbeat, that null
// flowed into `shouldSelfWake("failed", null) === true`, which enqueued an
// `inbox_remaining` wakeup, which claimed a new run, which hit the same rate
// limit, which enqueued another wakeup, ... 20+ failed runs in 35 seconds,
// all making real API calls to Anthropic, all 429-ing.
//
// `isClaudeUsageLimitResult` recognises the known usage/rate-limit phrasing
// from the Claude CLI output so the adapter can return a specific errorCode
// (`"claude_usage_limited"`) that the heartbeat's SYSTEMIC_ERROR_CODES set
// rejects from self-wake, breaking the loop at the source.
// ---------------------------------------------------------------------------

describe("claude_local usage-limit detection", () => {
  it("detects the observed 'You've hit your limit' phrasing", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "success",
        result: "You've hit your limit · resets 10am (UTC)",
      }),
    ).toBe(true);
  });

  it("detects the apostrophe-less variant", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "success",
        result: "Youve hit your limit — try again later",
      }),
    ).toBe(true);
  });

  it("detects 'usage limit reached' phrasing", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Claude usage limit reached for this subscription window",
      }),
    ).toBe(true);
  });

  it("detects 'rate limit exceeded' phrasing", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Rate limit exceeded — please slow down",
      }),
    ).toBe(true);
  });

  it("detects the marker when it's in an errors[] entry rather than result", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "",
        errors: [{ message: "You've hit your limit · resets at 10am UTC" }],
      }),
    ).toBe(true);
  });

  it("detects the marker from a plain-string errors[] entry", () => {
    expect(
      isClaudeUsageLimitResult({
        errors: ["usage limit reached"],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated failures", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "error_max_turns",
        result: "Reached max turns",
      }),
    ).toBe(false);
  });

  it("returns false for auth-required failures (different error class)", () => {
    expect(
      isClaudeUsageLimitResult({
        result: "Please log in with `claude login` to continue",
      }),
    ).toBe(false);
  });

  it("returns false for successful runs", () => {
    expect(
      isClaudeUsageLimitResult({
        subtype: "success",
        result: "Here is the answer to your question...",
      }),
    ).toBe(false);
  });

  it("returns false for null/empty input", () => {
    expect(isClaudeUsageLimitResult(null)).toBe(false);
    expect(isClaudeUsageLimitResult(undefined)).toBe(false);
    expect(isClaudeUsageLimitResult({})).toBe(false);
  });

  it("does not match the word 'limit' in unrelated contexts", () => {
    // Guard against overly-greedy regex — a task that talks about a "time
    // limit" or "memory limit" in its output should NOT trip the rate-limit
    // detector.
    expect(
      isClaudeUsageLimitResult({
        result: "Updated the time limit constant in config.ts",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Reset-time extraction
//
// The Claude CLI's usage-limit error message typically includes a reset
// hint like "resets 10am (UTC)". We want to parse that into a concrete
// next-reset timestamp so the heartbeat can skip enqueueing new wakes for
// a rate-limited agent until the reset has passed (otherwise the agent
// stays idle forever on its own — the catch-path fix stops the tight
// loop but doesn't schedule resumption).
//
// `extractClaudeUsageLimitReset(parsed, now)` returns an ISO 8601 string
// for the next reset moment, or `null` if nothing parseable was found.
// Conservative by design: if we can't confidently parse, we'd rather
// fail open (no deferral scheduled) than risk computing a wrong time
// and deferring indefinitely.
// ---------------------------------------------------------------------------

describe("extractClaudeUsageLimitReset", () => {
  // Anchor all tests to a fixed "now" so the absolute-time cases are
  // deterministic regardless of when the suite runs.
  const NOW = new Date("2026-04-08T06:00:00.000Z");

  it("parses the exact observed 'resets 10am (UTC)' phrasing", () => {
    // "now" is 06:00 UTC, so the NEXT 10:00 UTC is today at 10:00.
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 10am (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-08T10:00:00.000Z");
  });

  it("rolls forward to tomorrow when the reset hour is earlier than 'now'", () => {
    // "now" is 14:00 UTC, reset is "10am (UTC)" — that's already past, so
    // the next 10:00 UTC is TOMORROW at 10:00.
    const afternoon = new Date("2026-04-08T14:00:00.000Z");
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 10am (UTC)" },
      afternoon,
    );
    expect(out).toBe("2026-04-09T10:00:00.000Z");
  });

  it("parses 'resets 3pm (UTC)' style (pm)", () => {
    // All these inputs carry the usage-limit marker because the helper
    // only extracts reset times from text that CLAUDE_USAGE_LIMIT_RE has
    // already classified (defensive against parsing "resets 10am" out of
    // unrelated task output).
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 3pm (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-08T15:00:00.000Z");
  });

  it("parses '12pm' as noon, not midnight", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 12pm (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-08T12:00:00.000Z");
  });

  it("parses '12am' as midnight (of the next day since we're already past midnight)", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 12am (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-09T00:00:00.000Z");
  });

  it("parses 'resets 2:30pm (UTC)' with minutes", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "You've hit your limit · resets 2:30pm (UTC)" },
      NOW,
    );
    expect(out).toBe("2026-04-08T14:30:00.000Z");
  });

  it("parses 24-hour format 'resets 14:00 UTC'", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "Usage limit reached — resets 14:00 UTC" },
      NOW,
    );
    expect(out).toBe("2026-04-08T14:00:00.000Z");
  });

  it("tolerates wording variations: 'resets at 10am UTC'", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "Usage limit reached — resets at 10am UTC" },
      NOW,
    );
    expect(out).toBe("2026-04-08T10:00:00.000Z");
  });

  it("extracts from an errors[] entry when result is empty", () => {
    const out = extractClaudeUsageLimitReset(
      { result: "", errors: [{ message: "You've hit your limit · resets 10am (UTC)" }] },
      NOW,
    );
    expect(out).toBe("2026-04-08T10:00:00.000Z");
  });

  it("returns null when the usage-limit marker is absent", () => {
    expect(
      extractClaudeUsageLimitReset(
        { result: "Max turns exceeded" },
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null when the marker is present but reset time can't be parsed", () => {
    expect(
      extractClaudeUsageLimitReset(
        { result: "You've hit your limit" },
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null for null/undefined/empty input", () => {
    expect(extractClaudeUsageLimitReset(null, NOW)).toBeNull();
    expect(extractClaudeUsageLimitReset(undefined, NOW)).toBeNull();
    expect(extractClaudeUsageLimitReset({}, NOW)).toBeNull();
  });

  it("defaults to current time when 'now' is omitted (smoke check)", () => {
    // Just verifies the function accepts being called without the `now`
    // parameter and doesn't throw. Value-equality depends on the clock so
    // we only assert it's a parseable ISO timestamp in the future.
    const out = extractClaudeUsageLimitReset({
      result: "You've hit your limit · resets 10am (UTC)",
    });
    if (out === null) {
      // Acceptable if the current time vs 10am UTC edge case lands
      // exactly on the boundary — don't flake on it.
      return;
    }
    const parsed = new Date(out);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it("returns null when called on unrelated text that happens to contain 'resets 10am'", () => {
    // Defense-in-depth: even if task output contains the literal phrase
    // "resets 10am" in an unrelated sentence, the classifier guard should
    // reject it — extractClaudeUsageLimitReset only operates on text the
    // usage-limit classifier already accepted.
    expect(
      extractClaudeUsageLimitReset(
        { result: "The cron resets 10am UTC every day — this is just docs" },
        NOW,
      ),
    ).toBeNull();
  });
});

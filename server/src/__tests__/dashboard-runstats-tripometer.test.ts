/**
 * Failing test for dashboardService.runStats tripometer shape.
 *
 * These tests pin the NEW response shape:
 *   { lifetime: { totalRuns, succeededRuns, failedRuns, ... },
 *     sinceReset: { ... } | null,
 *     resetAt: string | null }
 *
 * They will fail until Task 4 implements the new shape in dashboard.ts.
 *
 * No real DB is required — a minimal mock db is used. Because the current
 * implementation returns a flat shape (no `lifetime` / `sinceReset` keys),
 * all assertions will fail at the shape level, not at the setup level.
 */
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { dashboardService } from "../services/dashboard.js";

// ---------------------------------------------------------------------------
// Minimal drizzle-compatible mock builder
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

/**
 * Builds a fake drizzle query chain.
 *
 * Usage:
 *   const db = buildMockDb([row1, row2], companyRow);
 *
 * The mock intercepts `.select().from().where()` chains and either:
 *   - returns the company row (when the table name contains "companies")
 *   - returns heartbeat_runs rows (all other selects)
 *
 * To support the Task 4 implementation (which will add a company lookup and
 * potentially two heartbeat_runs queries), each call to `.select()` pops the
 * next batch from `resultQueue`.
 */
function buildMockDb(
  resultQueue: AnyRecord[][],
): Pick<Db, "select" | "update"> {
  let callIndex = 0;

  function makeChain(rows: AnyRecord[]): unknown {
    const chain: AnyRecord = {};
    const terminal = Promise.resolve(rows);

    // Attach all common builder methods — each returns the same chain.
    for (const method of ["from", "where", "leftJoin", "orderBy", "limit", "groupBy", "innerJoin"]) {
      chain[method] = (..._args: unknown[]) => chain;
    }

    // Make it awaitable so `const [row] = await db.select(...).from(...).where(...)` works.
    chain.then = terminal.then.bind(terminal);
    chain.catch = terminal.catch.bind(terminal);
    chain.finally = terminal.finally.bind(terminal);

    return chain;
  }

  const updateChain: AnyRecord = {};
  for (const method of ["set", "where"]) {
    updateChain[method] = (..._args: unknown[]) => updateChain;
  }
  updateChain.then = Promise.resolve([]).then.bind(Promise.resolve([]));
  updateChain.catch = Promise.resolve([]).catch.bind(Promise.resolve([]));
  updateChain.finally = Promise.resolve([]).finally.bind(Promise.resolve([]));

  return {
    select: (_fields?: unknown) => {
      const batch = resultQueue[callIndex] ?? [];
      callIndex++;
      return makeChain(batch) as ReturnType<Db["select"]>;
    },
    update: (_table?: unknown) => {
      return updateChain as ReturnType<Db["update"]>;
    },
  } as unknown as Pick<Db, "select" | "update">;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dashboardService.runStats — tripometer behavior", () => {
  const companyId = "00000000-0000-0000-0000-000000000001";

  it("returns lifetime stats and sinceReset === null when runStatsResetAt is null", async () => {
    // Queue: [0] = company row (no resetAt), [1] = lifetime heartbeat_runs aggregate
    const db = buildMockDb([
      // company row
      [{ id: companyId, runStatsResetAt: null }],
      // lifetime aggregate rows
      [{ totalRuns: 2, succeededRuns: 1, failedRuns: 1, avgDurationMs: 1000, avgInputTokens: null, avgOutputTokens: null }],
    ]);

    const svc = dashboardService(db as unknown as Db);
    const stats = await svc.runStats(companyId);

    // These assertions intentionally target the NEW shape.
    // Currently fails because the current impl returns a flat object.
    expect(stats.lifetime.totalRuns).toBe(2);
    expect(stats.lifetime.succeededRuns).toBe(1);
    expect(stats.lifetime.failedRuns).toBe(1);
    expect(stats.sinceReset).toBeNull();
    expect(stats.resetAt).toBeNull();
  });

  it("returns both blocks when runStatsResetAt is set, with sinceReset filtered to runs after reset", async () => {
    const now = Date.now();
    const resetAt = new Date(now - 12 * 60 * 60 * 1000); // 12 hours ago

    const db = buildMockDb([
      // company row with resetAt
      [{ id: companyId, runStatsResetAt: resetAt }],
      // lifetime aggregate (3 total runs: 1 before + 2 after reset)
      [{ totalRuns: 3, succeededRuns: 2, failedRuns: 1, avgDurationMs: null, avgInputTokens: null, avgOutputTokens: null }],
      // sinceReset aggregate (2 runs after reset: 1 succeeded, 1 failed)
      [{ totalRuns: 2, succeededRuns: 1, failedRuns: 1, avgDurationMs: null, avgInputTokens: null, avgOutputTokens: null }],
    ]);

    const svc = dashboardService(db as unknown as Db);
    const stats = await svc.runStats(companyId);

    expect(stats.lifetime.totalRuns).toBe(3);
    expect(stats.sinceReset).not.toBeNull();
    expect(stats.sinceReset!.totalRuns).toBe(2);
    expect(stats.sinceReset!.succeededRuns).toBe(1);
    expect(stats.sinceReset!.failedRuns).toBe(1);
    expect(stats.resetAt).toEqual(resetAt.toISOString());
  });

  it("returns sinceReset zeros when runStatsResetAt is in the future (defensive)", async () => {
    const now = Date.now();
    const futureResetAt = new Date(now + 60 * 60 * 1000); // 1 hour in the future

    const db = buildMockDb([
      // company row with future resetAt
      [{ id: companyId, runStatsResetAt: futureResetAt }],
      // lifetime aggregate (1 run)
      [{ totalRuns: 1, succeededRuns: 1, failedRuns: 0, avgDurationMs: null, avgInputTokens: null, avgOutputTokens: null }],
      // sinceReset aggregate — 0 runs because reset is in the future
      [{ totalRuns: 0, succeededRuns: 0, failedRuns: 0, avgDurationMs: null, avgInputTokens: null, avgOutputTokens: null }],
    ]);

    const svc = dashboardService(db as unknown as Db);
    const stats = await svc.runStats(companyId);

    expect(stats.lifetime.totalRuns).toBe(1);
    expect(stats.sinceReset).not.toBeNull();
    expect(stats.sinceReset!.totalRuns).toBe(0);
  });
});

/**
 * Failing tests for heartbeatService.getRuntimeState baseline columns + resetRuntimeStateTokens.
 *
 * These tests pin the NEW behavior:
 *   - getRuntimeState returns tokensResetAt + four *Baseline columns (Task 9)
 *   - resetRuntimeStateTokens(agentId) snapshots current totals into baselines (Task 10)
 *   - resetRuntimeStateTokens(agentId, true) zeros baselines and nulls tokensResetAt (Task 10)
 *
 * They will fail until Tasks 9 & 10 implement the new behaviour.
 *
 * No real DB is required — a minimal mock db is used (same pattern as
 * dashboard-runstats-tripometer.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";

// ---------------------------------------------------------------------------
// Minimal drizzle-compatible mock builder
// (copied verbatim from dashboard-runstats-tripometer.test.ts, then extended
//  with a .transaction() stub so Task 10's db.transaction(async tx => ...)
//  call is handled correctly — the stub simply calls the callback with the
//  mock db itself as the transaction object.)
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

/**
 * Builds a fake drizzle query chain backed by a FIFO result queue.
 *
 * Usage:
 *   const mock = buildMockDb([firstSelectRows, secondSelectRows, ...]);
 *
 * Each call to `.select()` pops the next batch of rows from `resultQueue`,
 * regardless of which table or columns are being queried. Tests push result
 * batches in the exact order the service will issue its SELECT calls. This
 * lets a single mock handle any number of queries without any table-name
 * inspection.
 *
 * Extension vs dashboard version: `.transaction()` is stubbed so that
 * Task 10's `db.transaction(async tx => { ... })` pattern works — the
 * callback receives the mock db itself as `tx`.
 */
type MockDb = {
  db: Pick<Db, "select" | "update" | "transaction">;
  setCalls: AnyRecord[];
};

function buildMockDb(
  resultQueue: AnyRecord[][],
): MockDb {
  let callIndex = 0;
  const setCalls: AnyRecord[] = [];

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

  function makeUpdateChain(): AnyRecord {
    const terminal = Promise.resolve([]);
    const chain: AnyRecord = {};
    chain["set"] = (values: AnyRecord) => {
      setCalls.push(values);
      return makeUpdateChain();
    };
    chain["where"] = (..._args: unknown[]) => makeUpdateChain();
    chain.then = terminal.then.bind(terminal);
    chain.catch = terminal.catch.bind(terminal);
    chain.finally = terminal.finally.bind(terminal);
    return chain;
  }

  const db: Pick<Db, "select" | "update" | "transaction"> = {
    select: (_fields?: unknown) => {
      const batch = resultQueue[callIndex] ?? [];
      callIndex++;
      return makeChain(batch) as ReturnType<Db["select"]>;
    },
    update: (_table?: unknown) => {
      return makeUpdateChain() as ReturnType<Db["update"]>;
    },
    // Extension: transaction stub passes mock db as the tx argument so
    // Task 10's db.transaction(async tx => { ... tx.select() ... tx.update() }) works.
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      return callback(db);
    },
  } as unknown as Pick<Db, "select" | "update" | "transaction">;

  return { db, setCalls };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const agentIdFixture = "00000000-0000-0000-0000-000000000001";
const companyIdFixture = "00000000-0000-0000-0000-000000000002";

// A minimal agents-table row sufficient to satisfy heartbeatService internals.
const agentRowFixture = {
  id: agentIdFixture,
  companyId: companyIdFixture,
  adapterType: "claude_local",
  name: "Test Agent",
  role: "general",
  status: "idle",
  title: null,
  capabilities: [],
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: null,
  metadata: {},
  permissions: {},
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("heartbeatService runtime-state with token baselines", () => {
  it("getRuntimeState returns baseline columns and tokensResetAt as null when never reset", async () => {
    // Queue: [0] = agentRuntimeState row (private getRuntimeState call),
    //        [1] = agents row (getAgent call),
    //        [2] = agentTaskSessions row (latestTaskSession call)
    const runtimeStateRow = {
      agentId: agentIdFixture,
      companyId: companyIdFixture,
      adapterType: "claude_local",
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalCachedInputTokens: 100,
      totalCostCents: 250,
      tokensResetAt: null,
      totalInputTokensBaseline: 0,
      totalOutputTokensBaseline: 0,
      totalCachedInputTokensBaseline: 0,
      totalCostCentsBaseline: 0,
      sessionId: null,
      stateJson: {},
      lastError: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    };
    const mock = buildMockDb([
      [runtimeStateRow],       // getRuntimeState(agentId)
      [agentRowFixture],       // getAgent(agentId)
      [],                      // agentTaskSessions (none)
    ]);
    const svc = heartbeatService(mock.db as unknown as Db);
    const state = await svc.getRuntimeState(agentIdFixture);

    expect(state).not.toBeNull();
    expect(state!.tokensResetAt).toBeNull();
    expect(state!.totalInputTokensBaseline).toBe(0);
    expect(state!.totalOutputTokensBaseline).toBe(0);
    expect(state!.totalCachedInputTokensBaseline).toBe(0);
    expect(state!.totalCostCentsBaseline).toBe(0);
  });

  it("resetRuntimeStateTokens snapshots all four totals into baselines and sets tokensResetAt", async () => {
    // Task 10 will: SELECT current totals, then UPDATE with baselines = those totals.
    // Queue: [0] = agentRuntimeState row with current totals for the snapshot select.
    // (The update is captured via setCalls — no queue entry needed for it.)
    const mock = buildMockDb([
      [
        {
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          totalCachedInputTokens: 100,
          totalCostCents: 250,
        },
      ],
    ]);
    const svc = heartbeatService(mock.db as unknown as Db);
    const before = Date.now();
    await svc.resetRuntimeStateTokens(agentIdFixture);
    const after = Date.now();

    expect(mock.setCalls).toHaveLength(1);
    const call = mock.setCalls[0]!;
    expect(call.tokensResetAt).toBeInstanceOf(Date);
    const ts = (call.tokensResetAt as Date).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(call.totalInputTokensBaseline).toBe(1000);
    expect(call.totalOutputTokensBaseline).toBe(500);
    expect(call.totalCachedInputTokensBaseline).toBe(100);
    expect(call.totalCostCentsBaseline).toBe(250);
  });

  it("resetRuntimeStateTokens with clear: true zeros baselines and nulls tokensResetAt", async () => {
    // The clear path does no selects — it directly writes zeros.
    const mock = buildMockDb([]);
    const svc = heartbeatService(mock.db as unknown as Db);
    await svc.resetRuntimeStateTokens(agentIdFixture, true);

    expect(mock.setCalls).toHaveLength(1);
    const call = mock.setCalls[0]!;
    expect(call.tokensResetAt).toBeNull();
    expect(call.totalInputTokensBaseline).toBe(0);
    expect(call.totalOutputTokensBaseline).toBe(0);
    expect(call.totalCachedInputTokensBaseline).toBe(0);
    expect(call.totalCostCentsBaseline).toBe(0);
  });
});

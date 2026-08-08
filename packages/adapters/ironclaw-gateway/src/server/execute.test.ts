import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

// Build an SSE ReadableStream from Responses-API events, mirroring what the
// IronClaw gateway streams back: each event is a `data: <json>` frame separated
// by a blank line, terminated by a `[DONE]` sentinel.
function sseStream(
  events: Array<Record<string, unknown>>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

function mockGatewayStream(events: Array<Record<string, unknown>>) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    body: sseStream(events),
    headers: { get: () => null },
    text: async () => "",
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// A completed function (tool) call event — the shape the guard counts.
const TOOL_CALL_EVENT = {
  type: "response.output_item.done",
  item: {
    type: "function_call",
    name: "trek_assign_place_to_day",
    arguments: '{"placeId":108,"dayId":34}',
  },
};
// A text delta + a clean completion — output, but zero tool calls.
const TEXT_ONLY_EVENTS = [
  { type: "response.output_text.delta", delta: "I'll assign them to day 34." },
  { type: "response.completed", response: { id: "resp_1" } },
];

function createContext(
  taskMarkdown: string,
): AdapterExecutionContext & {
  logs: Array<{ stream: "stdout" | "stderr"; chunk: string }>;
} {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  const base = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "IronClaw (Researcher)",
      adapterType: "ironclaw_gateway",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      url: "http://gateway.test:3001",
      token: "test-token",
    },
    context: {
      taskId: "issue-1",
      issueId: "issue-1",
      wakeReason: "issue_commented",
      paperclipTaskMarkdown: taskMarkdown,
    },
    authToken: "paperclip-run-jwt",
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push({ stream, chunk });
    },
    onEvent: async () => {},
  } as unknown as AdapterExecutionContext;
  return Object.assign(base, { logs });
}

describe("ironclaw_gateway execute — zero-tool-call write safety net", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("FAILS a write-briefed run that produced text but zero tool calls", async () => {
    mockGatewayStream(TEXT_ONLY_EVENTS);
    const ctx = createContext("Assign places 108 and 171 to day 34.");

    const result = await execute(ctx);

    // The model narrated the write and ended its turn — a phantom success under
    // the old behavior. The guard must convert it to a failure so the delegated
    // issue is retried, not marked done.
    expect(result.exitCode).toBeNull();
    expect(result.errorCode).toBe("ironclaw_gateway_no_tool_calls_on_write");
  });

  it("SUCCEEDS a write-briefed run that actually made a tool call", async () => {
    mockGatewayStream([TEXT_ONLY_EVENTS[0], TOOL_CALL_EVENT, TEXT_ONLY_EVENTS[1]]);
    const ctx = createContext("Assign places 108 and 171 to day 34.");

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeUndefined();
  });

  it("does NOT gate a read/analysis brief with zero tool calls", async () => {
    mockGatewayStream(TEXT_ONLY_EVENTS);
    const ctx = createContext(
      "Summarize the current reservations for the trip and report back.",
    );

    const result = await execute(ctx);

    // No write intent in the brief → the guard must not fire even with zero
    // tool calls; a text-only answer is a legitimate outcome here.
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeUndefined();
  });
});

describe("ironclaw_gateway execute — event-silence watchdog (PRI-193 hang)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts with event_silence when the gateway trickles keep-alives but forwards no event", async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        streamController = c;
      },
    });
    // Mock fetch: hand back the never-closing stream, and wire the caller's abort
    // signal so aborting the run (via the event-silence timer) errors the stream —
    // exactly what aborting a real fetch does to its body.
    const fetchMock = vi.fn(async (_url: string, opts: { signal: AbortSignal }) => {
      opts.signal.addEventListener("abort", () => {
        try {
          streamController?.error(new DOMException("aborted", "AbortError"));
        } catch {
          /* already closed */
        }
      });
      return {
        ok: true,
        status: 200,
        body: stream,
        headers: { get: () => null },
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createContext("Assign places 108 and 171 to day 34.");
    const p = execute(ctx);
    await vi.advanceTimersByTimeAsync(0); // let the read loop reach `reader.read()`

    // Trickle keep-alive frames (no `data:` line → parsed as no event) every 100s.
    // This keeps the 120s raw-byte inactivity timer reset, so ONLY the wider 360s
    // event-silence timer can fire — proving keep-alives no longer mask a hang.
    for (let elapsed = 0; elapsed < 400_000; elapsed += 100_000) {
      streamController?.enqueue(enc.encode(":keep-alive\n\n"));
      await vi.advanceTimersByTimeAsync(100_000);
    }

    const result = await p;
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("ironclaw_gateway_event_silence");
  });
});

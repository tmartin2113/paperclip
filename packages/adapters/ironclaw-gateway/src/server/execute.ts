import { readFile } from "node:fs/promises";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  buildPaperclipEnv,
  joinPromptSections,
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
  renderTemplate,
  selectPaperclipTaskMarkdown,
} from "@paperclipai/adapter-utils/server-utils";

function cfgString(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = config[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function cfgNumber(
  config: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = config[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function toBearer(token: string): string {
  return /^bearer\s+/i.test(token.trim()) ? token.trim() : `Bearer ${token.trim()}`;
}

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into an
 * absolute ISO timestamp, so the heartbeat can defer the next wake precisely
 * until then instead of retrying blindly. Returns null when absent/unparseable.
 */
function parseRetryAfter(header: string | null): string | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) && secs >= 0
      ? new Date(Date.now() + secs * 1000).toISOString()
      : null;
  }
  const asDate = new Date(trimmed);
  return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
}

/**
 * Classify a non-OK gateway HTTP response into Paperclip's error taxonomy so the
 * heartbeat can react appropriately:
 * - 429 (or a body that names a usage/rate/quota limit) → provider_quota, which
 *   triggers reset-aware wake deferral (using Retry-After when given, else a
 *   short default). Relevant when the IronClaw gateway fronts a rate-limited
 *   upstream model.
 * - 5xx/529 → transient_upstream, so the heartbeat retries with backoff.
 * - anything else → no family (a genuine, non-retriable failure).
 */
function classifyGatewayHttpError(
  status: number,
  retryAfter: string | null,
  bodyText: string,
): {
  errorFamily: AdapterExecutionResult["errorFamily"];
  errorCode: string;
  retryNotBefore: string | null;
} {
  const bodyIndicatesQuota =
    /usage\s+limit|rate[\s-]?limit|\bquota\b|too\s+many\s+requests/i.test(
      bodyText,
    );
  if (status === 429 || bodyIndicatesQuota) {
    return {
      errorFamily: "provider_quota",
      errorCode: "ironclaw_gateway_provider_quota",
      // Fall back to a short deferral when the gateway gives no Retry-After.
      retryNotBefore:
        retryAfter ?? new Date(Date.now() + 60_000).toISOString(),
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      errorFamily: "transient_upstream",
      errorCode: `ironclaw_gateway_http_${status}`,
      retryNotBefore: retryAfter,
    };
  }
  return {
    errorFamily: null,
    errorCode: `ironclaw_gateway_http_${status}`,
    retryNotBefore: null,
  };
}

/**
 * Build the Paperclip run context the remote IronClaw agent needs to act on a
 * wake and post its work back: identity (agent/company/run), the API base URL to
 * call, and the wake specifics (which issue, why woken, the steering comment to
 * read). This is what turns SSE-out into a full steering loop — the advisor
 * posts a comment, Paperclip wakes the agent, and these coordinates tell the
 * remote agent where to read that comment and where to reply.
 *
 * PAPERCLIP_API_KEY is intentionally NOT included: the adapter never handles the
 * agent's API credential. For a remote gateway the operator provisions the key
 * on the IronClaw side; Paperclip supplies only the non-secret coordinates here.
 */
function buildPaperclipRunEnv(
  ctx: AdapterExecutionContext,
): Record<string, string> {
  const env: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    PAPERCLIP_RUN_ID: ctx.runId,
  };
  // Remote execution: the agent runs on a different host than the Paperclip
  // server, so a localhost API URL won't resolve. Let the operator override with
  // a network-reachable base (e.g. the Tailscale address of the Paperclip API).
  const apiUrlOverride = cfgString(ctx.config, "paperclipApiUrl");
  if (apiUrlOverride) env.PAPERCLIP_API_URL = apiUrlOverride.replace(/\/+$/, "");

  const wake = normalizePaperclipWakePayload(ctx.context.paperclipWake);
  if (wake) {
    if (wake.reason) env.PAPERCLIP_WAKE_REASON = wake.reason;
    if (wake.issue?.id) env.PAPERCLIP_ISSUE_ID = wake.issue.id;
    if (wake.issue?.identifier)
      env.PAPERCLIP_ISSUE_IDENTIFIER = wake.issue.identifier;
    if (wake.latestCommentId)
      env.PAPERCLIP_WAKE_COMMENT_ID = wake.latestCommentId;
    if (wake.interactionKind)
      env.PAPERCLIP_INTERACTION_KIND = wake.interactionKind;
    if (wake.interactionStatus)
      env.PAPERCLIP_INTERACTION_STATUS = wake.interactionStatus;
    if (wake.unresolvedBlockerIssueIds.length > 0)
      env.PAPERCLIP_BLOCKER_ISSUE_IDS =
        wake.unresolvedBlockerIssueIds.join(",");
  }
  return env;
}

/**
 * Render the run env as a delimited context block for the prompt input. The
 * gateway also receives it as request `metadata`, but embedding it in the input
 * guarantees the agent sees its callback coordinates even if a gateway drops
 * unknown metadata.
 */
function renderPaperclipEnvBlock(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  return [
    "## Paperclip run context",
    "",
    "Machine-readable identifiers for this run. Use PAPERCLIP_API_URL as the",
    "Paperclip API base, authenticating with your provisioned PAPERCLIP_API_KEY.",
    "When woken by an advisor, read the steering comment PAPERCLIP_WAKE_COMMENT_ID",
    "on issue PAPERCLIP_ISSUE_ID and post your work back to that issue.",
    "",
    "```",
    ...lines,
    "```",
  ].join("\n");
}

/**
 * Parse an OpenAI-Responses `usage` object (input_tokens / output_tokens /
 * input_tokens_details.cached_tokens) into Paperclip's UsageSummary. Tolerant of
 * camelCase variants some gateways emit. Returns undefined when nothing usable.
 */
function parseResponsesUsage(value: unknown): UsageSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const num = (x: unknown): number =>
    typeof x === "number" && Number.isFinite(x) ? x : 0;
  const inputTokens = num(u.input_tokens ?? u.inputTokens);
  const outputTokens = num(u.output_tokens ?? u.outputTokens);
  const inputDetails =
    u.input_tokens_details && typeof u.input_tokens_details === "object"
      ? (u.input_tokens_details as Record<string, unknown>)
      : {};
  const cachedInputTokens = num(
    inputDetails.cached_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens,
  );
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function failure(
  code: string,
  message: string,
): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: message,
    errorCode: code,
  };
}

/**
 * Run a remote IronClaw agent over HTTP POST /v1/responses + SSE (the OpenAI
 * Responses streaming shape). Text deltas are forwarded to `ctx.onLog` and
 * structured Responses events to `ctx.onEvent`. Live steering is delivered
 * out-of-band by the server via the gateway's /hooks/wake control hook, so this
 * execute only owns the outbound run + inbound stream.
 */
export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const url = cfgString(ctx.config, "url");
  const token = cfgString(ctx.config, "token") ?? cfgString(ctx.config, "authToken");
  if (!url) return failure("ironclaw_gateway_url_missing", "url is required");
  if (!token) return failure("ironclaw_gateway_token_missing", "token is required");

  // IronClaw's gateway currently selects its own model and rejects explicit
  // selection, accepting only an omitted model or the sentinel "default". Treat
  // "default" as "omit" so the documented sentinel works, and pass any other
  // value through for gateways that do support selection.
  const rawModel = cfgString(ctx.config, "model");
  const model =
    rawModel && rawModel.toLowerCase() !== "default" ? rawModel : undefined;
  const timeoutSec = cfgNumber(ctx.config, "timeoutSec") ?? 120;

  // Session resume: Paperclip hands back the prior run's response id via
  // ctx.runtime (sessionParams.sessionId is the modern field, sessionId the
  // legacy view). Sending it as previous_response_id continues that thread on
  // the gateway instead of starting a fresh conversation.
  const priorSessionId =
    (typeof ctx.runtime.sessionParams?.sessionId === "string"
      ? ctx.runtime.sessionParams.sessionId
      : "") ||
    (typeof ctx.runtime.sessionId === "string" ? ctx.runtime.sessionId : "");

  // Build the task prompt: instructions file (if any) prepended to the task text
  // carried in run context.
  let instructions = "";
  const instructionsPath = cfgString(ctx.config, "instructionsFilePath");
  if (instructionsPath) {
    try {
      instructions = await readFile(instructionsPath, "utf8");
    } catch (err) {
      await ctx.onLog(
        "stderr",
        `[ironclaw-gateway] could not read instructionsFilePath: ${String(err)}\n`,
      );
    }
  }
  // Paperclip is issue/wake-driven: build the agent brief from the operator's
  // prompt template + the rendered wake payload (which issue, why woken), using
  // the shared renderers so this adapter matches every other one. There is no
  // raw "prompt" field.
  const templateSource =
    cfgString(ctx.config, "promptTemplate") ??
    DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
  const renderedTemplate = renderTemplate(templateSource, { agent: ctx.agent });
  // The task-context markdown is the authoritative issue brief; it uses the
  // compact variant (description stripped) on resume deltas, where the session
  // already saw the full brief. Suppress the wake prompt's own description copy
  // so the issue text rides the prompt exactly once. Previously this lane sent
  // the description up to three times — wake-prose + a full wake-payload JSON
  // dump — which dominated the per-turn token cost (~30K prompts on a 27B).
  const taskContextNote = selectPaperclipTaskMarkdown(ctx.context, {
    resumedSession: Boolean(priorSessionId),
  });
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    resumedSession: Boolean(priorSessionId),
    includeExecutionContract: true,
    suppressIssueDescription: taskContextNote.length > 0,
  });
  // Step 4 — wake-env injection: give the remote agent the coordinates it needs
  // to read the advisor's steering comment and post work back (the callback loop).
  // The structured wake payload rides `metadata` (below), not the prompt input,
  // so gateways that parse structured data still get it without token cost.
  const paperclipEnv = buildPaperclipRunEnv(ctx);
  const envBlock = renderPaperclipEnvBlock(paperclipEnv);
  const input = joinPromptSections([
    instructions,
    renderedTemplate,
    envBlock,
    wakePrompt,
    taskContextNote,
  ]);

  const endpoint = `${url.replace(/\/+$/, "")}/v1/responses`;
  const extraHeaders =
    ctx.config.headers && typeof ctx.config.headers === "object"
      ? (ctx.config.headers as Record<string, string>)
      : {};

  const controller = new AbortController();
  // The run is bounded by INACTIVITY (the watchdog in the read loop aborts if
  // the gateway goes silent), NOT by total wall-clock time. A legitimately long
  // run that keeps producing output — e.g. a large multi-venue write chunk —
  // must not be killed merely for taking a while, which is exactly what a tight
  // `timeoutSec` wall did (it wall-clocked productive runs at 600s). This timer
  // is only a generous absolute backstop against a stream that never ends (a
  // runaway loop); `timeoutSec` now floors that backstop (min 1h), it is not a
  // tight cap. `abortReason` lets the catch block report which guard fired.
  let abortReason: "inactivity" | "event_silence" | "wall" | null = null;
  const wallBackstopSec = Math.max(timeoutSec, 1800);
  // Silence window: the run aborts if the gateway sends NO data (raw bytes) for
  // this long — a truly dead connection. Declared here (not in the read loop) so
  // the catch block can name it. Generous enough to survive a long tool
  // execution between events (a 30s window false-aborted write-heavy runs).
  const inactivitySec = 120;
  // Event-silence window (separate from raw-byte silence): abort if no real SSE
  // EVENT is forwarded for this long even while raw bytes keep arriving. The
  // gateway can trickle keep-alives/partial frames while an agent turn has
  // actually hung without ever emitting a terminal `response.completed` — that is
  // the 41×600s "2 events then hang to the gateway's own ~600s close" failure the
  // stack-check found (PRI-193). The raw-byte timer above never fires there
  // because keep-alives keep resetting it. This window is deliberately WIDE (well
  // above worst-case reasoning-on thinking, observed ~24s) so it cannot re-create
  // the prefill false-aborts that a tight event-timer caused earlier — it only
  // catches a stream that has clearly stalled, well before the ~600s dead-end.
  const eventSilenceSec = 360;
  const timer = setTimeout(() => {
    abortReason = "wall";
    controller.abort();
  }, wallBackstopSec * 1000);

  // Log request details for debugging gateway hangs
  await ctx.onLog(
    "stderr",
    `[ironclaw-gateway] POST ${endpoint} (timeout: ${timeoutSec}s, model: ${model || "omitted"}, previous_response_id: ${priorSessionId || "none"})\n`,
  );

  // Paperclip doer marker (rides x_context.paperclip). Two independent, opt-in
  // per-agent signals share this namespace; the marker is sent only when at
  // least one is configured:
  //   - containedWorkspace=true -> project_id + agent_id: Route B container
  //     containment (fs/shell tools run in a per-project rootless-podman
  //     container, egress denied). For coding/infra doers (Engineer, DevOps).
  //   - reasoning "on"|"off" -> reasoning: per-agent thinking toggle. IronClaw
  //     passes Ollama `think` accordingly; "off" skips qwen3's <think> block so
  //     the local model is FAST for interactive/tool-heavy work. Default doers
  //     to "off"; leave unset for agents that need deep reasoning.
  // IronClaw keys containment on project_id presence, so a reasoning-only marker
  // (no project_id) runs un-contained. The OWUI/Slack assistant uses a different
  // pipe and never emits this key -> keeps containment off AND thinking on.
  const paperclipMarker: Record<string, string> = {};
  if (ctx.config.containedWorkspace === true) {
    paperclipMarker.project_id = ctx.agent.id;
    paperclipMarker.agent_id = ctx.agent.id;
  }
  const reasoning = cfgString(ctx.config, "reasoning");
  if (reasoning === "on" || reasoning === "off") {
    paperclipMarker.reasoning = reasoning;
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: toBearer(token),
        ...extraHeaders,
      },
      body: JSON.stringify({
        ...(model ? { model } : {}),
        ...(priorSessionId ? { previous_response_id: priorSessionId } : {}),
        input,
        stream: true,
        // Paperclip doer marker — see paperclipMarker construction above.
        // Carries up to two OPT-IN per-agent signals: containment
        // (project_id/agent_id, when containedWorkspace=true) and the thinking
        // toggle (reasoning "on"/"off"). Sent only when at least one is set;
        // absent marker => IronClaw runs its normal un-contained, think-on path.
        ...(Object.keys(paperclipMarker).length > 0
          ? { x_context: { paperclip: paperclipMarker } }
          : {}),
        // Structured mirror of the run context; a Responses-compatible gateway
        // that surfaces metadata to the agent can read it without parsing prose.
        metadata: paperclipEnv,
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const cls = classifyGatewayHttpError(res.status, retryAfter, body);
      const errMsg = `[ironclaw-gateway] HTTP ${res.status}: ${body.slice(0, 200)}\n`;
      await ctx.onLog("stderr", errMsg);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `gateway returned ${res.status}: ${body.slice(0, 500)}`,
        errorCode: cls.errorCode,
        ...(cls.errorFamily ? { errorFamily: cls.errorFamily } : {}),
        ...(cls.retryNotBefore ? { retryNotBefore: cls.retryNotBefore } : {}),
      };
    }

    // Log successful HTTP response with streaming indicator
    await ctx.onLog(
      "stderr",
      `[ironclaw-gateway] HTTP 200 OK, beginning SSE stream...\n`,
    );

    // Parse the SSE stream: events are separated by a blank line; each carries
    // one or more `data:` lines whose concatenation is a JSON Responses event.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Step 5 — session-resume + usage telemetry, harvested from the stream: the
    // Responses `response.*` events carry the response id (a resume handle) and,
    // on completion, the token usage.
    let usage: UsageSummary | undefined;
    let sessionId: string | undefined;
    // Count events actually forwarded downstream. A stream that opens, sends
    // nothing usable (only a [DONE] sentinel, or entirely unparseable data) and
    // closes cleanly would otherwise take the success path below and report
    // exitCode 0 with no work done — the "silent success" that makes a hung run
    // indistinguishable from a real one. Zero forwarded events => failure.
    let forwardedCount = 0;
    // Count COMPLETED tool (function) calls to tell a run that actually acted
    // from one that only produced text. A write-briefed run that ends with zero
    // tool calls narrated a change it never executed — the reasoning-light doer
    // failure. Gated by `writeIntent` so read/analysis briefs are unaffected.
    // See the guard after the read loop. Intent is read from the issue brief
    // (`taskContextNote`), NOT the full `input` — the prompt template and env
    // block carry boilerplate verbs ("update the issue…") that would make every
    // run look like a write.
    let toolCallCount = 0;
    const writeIntent = briefRequestsWrite(taskContextNote);

    // Two independent silence watchdogs (either firing aborts the run):
    //  - inactivityTimer: no RAW BYTES for `inactivitySec` → a dead connection.
    //  - eventSilenceTimer: no forwarded EVENT for `eventSilenceSec` even while
    //    raw bytes trickle → a stalled agent turn (keep-alives mask it from the
    //    raw timer). This is the PRI-193 hang the stack-check found. The event
    //    window is much wider than the raw one specifically so a prefill-bound
    //    turn (long thinking before the first token, but well under 360s) is not
    //    false-aborted — the mistake an earlier tight event-timer made.
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const armInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        abortReason = "inactivity";
        controller.abort();
        ctx.onLog(
          "stderr",
          `[ironclaw-gateway] SSE stream inactivity timeout (${inactivitySec}s): no data received from the gateway for the window; the gateway or Ollama is unresponsive.\n`,
        ).catch(() => {});
      }, inactivitySec * 1000);
    };
    let eventSilenceTimer: ReturnType<typeof setTimeout> | undefined;
    const armEventSilence = () => {
      clearTimeout(eventSilenceTimer);
      eventSilenceTimer = setTimeout(() => {
        abortReason = "event_silence";
        controller.abort();
        ctx.onLog(
          "stderr",
          `[ironclaw-gateway] SSE event-silence timeout (${eventSilenceSec}s): the gateway kept the connection alive but forwarded no new event — the agent turn has stalled without terminating the response (it produced output but never emitted response.completed). Failing now instead of hanging to the gateway's ~600s dead-end.\n`,
        ).catch(() => {});
      }, eventSilenceSec * 1000);
    };
    armInactivity();
    armEventSilence();

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      // Reset on ANY inbound data (including SSE keep-alives/partial frames),
      // not just forwarded events. A prefill-bound worker turn is event-silent
      // for a long time before its first token but the connection is not idle;
      // resetting only on forwarded events false-aborted those turns at the
      // window. The "did its work but never terminated the stream" case that
      // motivated event-only reset is now handled at the source — the engine
      // always emits a terminal AppEvent::Response on completion — so this
      // watchdog only needs to catch a truly dead (no bytes at all) stream.
      armInactivity();

      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        const dataStr = dataLines.join("\n");
        if (dataStr === "[DONE]") continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(dataStr) as Record<string, unknown>;
        } catch {
          continue;
        }
        // Harvest resume handle + usage from the Responses envelope before
        // forwarding. Later events win (response.completed carries final usage).
        const responseObj =
          event.response && typeof event.response === "object"
            ? (event.response as Record<string, unknown>)
            : null;
        if (responseObj) {
          if (typeof responseObj.id === "string" && responseObj.id) {
            sessionId = responseObj.id;
          }
          const parsed = parseResponsesUsage(responseObj.usage);
          if (parsed) usage = parsed;
        }
        await forwardEvent(ctx, event);
        forwardedCount += 1;
        armEventSilence(); // real progress — reset the event-silence watchdog
        if (isToolCallCompletion(event)) toolCallCount += 1;
      }
    }

    clearTimeout(inactivityTimer);
    clearTimeout(eventSilenceTimer);

    // The stream closed cleanly but produced nothing to forward. Treat this as a
    // failure (mirroring the timeout branch) rather than a silent success, so a
    // run that did no work is not recorded as exitCode 0. Emit the reason first
    // so the agent can see why.
    if (forwardedCount === 0) {
      const emptyMsg = `[ironclaw-gateway] SSE stream closed after forwarding 0 events: the gateway completed the response stream but produced no usable output. Check gateway logs for Ollama connectivity or a request that returned nothing.\n`;
      await ctx.onLog("stderr", emptyMsg);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: emptyMsg.trim(),
        errorCode: "ironclaw_gateway_empty_stream",
      };
    }

    // Write-briefed but never acted: the brief asked to change data, the stream
    // produced text but ZERO completed tool calls. This is the "narrated a write
    // but never executed it" failure — a reasoning-light doer describing the
    // change and ending its turn, which the CEO could previously only catch via
    // DB forensics. Fail rather than record a phantom success (mirroring the
    // empty-stream guard above) so the delegated issue is retried instead of
    // marked done while nothing was written. Read/analysis briefs
    // (writeIntent=false) are not gated; they legitimately make no tool calls.
    if (writeIntent && toolCallCount === 0) {
      const noToolMsg = `[ironclaw-gateway] run was briefed as a write/change task but made 0 tool calls across ${forwardedCount} forwarded event${forwardedCount === 1 ? "" : "s"} (text-only). The model described the change without executing it; failing the run so it is retried rather than recorded as a phantom success.\n`;
      await ctx.onLog("stderr", noToolMsg);
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorMessage: noToolMsg.trim(),
        errorCode: "ironclaw_gateway_no_tool_calls_on_write",
      };
    }

    await ctx.onLog(
      "stderr",
      `[ironclaw-gateway] SSE stream completed successfully (${forwardedCount} event${forwardedCount === 1 ? "" : "s"} forwarded, ${toolCallCount} tool call${toolCallCount === 1 ? "" : "s"}, ${usage ? "with" : "without"} usage data)\n`,
    );

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      ...(usage ? { usage, usageBasis: "per_run" as const } : {}),
      ...(sessionId
        ? { sessionId, sessionParams: { sessionId }, sessionDisplayId: sessionId }
        : {}),
    };
  } catch (err) {
    if (controller.signal.aborted) {
      // Report which guard fired. inactivity = dead connection (no raw bytes);
      // event_silence = a stalled agent turn (bytes trickle but no new event,
      // never terminated the response — the PRI-193 hang, caught well before the
      // gateway's ~600s dead-end); wall = the absolute backstop. All are failures
      // but mean different things, and a legitimately long-but-productive run no
      // longer trips a tight wall.
      let timedOutMsg: string;
      let timeoutCode: string;
      if (abortReason === "inactivity") {
        timedOutMsg = `[ironclaw-gateway] SSE stream inactivity abort: gateway sent no data for ${inactivitySec}s (accepted the request but stopped streaming). Check gateway logs for Ollama connectivity or a request hang.\n`;
        timeoutCode = "ironclaw_gateway_inactivity";
      } else if (abortReason === "event_silence") {
        timedOutMsg = `[ironclaw-gateway] SSE event-silence abort: gateway kept the connection alive but forwarded no new event for ${eventSilenceSec}s — the agent turn stalled without emitting response.completed. Failing fast instead of hanging to the gateway's ~600s dead-end.\n`;
        timeoutCode = "ironclaw_gateway_event_silence";
      } else {
        timedOutMsg = `[ironclaw-gateway] SSE stream hit the ${wallBackstopSec}s absolute backstop while still streaming — the run never terminated (possible runaway loop).\n`;
        timeoutCode = "ironclaw_gateway_wall_timeout";
      }
      await ctx.onLog("stderr", timedOutMsg);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: timedOutMsg.trim(),
        errorCode: timeoutCode,
      };
    }
    // A transport error (connection refused, DNS, reset) is usually transient —
    // the gateway may be briefly unreachable (e.g. a boot-race between the
    // container and its network). Mark it transient_upstream so the heartbeat
    // retries with backoff rather than hard-failing the run.
    const transportErrMsg = `[ironclaw-gateway] transport error: ${String(err)}\n`;
    await ctx.onLog("stderr", transportErrMsg);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: String(err),
      errorCode: "ironclaw_gateway_transport_error",
      errorFamily: "transient_upstream",
    };
  } finally {
    clearTimeout(timer);
  }
}

// IronClaw file-editing tools → the Visibility editType they map to. Emitting a
// "file.edit" run-event (which the runtime persists to heartbeatRunEvents) is
// what surfaces the edit on Paperclip's Visibility page.
const FILE_TOOL_EDIT_TYPES: Record<string, "create" | "modify" | "delete"> = {
  write_file: "create",
  create_file: "create",
  apply_patch: "modify",
  edit_file: "modify",
  str_replace: "modify",
  str_replace_editor: "modify",
  patch_file: "modify",
  delete_file: "delete",
  remove_file: "delete",
};

function extractFilePath(args: Record<string, unknown>): string {
  for (const k of [
    "path",
    "file_path",
    "filePath",
    "filename",
    "target_file",
    "file",
    "filepath",
  ]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * If the event is a completed file-editing tool call, emit a "file.edit"
 * run-event so the edit appears on Paperclip's Visibility page. Best-effort: the
 * gateway must populate the function_call `arguments` with the target path; if
 * it doesn't, or the tool isn't a file tool, nothing is emitted (the raw event
 * is still forwarded separately).
 */
async function maybeEmitFileEdit(
  ctx: AdapterExecutionContext,
  event: Record<string, unknown>,
): Promise<void> {
  if (!ctx.onEvent) return;
  if (event.type !== "response.output_item.done") return;
  const item =
    event.item && typeof event.item === "object"
      ? (event.item as Record<string, unknown>)
      : null;
  if (!item || item.type !== "function_call") return;
  const name = typeof item.name === "string" ? item.name : "";
  const editType = FILE_TOOL_EDIT_TYPES[name];
  if (!editType) return;

  const rawArgs =
    typeof item.arguments === "string" ? item.arguments.trim() : "";
  let args: Record<string, unknown> = {};
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Not JSON — IronClaw's gateway emits the file path as a bare summary
      // string in `arguments` (its safe param-summary, path only, no content).
    }
  }
  // Prefer a path key from JSON args; else fall back to a bare-path summary.
  const filePath =
    extractFilePath(args) || (rawArgs && !rawArgs.startsWith("{") ? rawArgs : "");
  if (!filePath) return; // no path → can't attribute the edit; skip.

  const content = typeof args.content === "string" ? args.content : "";
  const linesAdded =
    editType === "create" && content ? content.split("\n").length : 0;

  await ctx.onEvent({
    eventType: "file.edit",
    stream: "system",
    payload: {
      filePath,
      editType,
      diff: content ? content.slice(0, 4000) : "",
      linesAdded,
      linesRemoved: 0,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * True when the run's task prompt is an imperative request to CHANGE data
 * (assign, update, create, move, delete, …) rather than answer a question.
 * Gates the "made zero tool calls" safety net below: a write-briefed run that
 * produced only prose and never called a tool narrated a change it never
 * executed — the reasoning-light doer failure this stack hit repeatedly. Pure
 * read/analysis/answer briefs legitimately make zero tool calls and are NOT
 * gated.
 *
 * Deliberately conservative and high-precision — word-boundary match on
 * imperative mutation verbs. A false positive only forces a retry (never data
 * loss); a false negative just preserves the prior behavior. Erring toward
 * matching is the safe direction.
 */
function briefRequestsWrite(input: string): boolean {
  return /\b(assign|reassign|unassign|update|create|write|insert|add|append|move|delete|remove|set|patch|edit|rename|replace|fix|change|modify)\b/i.test(
    input,
  );
}

/**
 * True for the SSE event that marks a COMPLETED tool (function) call. Counted
 * once per call (on the `.done` item, not the incremental argument deltas) to
 * tell a run that actually acted from one that only produced text. Mirrors the
 * function-call discriminator in `maybeEmitFileEdit`.
 */
function isToolCallCompletion(event: Record<string, unknown>): boolean {
  if (event.type !== "response.output_item.done") return false;
  const item =
    event.item && typeof event.item === "object"
      ? (event.item as Record<string, unknown>)
      : null;
  return !!item && item.type === "function_call";
}

/**
 * Map an OpenAI-Responses SSE event onto Paperclip's run callbacks: text deltas
 * to stdout, everything else to a structured runtime event. Completed file-tool
 * calls additionally emit a "file.edit" event for the Visibility page.
 */
async function forwardEvent(
  ctx: AdapterExecutionContext,
  event: Record<string, unknown>,
): Promise<void> {
  const eventType = typeof event.type === "string" ? event.type : "unknown";
  if (eventType === "response.output_text.delta") {
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (delta) await ctx.onLog("stdout", delta);
    return;
  }
  await maybeEmitFileEdit(ctx, event);
  if (ctx.onEvent) {
    await ctx.onEvent({
      eventType,
      stream: "system",
      payload: event,
    });
  }
}

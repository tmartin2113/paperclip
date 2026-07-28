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
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

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
        // Structured mirror of the run context; a Responses-compatible gateway
        // that surfaces metadata to the agent can read it without parsing prose.
        metadata: paperclipEnv,
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      const cls = classifyGatewayHttpError(res.status, retryAfter, body);
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

    // Inactivity timeout: if no data arrives for 30s, the stream is stalled and
    // we should emit an error and abort. This catches hangs where the gateway
    // accepts the request but Ollama is unresponsive.
    const inactivitySec = 30;
    let inactivityTimer = setTimeout(() => {
      controller.abort();
      // Emit diagnostic message before abort takes effect
      ctx.onLog(
        "stderr",
        `[ironclaw-gateway] SSE stream inactivity timeout (${inactivitySec}s): no data received from gateway; Ollama may be unresponsive.\n`,
      ).catch(() => {});
    }, inactivitySec * 1000);

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      // Reset inactivity timer on every read, even if value is empty
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        controller.abort();
        ctx.onLog(
          "stderr",
          `[ironclaw-gateway] SSE stream inactivity timeout (${inactivitySec}s): no data received from gateway; Ollama may be unresponsive.\n`,
        ).catch(() => {});
      }, inactivitySec * 1000);

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
      }
    }

    clearTimeout(inactivityTimer);

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
      // Emit error message before returning so agent sees why run timed out.
      const timedOutMsg = `[ironclaw-gateway] SSE stream timeout after ${timeoutSec}s: gateway accepted request but never completed the response stream. Check gateway logs for Ollama connectivity or request hangs.\n`;
      await ctx.onLog("stderr", timedOutMsg);
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: timedOutMsg.trim(),
        errorCode: "ironclaw_gateway_timeout",
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

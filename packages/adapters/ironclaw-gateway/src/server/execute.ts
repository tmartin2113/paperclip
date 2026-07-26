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
  stringifyPaperclipWakePayload,
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

  const model = cfgString(ctx.config, "model");
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
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    includeExecutionContract: true,
  });
  const wakeJson =
    stringifyPaperclipWakePayload(ctx.context.paperclipWake, {}) ?? "";
  // Step 4 — wake-env injection: give the remote agent the coordinates it needs
  // to read the advisor's steering comment and post work back (the callback loop).
  const paperclipEnv = buildPaperclipRunEnv(ctx);
  const envBlock = renderPaperclipEnvBlock(paperclipEnv);
  const input = joinPromptSections([
    instructions,
    renderedTemplate,
    envBlock,
    wakePrompt,
    wakeJson,
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
      return failure(
        `ironclaw_gateway_http_${res.status}`,
        `gateway returned ${res.status}: ${body.slice(0, 500)}`,
      );
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
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
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
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `run exceeded ${timeoutSec}s`,
        errorCode: "ironclaw_gateway_timeout",
      };
    }
    return failure("ironclaw_gateway_transport_error", String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map an OpenAI-Responses SSE event onto Paperclip's run callbacks: text deltas
 * to stdout, everything else to a structured runtime event.
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
  if (ctx.onEvent) {
    await ctx.onEvent({
      eventType,
      stream: "system",
      payload: event,
    });
  }
}

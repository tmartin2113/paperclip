import { readFile } from "node:fs/promises";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";

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
  const task =
    typeof ctx.context.prompt === "string"
      ? ctx.context.prompt
      : typeof ctx.config.promptTemplate === "string"
        ? ctx.config.promptTemplate
        : "";
  const input = instructions ? `${instructions}\n\n---\n\n${task}` : task;

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
        input,
        stream: true,
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
        await forwardEvent(ctx, event);
      }
    }

    return { exitCode: 0, signal: null, timedOut: false };
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

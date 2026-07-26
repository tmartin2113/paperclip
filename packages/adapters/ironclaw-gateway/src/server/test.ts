import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";

import { type as adapterType } from "../index.js";

function cfgString(config: Record<string, unknown>, key: string): string {
  const v = config[key];
  return typeof v === "string" ? v.trim() : "";
}

function bearer(token: string): string {
  return /^bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const url = cfgString(config, "url");
  const token = cfgString(config, "token") || cfgString(config, "authToken");

  if (!url) {
    checks.push({
      code: "ironclaw_gateway_url_missing",
      level: "error",
      message: "url is required",
    });
  }
  if (!token) {
    checks.push({
      code: "ironclaw_gateway_token_missing",
      level: "error",
      message: "token is required",
    });
  }

  if (url && token) {
    // Authed GET /v1/models is the reliable liveness check for an IronClaw
    // gateway (a 404 on /health just means that path was removed; the server is
    // up). See memory ironclaw-workflow-node.
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/v1/models`, {
        headers: { authorization: bearer(token) },
      });
      if (res.ok) {
        checks.push({
          code: "ironclaw_gateway_reachable",
          level: "info",
          message: `gateway reachable (/v1/models ${res.status})`,
        });
      } else {
        checks.push({
          code: "ironclaw_gateway_unreachable",
          level: "error",
          message: `/v1/models returned ${res.status}`,
        });
      }
    } catch (err) {
      checks.push({
        code: "ironclaw_gateway_unreachable",
        level: "error",
        message: `cannot reach gateway: ${String(err)}`,
      });
    }
  }

  const status: AdapterEnvironmentTestResult["status"] = checks.some(
    (c) => c.level === "error",
  )
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";
  return {
    adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}

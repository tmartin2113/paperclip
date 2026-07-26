import type { UIAdapterModule } from "../types";
import { parseIronclawStdoutLine } from "./parse-stdout";
import { IronclawGatewayConfigFields } from "./config-fields";
import { buildIronclawConfig } from "./build-config";

export const ironclawGatewayUIAdapter: UIAdapterModule = {
  type: "ironclaw_gateway",
  label: "IronClaw Gateway (SSE)",
  parseStdoutLine: parseIronclawStdoutLine,
  ConfigFields: IronclawGatewayConfigFields,
  buildAdapterConfig: buildIronclawConfig,
};

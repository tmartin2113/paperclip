import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildIronclawConfig(
  v: CreateConfigValues,
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  if (v.model) ac.model = v.model;
  if (v.instructionsFilePath) ac.instructionsFilePath = v.instructionsFilePath;
  return ac;
}

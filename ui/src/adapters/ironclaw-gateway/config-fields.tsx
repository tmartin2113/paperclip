import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function IronclawGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="IronClaw gateway URL" hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://100.72.16.52:3001"
        />
      </Field>
      <Field label="Bearer token">
        <DraftInput
          value={eff("adapterConfig", "token", String(config.token ?? ""))}
          onCommit={(v) => mark("adapterConfig", "token", v || undefined)}
          immediate
          className={inputClass}
          placeholder="gateway bearer token"
        />
      </Field>
    </>
  );
}

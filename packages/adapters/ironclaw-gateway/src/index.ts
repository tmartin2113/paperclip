export const type = "ironclaw_gateway";
export const label = "IronClaw Gateway (SSE)";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# ironclaw_gateway agent configuration

Adapter: ironclaw_gateway

Runs a remote IronClaw agent over its native HTTP + Server-Sent-Events protocol
(the OpenAI Responses shape). Paperclip POSTs the task to the gateway's
/v1/responses endpoint with a Bearer token and streams the run back over SSE.
Live steering is delivered out-of-band via the gateway's control hook
(/hooks/wake) — IronClaw injects the steer at its next decision boundary.

Use when:
- Your agent runtime is an IronClaw gateway exposing HTTP /v1/responses + SSE.
- You want infra-robust streaming (works through Tailscale / proxies / firewalls,
  unlike outbound WebSocket).
- You want an advisor (e.g. claude_local) to steer the agent live at decision
  points via the control hook.

Don't use when:
- Your gateway ONLY speaks the OpenClaw WebSocket protocol (use openclaw_gateway).

Core fields:
- url (string, required): base URL of the IronClaw gateway (e.g.
  https://100.72.16.52:3001). The adapter POSTs to \`\${url}/v1/responses\`.
- token (string, required): Bearer token for the gateway (sent as
  Authorization: Bearer <token>).
- model (string, optional): model id to request (e.g. qwen3.6:27b). Omit to use
  the gateway default.
- instructionsFilePath (string, optional): absolute path to a markdown
  instructions file prepended to the task as system guidance.
- headers (object, optional): extra request headers.

Control / steering:
- wakePath (string, optional): control-hook path for live steering, default
  /hooks/wake. Advisor guidance is POSTed here mid-run.

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (default 120).
`;

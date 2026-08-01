#!/usr/bin/env bash
# Enable orchestrator-restricted mode on Claude (CEO): fence it to the
# paperclip-orchestrate MCP (no Bash/file/network/TREK). Additive JSONB merge
# into adapter_config; prints before/after. Idempotent.
set -euo pipefail
ENV_FILE="/home/prime/.config/paperclip/paperclip.env"
[ -r "$ENV_FILE" ] || { echo "FAIL: cannot read $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${DATABASE_URL:?DATABASE_URL not set}"
INURL="$(printf '%s' "$DATABASE_URL" | sed -E 's#@[^/]+/#@localhost:5432/#')"

echo "== before =="
docker exec -i paperclip-pg psql "$INURL" -Atc \
  "select name||' -> orchestratorRestricted='||coalesce((adapter_config->>'orchestratorRestricted'),'<unset>') from agents where name='Claude (CEO)';"

echo "== applying =="
docker exec -i paperclip-pg psql "$INURL" -v ON_ERROR_STOP=1 -c "
update agents set adapter_config = adapter_config
  || jsonb_build_object('orchestratorRestricted', true)
  || jsonb_build_object('orchestrateMcp', jsonb_build_object(
       'name','paperclip-orchestrate',
       'command','/usr/bin/python3',
       'args', jsonb_build_array('/home/prime/tool-integrations/paperclip-orchestrate-shim.py'),
       'env', jsonb_build_object('PAPERCLIP_ORCH_CONFIG','/home/prime/.config/paperclip/paperclip-orchestrate.json'),
       'allowedTools','mcp__paperclip-orchestrate'))
  where name='Claude (CEO)';"

echo "== after =="
docker exec -i paperclip-pg psql "$INURL" -Atc \
  "select name||' -> '||(adapter_config->'orchestrateMcp')::text from agents where name='Claude (CEO)';"
echo "DONE — now: sudo systemctl restart paperclip"

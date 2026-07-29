#!/usr/bin/env bash
# One-shot: set adapterConfig.reasoning="off" on the three ironclaw_gateway
# doer agents (DevOps, Engineer, Researcher). Additive JSONB merge — preserves
# the gateway token and every other key. Idempotent + reversible.
set -euo pipefail

ENV_FILE="/home/prime/.config/paperclip/paperclip.env"
[ -r "$ENV_FILE" ] || { echo "FAIL: cannot read $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${DATABASE_URL:?DATABASE_URL not set after sourcing env}"

# Rewrite the host-mapped address to the container-internal one for in-container psql.
INURL="$(printf '%s' "$DATABASE_URL" | sed -E 's#@[^/]+/#@localhost:5432/#')"

echo "== before =="
docker exec -i paperclip-pg psql "$INURL" -Atc \
  "select name || ' -> reasoning=' || coalesce(adapter_config->>'reasoning','<null>') \
   from agents where adapter_type='ironclaw_gateway' order by name;"

echo "== applying =="
docker exec -i paperclip-pg psql "$INURL" -v ON_ERROR_STOP=1 -c \
  "update agents \
     set adapter_config = adapter_config || jsonb_build_object('reasoning','off') \
   where adapter_type='ironclaw_gateway';"

echo "== after =="
docker exec -i paperclip-pg psql "$INURL" -Atc \
  "select name || ' -> reasoning=' || coalesce(adapter_config->>'reasoning','<null>') \
   from agents where adapter_type='ironclaw_gateway' order by name;"

echo "DONE"

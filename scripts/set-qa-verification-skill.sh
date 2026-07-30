#!/usr/bin/env bash
# Step 3 of the QA-as-Claude wiring: activate the trip-verification skill on the
# IronClaw (QA) agent (adapter_config.paperclipSkillSync.desiredSkills=["trip-verification"]).
# Additive JSONB merge; prints before/after. Idempotent.
set -euo pipefail
ENV_FILE="/home/prime/.config/paperclip/paperclip.env"
[ -r "$ENV_FILE" ] || { echo "FAIL: cannot read $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
: "${DATABASE_URL:?DATABASE_URL not set}"
INURL="$(printf '%s' "$DATABASE_URL" | sed -E 's#@[^/]+/#@localhost:5432/#')"
AGENT="IronClaw (QA)"

echo "== before =="
docker exec -i paperclip-pg psql "$INURL" -Atc \
  "select name || ' -> ' || coalesce((adapter_config->'paperclipSkillSync')::text,'<none>') from agents where name='$AGENT';"

echo "== applying =="
docker exec -i paperclip-pg psql "$INURL" -v ON_ERROR_STOP=1 -c \
  "update agents set adapter_config = adapter_config || jsonb_build_object('paperclipSkillSync', jsonb_build_object('desiredSkills', jsonb_build_array('trip-verification'))) where name='$AGENT';"

echo "== after =="
docker exec -i paperclip-pg psql "$INURL" -Atc \
  "select name || ' -> ' || (adapter_config->'paperclipSkillSync')::text from agents where name='$AGENT';"
echo "DONE — now: sudo systemctl restart paperclip"

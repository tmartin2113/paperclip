#!/usr/bin/env bash
# QA-verify wiring — step 2: enforce READ-ONLY TREK for the QA agent via a
# risk.isWrite BLOCK policy scoped to the TREK connection. Run AFTER the TREK
# connection exists (created in the Paperclip Tools UI). Auto-discovers the
# connection by name. Idempotent-ish (creating twice just adds a duplicate policy;
# check the Policies list). Uses the board session; no secrets handled here.
set -euo pipefail
BASE="http://100.72.16.52:3120"
CO="9c33c602-6ba9-4d90-b977-fdc443ca934b"                 # Prime
QA="b6115599-1ecd-4eeb-9669-7484f5df8525"                # IronClaw (QA), claude_local
CONN_NAME="${1:-trek-readonly}"                           # pass a different connection name as $1 if you named it otherwise
PASS="$(printf '%s' "$(cat /home/prime/.config/paperclip/admin-credentials)")"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT

code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" -X POST "$BASE/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' --data "$(jq -nc --arg p "$PASS" '{email:"tmartin2113@gmail.com",password:$p}')")
[ "$code" = "200" ] || { echo "login failed $code"; exit 2; }

echo "=== discovering TREK connection '$CONN_NAME' ==="
conns="$(curl -s -b "$JAR" "$BASE/api/companies/$CO/tools/connections")"
CID="$(printf '%s' "$conns" | jq -r --arg n "$CONN_NAME" '(.connections // .items // .)[]? | select(.name==$n) | .id' | head -1)"
if [ -z "$CID" ] || [ "$CID" = "null" ]; then
  echo "  NOT FOUND. Existing connections:"; printf '%s' "$conns" | jq -r '(.connections // .items // .)[]? | "   - "+.name+" ("+.id+")"' 2>/dev/null || printf '%s' "$conns" | head -c 300
  echo "  -> create the TREK connection in the Tools UI first, or pass its exact name as arg 1."; exit 3
fi
echo "  connection id: $CID"

echo "=== creating read-only BLOCK policy (block isWrite tools for QA on this connection) ==="
body="$(jq -nc --arg cid "$CID" --arg qa "$QA" '{
  name:"qa-trek-readonly",
  description:"QA verifier may READ TREK but never mutate it (independent datastore verification).",
  policyType:"block", priority:50, enabled:true,
  selectors:{connectionIds:[$cid]},
  conditions:{actor:{agentId:$qa}, risk:{isWrite:true}}
}')"
resp="$(curl -s -w $'\n%{http_code}' -b "$JAR" -H "Origin: $BASE" -H "Referer: $BASE/" \
  -X POST "$BASE/api/companies/$CO/tools/policies" -H 'Content-Type: application/json' --data "$body")"
http="$(printf '%s' "$resp"|tail -n1)"; json="$(printf '%s' "$resp"|sed '$d')"
echo "policy create HTTP: $http"
if [ "$http" = "201" ] || [ "$http" = "200" ]; then
  printf '%s' "$json" | jq -c '{id, name, policyType, priority, selectors, conditions}'
  echo "DONE — QA is read-only on TREK connection $CID."
else
  echo "FAILED: $(printf '%s' "$json"|head -c400)"; exit 4
fi
#!/bin/bash
# Resolve Google OAuth credentials from the Hollow and start workspace-mcp.
# Used as the MCP server command so secrets stay out of .claude.json.

set -euo pipefail

VAULT_URL="http://localhost:3001/api/vault/resolve"
CRED_DIR="$HOME/.google_workspace_mcp/credentials"
EMAIL="${USER_GOOGLE_EMAIL:-dave@ellie-labs.dev}"

# Resolve credentials from the Hollow
RESPONSE=$(curl -sf -X POST "$VAULT_URL" \
  -H "Content-Type: application/json" \
  -d '{"domain": "google.com", "type": "oauth"}' 2>/dev/null) || {
  echo "WARN: Could not reach Hollow (relay down?). Using cached credentials." >&2
  exec /home/ellie/.local/bin/uvx workspace-mcp "$@"
}

CLIENT_ID=$(echo "$RESPONSE" | jq -r '.payload.client_id // empty')
CLIENT_SECRET=$(echo "$RESPONSE" | jq -r '.payload.client_secret // empty')
REFRESH_TOKEN=$(echo "$RESPONSE" | jq -r '.payload.refresh_token // empty')

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" || -z "$REFRESH_TOKEN" ]]; then
  echo "WARN: Hollow returned incomplete credentials. Using cached." >&2
  exec /home/ellie/.local/bin/uvx workspace-mcp "$@"
fi

# Build credential file for workspace-mcp
mkdir -p "$CRED_DIR"

# Read existing scopes from the credential file if present, otherwise use defaults
SCOPES='[]'
if [[ -f "$CRED_DIR/$EMAIL.json" ]]; then
  SCOPES=$(jq -c '.scopes // []' "$CRED_DIR/$EMAIL.json" 2>/dev/null || echo '[]')
fi

if [[ "$SCOPES" == "[]" ]]; then
  SCOPES='["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/gmail.compose","https://www.googleapis.com/auth/gmail.modify","https://www.googleapis.com/auth/gmail.labels","https://www.googleapis.com/auth/gmail.settings.basic","https://www.googleapis.com/auth/calendar","https://www.googleapis.com/auth/calendar.readonly","https://www.googleapis.com/auth/calendar.events","https://www.googleapis.com/auth/drive","https://www.googleapis.com/auth/drive.readonly","https://www.googleapis.com/auth/drive.file","https://www.googleapis.com/auth/documents","https://www.googleapis.com/auth/documents.readonly","https://www.googleapis.com/auth/spreadsheets","https://www.googleapis.com/auth/spreadsheets.readonly","https://www.googleapis.com/auth/presentations","https://www.googleapis.com/auth/presentations.readonly","https://www.googleapis.com/auth/contacts","https://www.googleapis.com/auth/contacts.readonly","https://www.googleapis.com/auth/tasks","https://www.googleapis.com/auth/tasks.readonly","https://www.googleapis.com/auth/chat.spaces","https://www.googleapis.com/auth/chat.spaces.readonly","https://www.googleapis.com/auth/chat.messages","https://www.googleapis.com/auth/chat.messages.readonly","https://www.googleapis.com/auth/forms.body","https://www.googleapis.com/auth/forms.body.readonly","https://www.googleapis.com/auth/forms.responses.readonly","https://www.googleapis.com/auth/script.projects","https://www.googleapis.com/auth/script.projects.readonly","https://www.googleapis.com/auth/script.deployments","https://www.googleapis.com/auth/script.deployments.readonly","https://www.googleapis.com/auth/script.processes","https://www.googleapis.com/auth/script.metrics","https://www.googleapis.com/auth/cse","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/userinfo.profile","openid"]'
fi

# Get a fresh access token using the refresh token
TOKEN_RESP=$(curl -sf -X POST https://oauth2.googleapis.com/token \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "refresh_token=$REFRESH_TOKEN" \
  -d "grant_type=refresh_token" 2>/dev/null) || {
  echo "WARN: Token refresh failed. Using cached credentials." >&2
  exec /home/ellie/.local/bin/uvx workspace-mcp "$@"
}

ACCESS_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.access_token // empty')
EXPIRES_IN=$(echo "$TOKEN_RESP" | jq -r '.expires_in // 3600')

if [[ -z "$ACCESS_TOKEN" ]]; then
  echo "WARN: No access token in refresh response. Using cached." >&2
  exec /home/ellie/.local/bin/uvx workspace-mcp "$@"
fi

# Calculate expiry timestamp
EXPIRY=$(date -u -d "+${EXPIRES_IN} seconds" +"%Y-%m-%dT%H:%M:%S.000000")

# Write the credential file
jq -n \
  --arg token "$ACCESS_TOKEN" \
  --arg refresh "$REFRESH_TOKEN" \
  --arg client_id "$CLIENT_ID" \
  --arg client_secret "$CLIENT_SECRET" \
  --arg expiry "$EXPIRY" \
  --argjson scopes "$SCOPES" \
  '{
    token: $token,
    refresh_token: $refresh,
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: $client_id,
    client_secret: $client_secret,
    scopes: $scopes,
    expiry: $expiry
  }' > "$CRED_DIR/$EMAIL.json"

# Export env vars and start the MCP server
export GOOGLE_OAUTH_CLIENT_ID="$CLIENT_ID"
export GOOGLE_OAUTH_CLIENT_SECRET="$CLIENT_SECRET"
export OAUTHLIB_INSECURE_TRANSPORT=1
export USER_GOOGLE_EMAIL="$EMAIL"

exec /home/ellie/.local/bin/uvx workspace-mcp "$@"

# Unified Email: Outlook + Hotmail via Microsoft Graph API (ELLIE-86)

Adds Microsoft Outlook/Hotmail email access via Microsoft Graph API alongside existing Gmail integration. "Check my email" queries both providers; "send from outlook" routes to Outlook.

## Architecture

- **Native relay module** (not MCP) — no Microsoft MCP equivalent exists. Follows the `google-chat.ts` pattern: standalone TypeScript module with init, token caching, exported functions.
- **Gmail stays separate** — Gmail uses MCP tools (`mcp__google-workspace__*`); Outlook uses relay HTTP endpoints (`/api/outlook/*`) callable via Bash/curl. No shared abstract interface.
- **Context aggregation** — Both `getGmailSignal()` and `getOutlookSignal()` run in parallel inside `getStructuredContext()`, so Claude always sees unread counts from both providers.
- **Unified skill** — The `gmail_management` skill was renamed to `email_management` with triggers covering both Gmail and Outlook keywords.

## Files

| File | Role |
|------|------|
| `src/outlook.ts` | Core Microsoft Graph module (auth, API operations) |
| `scripts/oauth-microsoft.ts` | One-time OAuth flow to get refresh token |
| `src/context-sources.ts` | `getOutlookSignal()` + wired into aggregator |
| `src/relay.ts` | Imports, init, buildPrompt tool docs, CONFIRM rules, HTTP endpoints |
| `tests/outlook.test.ts` | 19 unit tests for the Outlook module |
| `.env.example` | Microsoft env var template |
| `db/migrations/20260219_skills_registry.sql` | Updated skill: `email_management` |

## Environment Variables

```env
# Required for Outlook integration
MICROSOFT_CLIENT_ID=<Application (client) ID from Azure portal>
MICROSOFT_CLIENT_SECRET=<Client secret value>
MICROSOFT_REFRESH_TOKEN=<From oauth-microsoft.ts script>
MICROSOFT_USER_EMAIL=<your@outlook.com or your@hotmail.com>
```

## Azure AD App Setup (Prerequisites)

1. Go to https://portal.azure.com > **App registrations** > **New registration**
2. Name: "Ellie Email" (or similar)
3. Supported account types: **"Personal Microsoft accounts only"**
4. Redirect URI: Web > `http://localhost:8978/callback`
5. Under **Certificates & secrets** > New client secret > copy the value
6. Under **API permissions** > Add permission > Microsoft Graph > Delegated:
   - `Mail.Read`
   - `Mail.Send`
   - `Mail.ReadWrite`
   - `User.Read`
   - `offline_access`
7. Set `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` in `.env`

## OAuth Flow

```bash
bun scripts/oauth-microsoft.ts
```

- Starts a local server on port **8978** (avoids collision with Google OAuth on 8977)
- Opens consent URL for `consumers` tenant (personal Microsoft accounts: Outlook.com, Hotmail, Live)
- Exchanges authorization code for tokens
- Fetches user profile to auto-detect email address
- Prints `MICROSOFT_REFRESH_TOKEN` and `MICROSOFT_USER_EMAIL` to paste into `.env`

## Module: `src/outlook.ts`

### Auth

- OAuth 2.0 token refresh via `https://login.microsoftonline.com/consumers/oauth2/v2.0/token`
- `consumers` tenant = personal Microsoft accounts only
- Token cached in memory with 60-second buffer before expiry
- Scopes: `Mail.Read Mail.Send Mail.ReadWrite offline_access User.Read`
- Env vars read lazily via `env()` helper (not module-level constants) for testability

### Exported Functions

| Function | Description |
|----------|-------------|
| `initOutlook()` | Test token refresh at startup; returns false if not configured |
| `isOutlookConfigured()` | Check env vars present |
| `getOutlookEmail()` | Return configured email address |
| `listUnread(limit?)` | GET `/mailFolders/inbox/messages?$filter=isRead eq false` |
| `getUnreadCount()` | GET `/mailFolders/inbox?$select=unreadItemCount` |
| `searchMessages(query, limit?)` | GET `/messages?$search="query"` |
| `getMessage(id)` | GET `/messages/{id}` (full content) |
| `sendEmail({subject, body, to, cc?})` | POST `/sendMail` |
| `replyToMessage(id, comment)` | POST `/messages/{id}/reply` |
| `markAsRead(id)` | PATCH `/messages/{id}` with `{isRead: true}` |
| `_resetTokenCache()` | Test helper — clears cached token |

All Graph API calls go through `graphFetch(path, options)` which injects the Bearer token and handles errors.

## HTTP API Endpoints (relay.ts)

All endpoints are under `/api/outlook/`. Returns `503` with `{"error": "Outlook not configured"}` when Microsoft env vars are missing.

### GET `/api/outlook/unread`

List unread inbox messages.

```bash
curl http://localhost:3001/api/outlook/unread
curl http://localhost:3001/api/outlook/unread?limit=5
```

Response: `{ "messages": [...] }`

### GET `/api/outlook/search?q=QUERY`

Search all messages via Microsoft Graph `$search`.

```bash
curl "http://localhost:3001/api/outlook/search?q=invoice&limit=10"
```

Response: `{ "messages": [...] }`

### GET `/api/outlook/message/MESSAGE_ID`

Get full message content by ID.

```bash
curl http://localhost:3001/api/outlook/message/AAMkAGI...
```

Response: `{ "message": {...} }`

### POST `/api/outlook/send`

Send a new email. **Requires `[CONFIRM]` in Claude pipeline.**

```bash
curl -X POST http://localhost:3001/api/outlook/send \
  -H "Content-Type: application/json" \
  -d '{"subject":"Hello","body":"Message text","to":["user@example.com"],"cc":["other@example.com"]}'
```

Response: `{ "success": true }`

### POST `/api/outlook/reply`

Reply to an existing message. **Requires `[CONFIRM]` in Claude pipeline.**

```bash
curl -X POST http://localhost:3001/api/outlook/reply \
  -H "Content-Type: application/json" \
  -d '{"messageId":"AAMkAGI...","comment":"Thanks for the update!"}'
```

Response: `{ "success": true }`

### POST `/api/outlook/read/MESSAGE_ID`

Mark a message as read.

```bash
curl -X POST http://localhost:3001/api/outlook/read/AAMkAGI...
```

Response: `{ "success": true }`

## Context Signal: `getOutlookSignal()`

Located in `src/context-sources.ts` (line 515). Runs in parallel with `getGmailSignal()` inside `getStructuredContext()`.

- Calls `getUnreadCount()` + `listUnread(5)` in parallel
- Returns empty string if Outlook is not configured
- Returns `"OUTLOOK: No unread messages."` when inbox is empty
- Otherwise returns:
  ```
  OUTLOOK (dave@outlook.com, 3 unread):
  - Sender Name: Subject line here
  - Another Sender: Another subject
  (Use /api/outlook/* endpoints via curl for full email content)
  ```

## Skill Routing

The Supabase `skills` table was updated:

- **Old name:** `gmail_management`
- **New name:** `email_management`
- **Description:** "Manage email across Gmail and Outlook/Hotmail — search, read, send, reply, draft."
- **Triggers:** `email`, `gmail`, `outlook`, `hotmail`, `inbox`, `send email`, `reply to`, `draft email`, `mail`, `unread`, `microsoft`, `check email`

## buildPrompt Tool Docs

When Outlook is configured, the buildPrompt system prompt (line 1297) includes:

```
- Microsoft Outlook (dave@outlook.com):
  Available via HTTP API (use curl from Bash):
  - GET http://localhost:3001/api/outlook/unread — list unread messages
  - GET http://localhost:3001/api/outlook/search?q=QUERY — search messages
  - GET http://localhost:3001/api/outlook/message/MESSAGE_ID — get full message
  - POST http://localhost:3001/api/outlook/send -d '{"subject":"...","body":"...","to":["..."]}' (requires [CONFIRM])
  - POST http://localhost:3001/api/outlook/reply -d '{"messageId":"...","comment":"..."}' (requires [CONFIRM])
  Your system context already includes an Outlook unread email signal.
```

## CONFIRM Rules

Send and reply actions require `[CONFIRM: description]` before execution (line 1339):

```
- Sending or replying to emails (send_gmail_message, /api/outlook/send, /api/outlook/reply)
```

## Startup

In the relay startup section (line 3471):

```typescript
const outlookEnabled = await initOutlook();
```

Console output:
```
Outlook: ON (dave@outlook.com)   // when configured
Outlook: OFF                      // when MICROSOFT_* env vars missing
```

## Tests

19 unit tests in `tests/outlook.test.ts` covering:

- Config detection (`isOutlookConfigured`, `getOutlookEmail`)
- Init (success, failure, not configured)
- `listUnread` (message parsing, empty response)
- `getUnreadCount`
- `searchMessages` (query encoding)
- `getMessage` (fetch by ID, URL encoding of special chars)
- `sendEmail` (payload structure, CC recipients, omitting CC when empty)
- `replyToMessage` (endpoint, comment body)
- `markAsRead` (PATCH method, isRead flag)
- Error handling (Graph API errors, auth failures)
- Token caching (reuses cached token across calls)

Run tests:
```bash
bun test tests/outlook.test.ts
```

## Verification Checklist

1. `bun scripts/oauth-microsoft.ts` — complete OAuth flow, get refresh token
2. Add `MICROSOFT_REFRESH_TOKEN` and `MICROSOFT_USER_EMAIL` to `.env`
3. Restart relay — confirm `[outlook] Initialized (account: ...)` in logs
4. `curl http://localhost:3001/api/outlook/unread` — returns unread messages JSON
5. `bun test tests/outlook.test.ts` — all 19 tests pass
6. Send "check my email" via Telegram/GChat — response includes both Gmail and Outlook unread
7. Send "send an email from outlook to test@example.com" — triggers `[CONFIRM:]` flow

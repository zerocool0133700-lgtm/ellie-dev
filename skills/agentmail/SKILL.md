---
name: agentmail
description: Send, receive, and manage email — check inbox, send messages, reply to threads
userInvocable: true
always: true
triggers: [agentmail, email, mail, send email, check email, inbox, send a message, reply to email, did I get any emails, email agent, inter-agent]
instant_commands: [help, status, list]
requires:
  env:
    - AGENTMAIL_API_KEY
    - AGENTMAIL_INBOX_EMAIL
    - AGENTMAIL_WEBHOOK_SECRET
help: "Get an API key from https://agentmail.to — set AGENTMAIL_API_KEY, AGENTMAIL_INBOX_EMAIL, and AGENTMAIL_WEBHOOK_SECRET in .env"
---

## Overview

AgentMail gives Ellie OS agents their own email addresses. Agents can send, receive, and reply to emails — including messages to each other (inter-agent communication) and to external humans.

- **API:** `https://api.agentmail.to/v0`
- **Auth:** Bearer token via `AGENTMAIL_API_KEY`
- **Implementation:** `src/agentmail.ts` (client), `src/http-routes.ts` (webhook endpoint)

## Setup

1. Create an account at [agentmail.to](https://agentmail.to)
2. Create an inbox — this gives you an email address (e.g., `ellie-os@agentmail.to`)
3. Generate an API key and a webhook secret from the dashboard
4. Add to `.env`:
   ```
   AGENTMAIL_API_KEY=your_api_key
   AGENTMAIL_INBOX_EMAIL=ellie-os@agentmail.to
   AGENTMAIL_WEBHOOK_SECRET=your_webhook_secret
   ```
5. Configure the AgentMail webhook URL to point at your relay:
   ```
   https://your-relay-host/api/agentmail/webhooks
   ```
6. Restart the relay: `systemctl --user restart claude-telegram-relay`

## Commands

- `/agentmail help` — Show this command reference
- `/agentmail status` — Check if email is configured and show inbox address
- `/agentmail list` — List recent email threads
- `/agentmail list 20` — List more threads
- `/agentmail send <to> <subject> <body>` — Send a new email
- `/agentmail reply <message-id> <body>` — Reply to an existing thread
- Ask naturally: "Check my email" or "Send Amy an email about the docs" or "Did I get any emails today?"

## Execution Guide

When executing commands, use the TypeScript functions from `src/agentmail.ts`:

### Status (`/agentmail status`)
Use `isAgentMailEnabled()` and `getAgentMailConfig()` to check configuration:
```typescript
import { isAgentMailEnabled, getAgentMailConfig } from "./agentmail.ts";

const enabled = isAgentMailEnabled();
if (enabled) {
  const config = getAgentMailConfig();
  console.log(`AgentMail enabled for inbox: ${config?.inboxEmail}`);
} else {
  console.log("AgentMail not configured — missing env vars");
}
```

### Send (`/agentmail send`)
Use `sendEmail(to, subject, text, config?, headers?)`:
```typescript
import { sendEmail, buildAgentHeaders } from "./agentmail.ts";

const to = ["amy-ellie-os@agentmail.to"]; // or parse comma-separated input
const subject = "Task for you";
const text = "Hey Amy, can you review this?";

// Optional: add agent headers
const headers = buildAgentHeaders("James", "dev", "inter-agent", "ELLIE-839");

const result = await sendEmail(to, subject, text, undefined, headers);
console.log(`Sent message ${result.message_id} in thread ${result.thread_id}`);
```

### Reply (`/agentmail reply`)
Use `replyToEmail(messageId, text, config?, headers?)`:
```typescript
import { replyToEmail, buildAgentHeaders } from "./agentmail.ts";

const messageId = "msg_abc123";
const text = "Thanks, I'll take a look";

// Optional: add agent headers
const headers = buildAgentHeaders("James", "dev", "inter-agent");

const result = await replyToEmail(messageId, text, undefined, headers);
console.log(`Sent reply ${result.message_id} in thread ${result.thread_id}`);
```

### List (`/agentmail list`)
Use `listThreads(config?)`:
```typescript
import { listThreads } from "./agentmail.ts";

const result = await listThreads();
console.log(`Found ${result.threads.length} threads:`);
result.threads.forEach(thread => {
  console.log(`- [${thread.thread_id}] ${thread.subject} (${thread.updated_at})`);
});
```

## Agent Headers

All outbound messages should include custom headers to identify the sender and context:

```typescript
buildAgentHeaders(
  agentName: string,      // e.g., "James", "Amy", "Brian"
  agentType: string,      // e.g., "dev", "content", "critic"
  messageType: string,    // "inter-agent", "external", "notification"
  threadContext?: string  // Optional work item ID (e.g., "ELLIE-839")
)
```

**Returned headers:**
- `X-Sent-By-Agent`: Agent name
- `X-Agent-Type`: Agent role
- `X-Message-Type`: Message category
- `X-Thread-Context`: Work item or context ID (if provided)

**Use these headers on every send or reply** to maintain inter-agent routing and context.

## Guidelines

### Email Formatting
- **Subject lines:** Keep concise and descriptive (max 60 chars)
- **Body text:** Plain text only (no HTML) — AgentMail handles rendering
- **Threading:** Always use `reply` when continuing a conversation (never `send` a new email with the same subject)
- **Context:** Include work item IDs in thread context headers for traceability

### Agent Communication Protocol
- **Inter-agent messages:** Use `X-Message-Type: inter-agent` and include sender agent name
- **External messages:** Use `X-Message-Type: external` for messages to humans or external systems
- **Notifications:** Use `X-Message-Type: notification` for status updates or alerts

### Error Handling
- If AgentMail is not configured, return a clear message: "AgentMail is not enabled — missing required env vars"
- If API calls fail, include the status code and error message: "AgentMail send failed (403): Invalid API key"
- Always validate email addresses before sending (basic format check)

### Audio-First Responses
When displaying results:
- Speak the outcome clearly: "Sent email to Amy with subject 'Task for you'"
- For lists, summarize first: "You have 5 threads. Here they are:"
- For errors, be specific but not technical: "Couldn't send the email — your API key might be wrong"

## Common Patterns

### Dispatching Work to an Agent
```
/agentmail send amy-ellie-os@agentmail.to "Work on ELLIE-839" "Hey Amy, can you draft the docs for the boot-up packet resolver? Full details in Plane. Let me know when you're done."
```

### Replying to an Agent's Completion Report
```
/agentmail reply msg_xyz789 "Great work! I'll merge this and move on to ELLIE-840."
```

### Checking Recent Agent Communication
```
/agentmail list 5
```

### Checking Configuration Before Use
```
/agentmail status
```

## Agent Email Directory

| Agent | Address | Role |
|-------|---------|------|
| Brian | brian-ellie-os@agentmail.to | Critic |
| Amy | amy-ellie-os@agentmail.to | Content |

Emails to other addresses route to the general agent.

## Anti-Patterns (What NOT to Do)

1. **Don't send a new email when you should reply** — breaks threading
2. **Don't forget agent headers** — makes routing and context tracking impossible
3. **Don't send HTML email** — AgentMail uses plain text
4. **Don't parse email bodies manually** — use webhook payloads via `parseWebhookPayload()`
5. **Don't expose webhook secrets in responses** — status check shows config, not secrets

## Integration with Relay

AgentMail webhooks arrive at `POST /api/agentmail/webhooks` in the relay (`src/http-routes.ts`).

**Inbound flow (full cycle):**
1. Webhook arrives with `X-AgentMail-Signature` header
2. Relay verifies HMAC-SHA256 signature (timing-safe comparison), returns 200 immediately
3. Payload is parsed — only `message.received` events are processed
4. **Echo prevention:** messages from the inbox's own address are skipped (prevents reply loops)
5. Recipient-based routing determines which agent handles the message:
   - `brian-ellie-os@agentmail.to` → Brian (critic agent)
   - `amy-ellie-os@agentmail.to` → Amy (content agent)
   - Other recipients → general agent
6. Inter-agent messages detected via `X-Sent-By-Agent` header — if inter-agent:
   - Response saved as assistant message from the sender agent
   - **Forwarded to Dave** via Telegram + Google Chat notifications
   - Broadcast to Ellie Chat extension
   - No Claude call needed — processing stops here
7. For non-inter-agent messages, **rate limiting** applied per sender address
8. Inbound message saved to conversation history (Supabase)
9. Agent prompt built with email context, archetype, and role (specific agents get their own archetype/role injection)
10. Claude processes the message and generates a response
11. Response tags processed, then saved as assistant message
12. **Auto-reply sent** back via AgentMail API with agent headers attached — the sender gets a threaded reply automatically

**Auth bypass:** The webhook endpoint skips API token auth — it uses its own HMAC signature verification instead.

**This skill handles outbound only** — sending and replying to emails via slash commands. Inbound handling is automatic via the webhook route.

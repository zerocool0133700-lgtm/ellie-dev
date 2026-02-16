# Communication System Architecture

**Primary repository:** `ellie-dev`
**Status:** Production (systemd user service)

## Overview

The communication system is a unified AI assistant hub that integrates multiple channels, tools, and data sources to provide contextual, proactive assistance through Telegram.

## Core Components

### Telegram Relay (`src/relay.ts`)
- **Purpose:** Main entry point for user interactions
- **Service:** `claude-telegram-relay` (systemd user service)
- **Controls:**
  - Restart: `systemctl --user restart claude-telegram-relay`
  - Logs: `journalctl --user -u claude-telegram-relay`
- **Features:**
  - Agent mode enabled by default (CLI flags `--allowedTools`)
  - Multi-channel voice call support
  - Conversation lifecycle management
  - Context docket system

### Memory System (`src/memory.ts`)
- **Database:** Supabase (PostgreSQL)
- **Semantic search:** Vector embeddings via OpenAI
- **Indexed data:**
  - Conversation history
  - Key facts
  - Pending action items
- **Search backend:** Elasticsearch (714 documents indexed real-time)

### Voice Transcription (`src/transcribe.ts`)
- **Providers:** Groq (cloud) or local Whisper
- **Integration:** Handles voice messages from Telegram
- **Status:** Active

### Work Session Management (`src/work-session.ts`)
- **Purpose:** Track and manage Claude Code work sessions
- **Integration:** Links Telegram conversations to local development sessions
- **Status:** Active

## MCP Integrations

The relay has full MCP (Model Context Protocol) access to:

| Service | Account | Purpose |
|---------|---------|---------|
| **Google Workspace** | zerocool0133700@gmail.com | Gmail, Calendar, Drive, Docs, Sheets, Tasks |
| **GitHub** | zerocool0133700-lgtm | Repository management, issues, PRs |
| **Plane** | https://plane.ellie-labs.dev/ | Work item tracking (EveLife workspace) |
| **Memory** | Local | Persistent knowledge graph |
| **Sequential Thinking** | — | Multi-step reasoning |

**Status:** All MCPs online and healthy

## Data Flow

```
User Message (Telegram)
    ↓
Telegram Bot (relay.ts)
    ↓
Context Retrieval:
  - Recent conversations (Supabase)
  - Key facts (Memory)
  - Pending actions (Memory)
  - Elasticsearch search (domain filtering)
    ↓
Claude API (Anthropic)
    ↓
Tool Execution:
  - File operations (Read, Edit, Write, Glob, Grep)
  - Shell commands (Bash)
  - Web access (WebSearch, WebFetch)
  - MCP integrations (Gmail, Calendar, Drive, GitHub, Plane)
    ↓
Response (Telegram)
    ↓
Memory Update:
  - Conversation logged (Supabase)
  - Embeddings generated (OpenAI)
  - Elasticsearch indexed (real-time)
```

## Planned Features

### Claude Code Dispatch Protocol
**Status:** In design

**Purpose:** Automatically wire up Claude Code sessions with work items from Plane

**Flow:**
1. User starts Claude Code session
2. `CLAUDE.md` dispatch protocol activates
3. System checks:
   - Is user working on a defined work item?
   - Are there open tasks in Plane (EVE project)?
4. System loads available agents (e.g., James for architecture)
5. Work session tracked and linked to Telegram conversation
6. Progress updates pushed back to unified communication system

### VS Code Relay Channel
**Status:** Proposed

**Purpose:** Extend relay to handle messages from VS Code environment

**Benefits:**
- Direct integration with development workflow
- Access to current file context
- Seamless tool use during coding

### Miro Workflow Integration
**Status:** Proposed

**Purpose:** Visual planning and workflow design on Miro boards

**Use case:** Map out Plane workflows, project dependencies, and system architecture

## Deployment

### Current Setup
- **Host:** Local development machine (Linux)
- **Process manager:** systemd (user service)
- **Restart policy:** Auto-restart on failure
- **Logs:** journalctl

### Planned: VPS Deployment
- **Target:** Cloud server (always-on)
- **Mode:** Hybrid (local processing when awake, cloud API when sleeping)
- **Estimated cost:** $2-5/month

## Monitoring & Health Checks

**Service health:**
```bash
systemctl --user status claude-telegram-relay
```

**Logs (live tail):**
```bash
journalctl --user -u claude-telegram-relay -f
```

**MCP status:**
All integrations report healthy status in relay health check.

**Elasticsearch status:**
714 documents indexed, real-time updates active.

## Security & Configuration

- **Environment variables:** `.env` (not checked into Git)
- **Secrets:** Telegram bot token, API keys (OpenAI, Groq, Supabase, Anthropic)
- **User authentication:** Telegram user ID whitelist
- **MCP credentials:** Stored in Claude Code MCP registry

## Related Documentation

- [Telegram Relay Setup](../reference/telegram-relay-setup.md) *(to be created)*
- [EveLife Project](../projects/evelife.md)
- [Daily Journal](../journal/)

---
title: Ellie-Dev Project Overview
date: 2026-02-16
tags: [ellie-dev, architecture, telegram, claude, ai-assistant]
status: active
---

# Ellie-Dev: Personal AI Assistant Platform

## What the Project Does

**ellie-dev** is a personal AI assistant platform that connects Claude (via Claude Code CLI) to Telegram as an always-on conversational agent.

### Core Features

- **Telegram bot** listens for your messages (text, voice, photos, files)
- **Relays to Claude Code** with full agent/tool access:
  - File operations (Read, Edit, Write)
  - Web search and fetch
  - Shell commands
  - MCP integrations (Google Workspace, GitHub, Plane, Supabase, Miro)
- **Persistent memory** via multiple layers:
  - PostgreSQL (Supabase) for conversation history
  - Semantic search using OpenAI embeddings
  - Full-text search via Elasticsearch for fast keyword/domain filtering
- **Multi-channel support**:
  - Telegram (text + voice messages)
  - Google Chat
  - Voice calls (Twilio + ElevenLabs)
- **Proactive features**:
  - Morning briefings
  - Smart check-ins based on goals/profile
  - Context-aware outreach
- **Key integrations**:
  - Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks)
  - GitHub (repos, issues, PRs)
  - Plane (project management)
  - Miro (visual planning)
  - Supabase (database, Edge Functions)

## What It Really Is

A **production-grade personal AI assistant infrastructure** that:
- Runs as a system service (systemd on Linux, launchd on macOS)
- Gives Claude full tool access through conversational interfaces
- Maintains persistent context and memory across all interactions
- Provides a foundation for building specialized AI agents

## Architecture Highlights

### Communication Layer
- Entry points: Telegram, Google Chat, voice calls
- Message routing through unified relay system
- Response delivery back to originating channel

### Memory System
- **Conversation history** stored in Supabase
- **Semantic search** finds relevant past context automatically
- **Full-text search** (Elasticsearch) for keyword-based retrieval with domain filtering
- **Memory tags** (`[REMEMBER:]`, `[GOAL:]`, `[DONE:]`) for explicit fact/goal tracking

### Agent Mode
Full tool access to:
- Local filesystem (read/write)
- Shell commands (non-interactive only)
- Web browsing and search
- MCP servers for external service integration

### Service Infrastructure
- Runs continuously in background as system service
- Auto-restart on crash
- Structured logging for debugging
- Health monitoring endpoints

## Technical Stack

- **Runtime:** Bun (fast JavaScript/TypeScript runtime)
- **Language:** TypeScript
- **Database:** PostgreSQL via Supabase
- **Search:** Elasticsearch (full-text + semantic)
- **Voice:** Groq Whisper API (transcription), ElevenLabs (TTS)
- **LLM:** Claude (via Claude Code CLI)
- **Messaging:** Telegram Bot API, Google Chat API
- **Telephony:** Twilio (voice calls)
- **Deployment:** systemd (Linux), launchd (macOS)

## Key Files

- `src/relay.ts` — Main entry point, message handling
- `src/memory.ts` — Memory system (storage, retrieval, semantic search)
- `src/transcribe.ts` — Voice message transcription
- `src/google-chat.ts` — Google Chat integration
- `src/work-session.ts` — Work session lifecycle management
- `config/profile.md` — User profile and preferences
- `db/schema.sql` — Database schema

## Related Documentation

- [Communication System Architecture](../architecture/communication-system.md)
- [EveLife Project](./evelife.md)
- [Daily Journal](../journal/)

## Vision

This is the foundation for a **personal AI infrastructure** — not just a chatbot, but a team lead that:
- Manages specialized AI agents (dev, research, content, finance, strategy, critic)
- Routes work intelligently across models (cheap/fast for simple tasks, heavy for reasoning)
- Proactively manages your goals and projects
- Integrates deeply with all your tools and services

The free version proves the concept. The full version becomes a personal AI company running on hardware you own.

## Getting Started

See the main [CLAUDE.md](../../CLAUDE.md) for setup instructions.

Quick start:
```bash
# Install dependencies
bun install

# Set up environment
bun run setup

# Start the relay
bun run start

# Install as system service
bun run setup:services -- --service relay
```

## Status

**Production** — Running as system service, actively used daily.

## Maintainer

Dave (@zerocool0133700)

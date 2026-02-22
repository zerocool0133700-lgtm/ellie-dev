# Tree of Knowledge Architecture

## Overview

The **Tree of Knowledge** is a restructuring of documentation and context from static files in folders to living **Forest trees** with structured branches and leaf nodes. This enables fast context retrieval, real-time agent coordination, and async communication between agents via **bird messengers**.

## Core Concepts

### 1. Documentation as Forest Trees

Instead of markdown files in `docs/`, documentation is stored as **Forest trees** with metadata-rich structure:

- **Tree:** A top-level knowledge domain (e.g., "Ellie Home", "Ellie Dev", "Ellie Forest")
- **Branch:** A section within a tree (e.g., "Architecture", "API Reference", "Tutorials")
- **Leaf:** A specific document/node with quick metadata summaries for fast retrieval

Each leaf includes:
- Title
- Summary (1-2 sentences)
- Tags
- Content
- Last updated timestamp
- Author/agent attribution

### 2. Tree Structure Examples

**Ellie Home Tree:**
- Branch: Setup & Configuration
  - Leaf: Telegram Bot Setup
  - Leaf: Supabase Configuration
  - Leaf: Voice Transcription Options
- Branch: Features
  - Leaf: Memory & Semantic Search
  - Leaf: Multi-Agent Routing
  - Leaf: Work Session Dispatch

**Ellie Dev Tree:**
- Branch: Architecture
  - Leaf: Relay Server Design
  - Leaf: Memory Layer (Supabase)
  - Leaf: Agent Router Pattern
- Branch: API Reference
  - Leaf: Work Session Endpoints
  - Leaf: Memory Management
  - Leaf: Notification Policy

**Ellie Forest Tree:**
- Branch: Core System
  - Leaf: Database Schema
  - Leaf: Elasticsearch Mappings
  - Leaf: Real-time Sync (pg_notify)
- Branch: Creatures
  - Leaf: Bird Messenger System
  - Leaf: Creature Types (TBD by Georgia)

### 3. Shared Knowledge Tree

A **shared knowledge tree** exists between all agents for:
- General research findings
- Context gathered during work sessions
- Cross-project insights
- Technical patterns and solutions

All agents can read from and contribute to this tree. Birds retrieve info from here without blocking current work.

### 4. Bird Messenger Pattern

**Birds** are async messengers that retrieve information between trees without blocking work.

**How it works:**
1. Agent A needs info from Tree B (e.g., shared knowledge tree)
2. Agent A dispatches a **bird** with a query
3. Bird flies to Tree B, retrieves the info
4. Bird returns and notifies Agent A
5. Agent A continues work with new context

**Use cases:**
- Research retrieval (background context from shared knowledge)
- Cross-agent communication (James asks Ellie for project status)
- Context enrichment (pull relevant docs during active work)

**Bird design:** See `docs/ideas/forest-bird-design.md` (owned by Georgia)

## Agent-Specific Trees

Each agent gets their own Forest tree with:
- **Context:** Work style, preferences, active goals
- **Session state:** Current task, blockers, progress
- **Metrics:** Velocity, error rate, completion stats
- **Dispatch queue:** Incoming tickets from Ellie

This forms the **OS layer** — Ellie monitors agent trees in real-time for coordination and dispatch without needing to open their IDE.

**Pilot:** James gets the first full tree setup to prove the pattern before scaling to other agents.

## Implementation Phases

### Phase 1: Shared Knowledge Tree (ELLIE-122)
- Define schema for trees/branches/leaves
- Build API for creating and querying tree nodes
- Migrate key docs from `docs/` to tree structure
- Add metadata extraction

### Phase 2: Bird Messenger System (ELLIE-122)
- Design creature schema (owned by Georgia)
- Implement async dispatch/retrieval pattern
- Build notification on bird return
- Test cross-tree queries

### Phase 3: Agent-Specific Trees
- Create James's tree with context + session state
- Build real-time monitoring in Ellie relay
- Add dispatch queue integration
- Validate OS layer coordination

### Phase 4: Full Migration
- Convert all `docs/` to tree structure
- Expand to other agents (Research, Content, Finance, etc.)
- Build UI for browsing tree/branch/leaf hierarchy
- Add search across all trees

## Benefits

✅ **Fast context retrieval** — Metadata summaries let agents scan branches quickly
✅ **Real-time visibility** — Ellie monitors agent trees without opening their IDE
✅ **Async communication** — Birds retrieve info without blocking work
✅ **Structured knowledge** — No more scattered markdown files
✅ **Agent coordination** — OS layer for dispatching work and tracking progress
✅ **Scalable architecture** — Pattern proven with James before scaling

## Next Steps

1. Georgia designs bird creature types and behaviors (ELLIE-122)
2. Build shared knowledge tree schema and API
3. Prove pattern with James's agent tree
4. Expand to full system

---

**Related:**
- [Forest Bird Design](./forest-bird-design.md) (Georgia's design doc)
- [ELLIE-121] Agent Orchestration OS Architecture (brainstorm session)
- [ELLIE-122] Forest Creature Expansion (working session)

# System Administration UI

> Dashboard URL: `https://dashboard.ellie-labs.dev/admin`
> Source: `ellie-home/app/pages/admin/`

## Overview

The System Administration panel provides a centralized view of Ellie OS infrastructure, agents, credentials, integrations, and system health. Located at `/admin` on the dashboard, it contains 8 sub-pages organized as a navigation grid.

---

## Admin Landing (`/admin`)

The main admin page displays a navigation grid linking to all sub-pages, plus a system health summary.

### Health Metrics (4 cards)

| Metric | Source | Display |
|--------|--------|---------|
| Relay Status | `/api/health` → `status` | Running (green dot) / Down (red dot) |
| Periodic Tasks | `/api/health` → `periodicTasks.length` | Count of active tasks |
| Agents | `/api/health` → agent count | Total registered agents |
| Scheduled Tasks | `/api/health` → schedule count | Total scheduled tasks |

### Navigation Cards

| Card | Route | Description |
|------|-------|-------------|
| Credentials | `/admin/credentials` | API keys, secrets, and encrypted credentials |
| Models | `/admin/models` | LLM provider configuration and model selection |
| Agents | `/admin/agents` | Agent profiles, wiring, and tool assignment |
| Skills | `/admin/skills` | Skill upload, sandbox testing, and promotion |
| Schedules | `/admin/schedules` | Cron jobs and automated task management |
| Integrations | `/admin/integrations` | Telegram, GitHub, Google Workspace connections |
| System | `/admin/system` | Health checks, periodic tasks, containers |

---

## Agents (`/admin/agents`)

Displays all registered agents as a card grid.

### Agent Card Fields

| Field | Description |
|-------|-------------|
| Avatar | First letter of name, color-hashed background |
| Name | `display_name` or `name` |
| Type | Agent type (defaults to "agent") |
| Description | Brief agent description |
| Model | LLM model name (e.g., `claude-sonnet-4-6`) |
| Trust Level | Color-coded badge: high (emerald), medium (amber), other (gray) |
| Status | "active" (emerald) or inactive (gray) |
| Capabilities | Tag chips, max 5 shown with "+N more" overflow |

### API

- `GET /api/agents` — returns `{ agents: [...] }`

### Actions

Read-only. No mutations available from this page.

---

## Credentials (`/admin/credentials`)

Manages API keys, secrets, and encrypted credentials stored in The Hollow.

### Add Credential Form (collapsible)

| Field | Type | Description |
|-------|------|-------------|
| Mode | Toggle buttons | `credential`, `secret` (plain), or `file` |
| Key | Text input | Identifier (e.g., `OPENAI_API_KEY`) |
| Value | Textarea | Secret value (hidden in `file` mode) |

### Credential List

| Column | Description |
|--------|-------------|
| Key | Credential identifier (monospace) |
| Type | credential / secret / file |
| Delete | Red button with confirmation dialog |

### API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/credentials` | List all entries |
| `POST` | `/api/credentials` | Create (body: `{ key, value, type }`) |
| `DELETE` | `/api/credentials/:key` | Delete by key |

### Actions

- **Add credential** — Save button in the collapsible form
- **Delete credential** — Red delete button with confirmation dialog
- **Toggle form** — Show/hide the add form

---

## Integrations (`/admin/integrations`)

Displays connection status for all external services.

### Integration Cards

| Integration | Description | Config Key | Status Detection |
|-------------|-------------|------------|-----------------|
| Telegram | Bot messaging via Grammy | `TELEGRAM_BOT_TOKEN` | Always connected |
| Google Workspace | Calendar, email, contacts, tasks via MCP | `GOOGLE_*` | Health endpoint |
| GitHub | Repos, PRs, issue tracking | `GITHUB_TOKEN` | Always connected |
| Plane | Project management, tickets, states | `PLANE_API_KEY` | Always connected |
| Supabase | Conversations, memory, state | `SUPABASE_URL` | Health endpoint |
| Elasticsearch | Full-text search | `ELASTICSEARCH_URL` | Health endpoint (`status === 'up'`) |
| ElevenLabs | TTS for Read Mode | `ELEVENLABS_API_KEY` | Always connected |

### Status Indicators

- **Green dot + "Connected"** — service is reachable and configured
- **Gray dot + "Not configured"** — service config key missing or health check failed

### API

- `GET /api/health` — derives connection status from health sub-fields

### Actions

Read-only. Configuration changes must be made via environment variables or The Hollow.

---

## Models (`/admin/models`)

Displays the LLM model registry with provider filtering.

### Filter Tabs

- **All** — show all models
- **Per provider** — one tab per unique provider (e.g., `anthropic`, `openai`, `google`)

### Model Card Fields

| Field | Description |
|-------|-------------|
| Name | `display_name` or model name |
| Default Badge | Shown if `is_default` is true |
| Model ID | Technical identifier (gray, smaller text) |
| Context Window | Displayed as "Nk ctx" (e.g., "200k ctx") |
| Max Output | Displayed as "Nk out" (e.g., "128k out") |

### Provider Badge Colors

| Provider | Color |
|----------|-------|
| Anthropic | Amber |
| OpenAI | Emerald |
| Google | Blue |
| Other | Gray |

### API

- `GET /api/models` — returns `{ models: [...] }`

### Actions

Read-only. Provider tab filtering is client-side only.

---

## Schedules (`/admin/schedules`)

Displays all scheduled/cron tasks with summary statistics.

### Summary Stats (4 cards)

| Metric | Color | Description |
|--------|-------|-------------|
| Total | Default | Total number of scheduled tasks |
| Enabled | Emerald | Tasks where `enabled === true` |
| Failed | Red | Tasks where `last_status === 'failed'` |
| Types | Cyan | Count of unique task types |

### Task Card Fields

| Field | Description |
|-------|-------------|
| Name | Task name |
| Type | Color-coded badge: formation (purple), dispatch (blue), http (amber), reminder (emerald) |
| Schedule | Cron expression (monospace) |
| Next Run | Formatted in CST timezone |
| Status | Enabled (emerald) / Disabled (gray) badge |

### Navigation

- **"Full scheduler"** link → `/scheduled-tasks` page for detailed management

### API

- `GET /api/scheduled-tasks` — returns `{ tasks: [...] }`

### Actions

Read-only from this view. Use `/scheduled-tasks` for task management.

---

## Skills (`/admin/skills`)

Displays all registered skills with agent assignment info.

### Skill Card Fields

| Field | Description |
|-------|-------------|
| Name | Skill name |
| Description | Skill description |
| Status | Color-coded badge: active (emerald), sandbox (amber), other (gray) |
| Agents | Tag chips showing which agents use this skill |

### Navigation

- **"Full skill manager"** link → `/skills` page for detailed management

### API

- `GET /api/skills` — returns `{ skills: [...] }`

### Actions

Read-only from this view. Use `/skills` for skill management.

---

## System (`/admin/system`)

Displays service health, periodic task status, and container links.

### Services Panel (3-column grid)

| Service | Health Check Source | Status |
|---------|-------------------|--------|
| Relay | Always OK | Green/red dot |
| Forest DB | `health.forest.status` | Green/red dot |
| Supabase | `health.supabase.status` | Green/red dot |
| Elasticsearch | `health.elasticsearch.status === 'up'` | Green/red dot |
| Anthropic | `health.anthropic.status` | Green/red dot |
| Telegram | `health.telegram.status` | Green/red dot |

### Periodic Tasks Panel (scrollable list)

| Field | Description |
|-------|-------------|
| Label | Task name |
| State | Dot indicator: running (cyan, pulsing), idle (emerald), backoff (amber), disabled (red) |
| Interval | Formatted as seconds/minutes/hours from `intervalMs` |
| Last Run | Relative time: "just now", "Nm ago", "Nh ago", "Nd ago" |

### Containers Panel

- Link to `/containers` — "View container dashboard" for Docker/Plane container management

### API

- `GET /api/health` — provides all service status, periodic task array, and uptime data

### Actions

Read-only monitoring. No mutations available.

---

## API Summary

All endpoints consumed by admin pages:

| Endpoint | Method | Used By | Purpose |
|----------|--------|---------|---------|
| `/api/health` | GET | Landing, Integrations, System | Service health, tasks, agent count |
| `/api/agents` | GET | Agents | List all registered agents |
| `/api/credentials` | GET | Credentials | List stored secrets |
| `/api/credentials` | POST | Credentials | Create new credential |
| `/api/credentials/:key` | DELETE | Credentials | Remove credential |
| `/api/models` | GET | Models | List LLM model registry |
| `/api/scheduled-tasks` | GET | Schedules | List cron/scheduled tasks |
| `/api/skills` | GET | Skills | List registered skills |

## Component Architecture

All admin pages use shared layout components:

- `<AdminLayout>` — wrapper providing consistent admin page structure
- `<AdminCard>` — content card with title, optional badge, and slot content
- `<SaveFeedback>` — visual feedback on save operations (credentials page)

## Access

The admin panel is accessible to all authenticated dashboard users. No role-based access control within admin — all pages are visible. Write operations (credentials only) have no additional authorization gate beyond dashboard auth.

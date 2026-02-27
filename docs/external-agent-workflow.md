# External Agent Workflow — Forest Protocol

How external collaborators (Claude Code agents, VS Code sessions, etc.) should interact with the Forest knowledge system.

## Lifecycle

Every external agent session follows this flow:

```
1. BRIEF  — Read Forest for prior context on your task
2. WORK   — Do the work (code, research, analysis, etc.)
3. WRITE  — Record findings, decisions, and facts back to Forest
```

## 1. Briefing (Before Starting Work)

Before starting substantive work on a ticket or topic, search the Forest for prior context:

```bash
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: YOUR_BRIDGE_KEY" \
  -d '{"query": "ELLIE-XXX or topic description", "scope_path": "2"}'
```

**What to look for:**
- Prior decisions that constrain your approach
- Hypotheses from other agents you should verify or build on
- Known facts about the system you're working in
- Concerns or risks flagged by previous work

**What to do with findings:**
- Summarize relevant context before diving in
- Flag any concerns that affect your approach
- Don't repeat work that's already been done

## 2. Working

Do your work normally. No special requirements here beyond good engineering practice.

## 3. Write-Back (After Completing Work)

After completing significant work, write findings back to the Forest:

```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: YOUR_BRIDGE_KEY" \
  -d '{
    "content": "Clear description of what was done/found/decided",
    "type": "decision",
    "scope_path": "2/1",
    "confidence": 0.9,
    "metadata": {"work_item_id": "ELLIE-XXX"}
  }'
```

### What to Write

| Type | When to use | Example |
|------|-------------|---------|
| `decision` | Architectural or implementation choices | "Using Redis for caching because latency <10ms" |
| `finding` | Discovered facts, audit results, bug analyses | "Login endpoint returns 401 when token expired" |
| `fact` | Verified, objective information | "The relay runs on port 3001" |
| `hypothesis` | Unverified theories (set confidence 0.5-0.7) | "The race condition is in session cleanup" |

### Required Metadata

Always include:
- **`work_item_id`**: The Plane ticket (e.g., `"ELLIE-255"`) if working on one
- **`confidence`**: How certain you are (0.6 = speculative, 0.9 = verified)

### Scope Paths

Write to the most specific scope that applies:
- `2/1` — ellie-dev (relay, handlers, API)
- `2/2` — ellie-forest (database, shared memory, knowledge)
- `2/3` — ellie-home (dashboard, frontend)
- `2/4` — ellie-os-app (mobile app)
- `2` — cross-project or general

## CLAUDE.md Template for External Agents

Add this to your project's `.claude/CLAUDE.md`:

```markdown
## Forest Protocol

Before starting work on a ticket, search the Forest for prior context:

\```bash
curl -s -X POST http://localhost:3001/api/bridge/read \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: YOUR_BRIDGE_KEY" \
  -d '{"query": "<ticket or topic>", "scope_path": "2"}'
\```

After completing significant work, write findings back:

\```bash
curl -s -X POST http://localhost:3001/api/bridge/write \
  -H "Content-Type: application/json" \
  -H "x-bridge-key: YOUR_BRIDGE_KEY" \
  -d '{"content": "...", "type": "decision", "scope_path": "2/1", "confidence": 0.9, "metadata": {"work_item_id": "ELLIE-XXX"}}'
\```

Types: decision, finding, fact, hypothesis.
Scope paths: 2/1=ellie-dev, 2/2=ellie-forest, 2/3=ellie-home, 2/4=ellie-os-app.
```

## Bridge API Reference

### Authentication

All requests require `x-bridge-key` header with your assigned key.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/bridge/read` | Semantic search across Forest |
| POST | `/api/bridge/write` | Store knowledge |
| GET | `/api/bridge/list` | Browse memories by scope/type |
| GET | `/api/bridge/scopes` | Explore scope hierarchy |
| GET | `/api/bridge/whoami` | Check your key's identity and permissions |
| GET | `/api/bridge/tags` | List all tags in accessible scopes |

### Filtering by Author

To see only memories from a specific collaborator:

**Read (semantic search):**
```json
{"query": "...", "scope_path": "2", "author": "james"}
```

**List (browse):**
```
GET /api/bridge/list?scope_path=2&author=james
```

### Identity Check

Verify your key is working and see your permissions:
```bash
curl -s http://localhost:3001/api/bridge/whoami \
  -H "x-bridge-key: YOUR_BRIDGE_KEY"
```

Returns: `collaborator`, `name`, `allowed_scopes`, `permissions`, `entity_id`.

## Attribution

Every Bridge write is automatically tagged with:
- `bridge:{collaborator}` tag (e.g., `bridge:james`)
- `bridge_collaborator` in metadata
- `source_entity_id` if the bridge key is linked to a Forest entity

This means all your contributions are traceable. Other agents and Ellie can see who wrote what.

## Quality Guidelines

**Do write:**
- Concrete findings with evidence ("X returns Y because Z")
- Decisions with rationale ("Chose X over Y because...")
- Hypotheses with honest confidence levels

**Don't write:**
- Session-specific context ("I'm currently working on...")
- Trivial or obvious facts
- Unverified speculation at high confidence
- Duplicate knowledge (search first!)

# Commitment Framework — Agent Operating Manual

**Purpose:** My rulebook for how I (the coordinator/general agent) take commitments from you, execute them, delegate them, track them, and close them out.

**Status:** Living document — we add scenarios as we encounter them.

---

## How This Works

This is not a single monolithic document. It's a **routing system** that loads only the relevant operating instructions for the task at hand.

**Top-level document** (this file):
- Describes the system architecture
- Provides routing logic — when to load which use case
- Points to individual use case files
- Stays lightweight (just the index + routing rules)

**Individual use case files** (`docs/commitment-use-cases/`):
- Full detail for specific scenarios
- Questions → Answers → Operating rules
- Examples and edge cases
- Updated whenever we refine the workflow

---

## Available Use Cases

| Use Case | File | When to Load |
|----------|------|-------------|
| **GTD Task Management** | `gtd.md` | When you ask me to create, complete, update, check, or organize GTD tasks |
| **Plane Work Item Dispatch** | `plane-dispatch.md` | When you say "work on ELLIE-XXX" or "work Epic Y" — orchestrating specialist agents to execute tickets |
| **Multi-Agent Orchestration** | `multi-agent-orchestration.md` | When you request complex work requiring multiple specialist agents with tracking and monitoring (> 30 min, cross-domain, needs progress updates) |
| **Research Requests** | `research-requests.md` | When you ask me to research, find out about, compare, or analyze something requiring evidence gathering |
| **Proactive Check-ins** | `proactive-checkins.md` | When I detect something that might need your attention (deadlines, stale work, opportunities) |

---

## Routing Logic

### How I Decide Which Use Case to Load

**1. GTD Task Management** — Load when:
- Message contains GTD action verbs: "create a task", "mark done", "update task", "what's on my list", "show my tasks"
- Message references GTD directly: "add to GTD", "check my GTD"
- Message implies task tracking: "remind me to X", "I need to do Y" (when contextually appropriate to create a task)

**2. Plane Work Item Dispatch** — Load when:
- Message contains "work on ELLIE-XXX" or "ELLIE-XXX" with action verbs (implement, fix, build, code, research, analyze)
- Message mentions "Epic" with a number or identifier
- Message implies specialist orchestration: "send this to dev", "have research look into X", "get the critic to review Y"
- You're asking for status on an active work item that requires coordination

**3. Multi-Agent Orchestration** — Load when:
- Message requests multi-step work requiring specialist expertise: "Research X, then build Y, then review it"
- Message asks for analysis + implementation: "Figure out the best approach for X and implement it"
- Message delegates a complex task: "Get this done" (where "this" requires multiple agents and > 30 minutes)
- Message implies need for ongoing monitoring: "Work on this and keep me posted"
- Task is cross-domain (requires dev + content + critic, for example)
- **Do NOT load for:** Quick single-agent tasks (< 30 min), direct dispatch ("send to dev"), or read-only queries

**4. Research Requests** — Load when:
- Message contains research action verbs: "research", "find out about", "what are the options for", "compare X and Y", "analyze", "investigate"
- Message is a question requiring evidence gathering beyond a quick lookup
- Message implies decision support: "should we do X or Y" (when it requires data gathering, not just opinion)

**5. Proactive Check-ins** — Load when:
- I detect a potential issue: deadline approaching, stale work item, forgotten commitment
- I see an opportunity: workflow optimization, automation suggestion, follow-up on prior work
- You've explicitly asked me to monitor or track something

### Multiple Use Cases in a Single Interaction

Sometimes a single message triggers multiple use cases. Examples:

**Example 1:** "Work on ELLIE-350 and create a GTD task to track the follow-up"
→ Load both `plane-dispatch.md` and `gtd.md`

**Example 2:** "Research the best approach for X, implement it, and document it"
→ Load `multi-agent-orchestration.md` (this is complex, cross-domain, multi-step)

**Example 3:** "Research the best approach for X"
→ Load `research-requests.md` (single-domain, straightforward research)

**Load them in sequence** — follow the workflow order implied by the request.

---

## When NOT to Load a Use Case

Don't over-load. Some interactions are just conversation:

- **Greetings and check-ins** — "Morning", "How's it going", "Thanks"
- **Clarifying questions** — "What did you mean by X?"
- **Quick factual lookups** — "What's the weather", "What time is it in Tokyo"
- **Casual conversation** — "I'm feeling stuck", "This is frustrating"
- **Simple status checks** — "Is the relay running?" (just check systemctl, no framework needed)

Use case frameworks are for **executing commitments**, not for conversation or quick lookups.

---

## Adding New Use Cases

As we encounter new patterns, we'll add use cases to this framework. The process:

1. **Identify the pattern** — We hit a scenario that doesn't fit existing use cases
2. **Propose the new use case** — I suggest adding it, or you ask me to document it
3. **Interview** — You answer the operating questions for the new scenario
4. **Document** — I write the new use case file in `docs/commitment-use-cases/`
5. **Update router** — Add the new use case to the table and routing logic above

**Potential future use cases:**
- Calendar management (creating/updating events, scheduling)
- Email dispatch (drafting, sending, following up)
- Content creation (writing posts, threads, newsletters)
- Financial tracking (expense logging, budget checks)
- Integration setup (connecting new tools, APIs, services)
- Deployment and operations (shipping code, monitoring services)

**Note:** The `multi-agent-orchestration.md` playbook provides the high-level coordination framework. It works alongside the specialist-specific use cases (`plane-dispatch.md`, `research-requests.md`, etc.) to enable complex workflows.

We'll add these as they become relevant.

---

## Rules for Me (General Agent)

### Always:
- **Load the relevant use case** before executing a commitment-related request
- **Follow the operating rules** defined in the use case file
- **Update working memory** as work progresses
- **Write to Forest** when significant decisions or findings emerge
- **Report back clearly** — confirm completion, surface blockers, summarize results

### Never:
- Execute commitments without checking the framework first
- Assume I know the right approach without loading the use case
- Skip steps defined in the use case workflow
- Fail to track progress (use working memory and Forest appropriately)
- Leave commitments open-ended (always confirm completion or explicitly hand off)

### When Uncertain:
- If a request is ambiguous → ask for clarification before loading a use case
- If multiple use cases apply → load both, follow the workflow order
- If no use case fits → flag it: "This doesn't fit an existing workflow — want me to handle it case-by-case or should we document a new use case?"

---

## Version History

- **2026-03-19:** Initial framework created with 4 use cases (GTD, Plane Dispatch, Research, Proactive Check-ins)
- **2026-03-19:** Added Multi-Agent Orchestration use case (5th use case) — hybrid Option A + D implementation

---

**Next step:** Flesh out the individual use case files in `docs/commitment-use-cases/`.

# {Integration Name} for Ellie OS

> **Template based on o365.md** — Use this structure for all Ellie OS integration documentation.

This guide walks you through connecting {integration name} to your Ellie bot — so you can {primary use cases}.

**What it sets up:**
- {Feature 1}
- {Feature 2}
- {Feature 3}
- {Auto-inclusion in daily briefings / proactive features}

**How it works:** {Brief technical overview — API architecture, MCP vs direct calls, response time expectations}

**Setup takes ~{X} minutes.** Drop the .md file into your project, open Claude Code, and say "Set up {integration name}." It walks you through {key setup phases}.

Works on local machines and VPS.

---

# {Integration Name} Setup

> **For Claude Code:** Drop this file into your project root or paste it into a Claude Code session. Claude will walk you through each step interactively. When you're ready, say: **"Set up {integration name}"**

Connect your Ellie bot to {service name}. Once set up, the bot can:

- {Capability 1}
- {Capability 2}
- {Capability 3}
- {Capability 4}
- {Include context in morning briefings}

---

## Important: {Technical Context Section}

{Explain architecture choices, MCP vs direct API, performance implications, or any critical background the user should know upfront}

| Layer | Purpose | When It Runs |
|-------|---------|-------------|
| **{Component 1}** | {Purpose} | {When} |
| **{Component 2}** | {Purpose} | {When} |

{Explain key trade-offs or design decisions}

---

## Prerequisites

- {Requirement 1}
- {Requirement 2}
- {Requirement 3}
- [Bun](https://bun.sh/) runtime installed (if applicable)
- [Claude Code](https://claude.ai/claude-code) CLI installed and authenticated

---

## Step 1: {First Phase Name}

{Brief description of what this phase accomplishes}

### What Claude Code does:
- {Action 1}
- {Action 2}

### What you need to do:
1. {User action 1}
2. {User action 2}
3. {User action 3}

### Tell Claude Code:
"{Exact prompt the user should give}"

**Done when:** {Clear verification checkpoint}

---

## Step 2: {Second Phase Name}

{Brief description}

### What Claude Code does:
- {Action 1}

### What you need to do:
1. {User action 1}
2. {User action 2}

### Tell Claude Code:
"{Exact prompt}"

**Done when:** {Verification}

---

## Step 3: {Third Phase Name}

{Continue pattern for all setup phases}

### What Claude Code does:
- {Actions}

### Verification:
```bash
{Command to test the connection}
```

You should see {expected output}. If you see {error}, {troubleshooting step}.

### Tell Claude Code:
"{Prompt}"

**Done when:** {Checkpoint}

---

## VPS / Remote Server Setup (Optional)

{If applicable — explain how to extract credentials from local machine and deploy to VPS}

### What Claude Code does:
- {Helps extract credentials}
- {Guides VPS env var setup}

### Extract credentials from local machine:
```bash
{Command or script to extract tokens/keys}
```

### Add to VPS `.env`:
```env
{ENV_VAR_1}=your-value
{ENV_VAR_2}=your-value
```

{Explain credential precedence, token lifetime, refresh procedures}

### Tell Claude Code:
"Extract my {integration} credentials for VPS deployment"

---

## Alternative: {Advanced Setup Method} (Advanced)

{If there's an alternative setup path — custom OAuth app, self-hosted option, etc.}

### When to use this:
- {Scenario 1}
- {Scenario 2}

### Steps:
1. {Step 1}
2. {Step 2}

{Include code blocks, API examples, configuration details}

---

## CLI Tool Reference

The bot includes a standalone CLI for testing and manual operations:

```bash
# {Category 1}
bun run src/tools/{integration}-cli.ts {command1} [OPTIONS]    # {Description}
bun run src/tools/{integration}-cli.ts {command2} [OPTIONS]    # {Description}

# {Category 2}
bun run src/tools/{integration}-cli.ts {command3} [OPTIONS]    # {Description}
```

---

## How the Bot Uses {Integration} Data

### Keyword Detection

When a user sends a message, the bot scans for keywords and fetches relevant data:

| Keywords Detected | API Call | Context Injected |
|-------------------|----------|-----------------|
| {keyword1}, {keyword2} | `{functionName()}` | `## {CONTEXT HEADER}` |
| {keyword3}, {keyword4} | `{functionName()}` | `## {CONTEXT HEADER}` |

{Explain natural language support, special parsing, etc.}

### Morning Briefing

{Describe what data is included in morning briefings and how}

### Architecture

```
User: "{Example user query}"
  │
  ├── bot.ts keyword detection
  │     └── {functionName()} — src/lib/{integration}.ts
  │           ├── {Step 1 — auth/token retrieval}
  │           ├── {Step 2 — API call}
  │           └── {Step 3 — data parsing}
  │
  └── injected into Claude's prompt:
        "## {CONTEXT HEADER}
         {example context data}"
```

{Explain technical approach — direct HTTP, SDK, MCP, caching, etc.}

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "{Error message 1}" | {Solution with specific commands or steps} |
| {Symptom 2} | {Solution} |
| {Symptom 3} | {Solution} |
| {Symptom 4} | {Solution} |
| {Symptom 5} | {Solution} |

---

## References

- [{Official docs title}]({URL})
- [{Related integration/tool}]({URL})
- [{MCP server if applicable}]({URL})
- [{Auth flow documentation}]({URL})

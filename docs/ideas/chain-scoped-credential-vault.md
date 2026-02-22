# Chain-Scoped Credential Vault

> Dragon to slay later. Captured from conversation on Feb 18, 2026.

## The Problem

Right now ELLIE-32 (credential vault) was designed for **site-level credentials** — storing cookies and API keys so Ellie can browse authenticated pages on Dave's behalf.

But with the chain model, the scope expands. A chain owner isn't just a user with preferences — they're bringing their **entire integration surface**:

- **API keys** — OpenAI, Groq, ElevenLabs, etc.
- **OAuth tokens** — Google Workspace, GitHub
- **Service accounts** — Google Chat SA key
- **Site credentials** — Skool, Notion, whatever Playwright needs
- **MCP server configs** — which MCPs are active and how they're authenticated

Currently all of that lives in `.env` and config files on disk — which works for single-tenant Dave. But when Bette (or anyone else) brings their chain, they need their own:

- Google account (Calendar, Gmail, Tasks)
- Their own API keys (or shared ones with usage tracking)
- Their own credential vault entries
- Their own MCP permissions

## Two Approaches

### Option 1: Enhance ELLIE-32 to be chain-aware (recommended)
The vault becomes the single place where each chain owner's credentials live, encrypted and scoped by `owner_id`. The relay checks the vault at runtime instead of `.env`.

**Pros:** Clean path, vault was always going to store secrets — just add `owner_id` scoping and make the relay resolve credentials per-chain instead of per-environment.

### Option 2: Keep it simple for now
`.env` stays as Dave's chain config, and we only build chain-scoped vaults when a second chain owner actually shows up.

**Pros:** Less work today.
**Cons:** Harder retrofit later.

## Dashboard Integration

This plays nicely with the dashboard — each chain owner gets a **"My Integrations"** page showing what's connected, what tokens are active, and what needs renewal.

## Decision

TBD — parked for later. When the time comes, Option 1 (enhance ELLIE-32) is the right move as a refinement to the existing vault spec, not a separate system.

# Test Plan: ELLIE-53 + ELLIE-54

**Status:** Both features are complete and deployed
**Test Date:** Feb 19, 2026
**Test Channels:** Telegram, Google Chat

---

## ELLIE-53: Skill Registry

### Component Overview
- **skills table** — Postgres table with skill catalog
- **GET /api/skills** — REST endpoint for skill listing
- **intent-classifier.ts** — Updated to match skills instead of just agents
- **Seed data** — Initial skill definitions

### Test Cases

#### 1. Skill Table Schema ✅
```bash
# Verify skills table exists and has correct columns
curl -s http://localhost:3001/api/skills | jq '.[0]'
```
**Expected:** JSON with skill object including: id, agent_id, name, description, triggers, complexity, enabled, priority

#### 2. Skill Catalog API ✅
```bash
# List all active skills
curl -s http://localhost:3001/api/skills | jq 'length'
```
**Expected:** Returns 15-20 skills

```bash
# Verify chain-scoped filtering
curl -s "http://localhost:3001/api/skills?owner_id=YOUR_USER_ID" | jq 'length'
```
**Expected:** Returns skills for specific chain owner

#### 3. Classifier Skill Routing
**Test via Telegram/Google Chat:**

| Test Message | Expected Skill | Expected Agent | Confidence |
|--------------|----------------|----------------|------------|
| "Add a task to my TODO list" | task_management | general | >0.8 |
| "Calculate mortgage interest at 4.2% for 30 years" | financial_analysis | finance | >0.8 |
| "Search for TypeScript best practices" | web_search | research | >0.7 |
| "Create work item ELLIE-99" | plane_create | dev | >0.8 |
| "Send email to alice@example.com" | gmail_send | general | >0.8 |
| "Check my calendar for tomorrow" | calendar_query | general | >0.8 |

**Verify:**
- Check relay logs: `journalctl --user -u claude-telegram-relay -n 50`
- Look for `[classifier] LLM → "SKILL_NAME" [AGENT_NAME] (confidence)`
- Confirm skill context is passed to agent

#### 4. Skill Metadata in Agent Dispatch
**Test:**
```bash
# Send message, check session record
psql $SUPABASE_URL -c "SELECT skill_name, agent_name FROM agent_sessions ORDER BY created_at DESC LIMIT 5;"
```
**Expected:** skill_name column is populated

---

## ELLIE-54: Sequential Pipeline Execution

### Component Overview
- **orchestrator.ts** — Pipeline executor
- **execution_plans table** — Pipeline execution history
- **Light vs Heavy dispatch** — API-first for simple tasks, CLI for complex
- **Cost tracking** — Per-step token/cost accounting

### Test Cases

#### 1. Single-Agent Passthrough (Baseline)
**Test via Telegram:**
> "What's the weather in Chicago?"

**Expected:**
- Classifier returns `execution_mode: "single"`
- No orchestrator invoked
- Single agent handles request
- No execution_plans record created

**Verify:**
```bash
journalctl --user -u claude-telegram-relay -n 50 | grep "\[orchestrator\]"
```
Should be empty (orchestrator not triggered)

#### 2. Pipeline: Research → Summarize
**Test via Telegram:**
> "Research the latest TypeScript 5.4 features and summarize the top 3"

**Expected:**
- Classifier returns `execution_mode: "pipeline"` with 2 steps
- Step 1: research agent (web search)
- Step 2: general agent (summarize)
- execution_plans record created with mode="pipeline"

**Verify:**
```bash
# Check logs
journalctl --user -u claude-telegram-relay -n 100 | grep -E "\[orchestrator\]|\[classifier\]"

# Check execution plan
psql $SUPABASE_URL -c "SELECT id, mode, steps FROM execution_plans ORDER BY created_at DESC LIMIT 1;"
```

#### 3. Pipeline: Analyze → Draft Email
**Test via Google Chat:**
> "Analyze my open work items in Plane and draft an email summary for my manager"

**Expected:**
- Step 1: dev agent (fetch Plane issues)
- Step 2: content agent (draft email)
- Artifact store captures both outputs
- Final response is draft email (not Plane raw data)

**Verify:**
```bash
# Check execution plan steps
psql $SUPABASE_URL -c "SELECT steps FROM execution_plans ORDER BY created_at DESC LIMIT 1;" | jq
```

#### 4. Pipeline: Calendar → Suggest Times
**Test via Telegram:**
> "Check my calendar for this week and suggest 3 good times for a 1-hour meeting"

**Expected:**
- Step 1: general agent (calendar query via Google Workspace MCP)
- Step 2: general agent (analyze free slots, suggest times)
- Response includes specific time suggestions

#### 5. Light Skill Execution (API-first)
**Test via Telegram:**
> "What is 2 + 2?"

**Expected:**
- If routed via orchestrator, should use light execution
- Check logs for `execution_type: "light"`
- Sub-second response time

**Verify:**
```bash
journalctl --user -u claude-telegram-relay -n 50 | grep "execution_type"
```

#### 6. Heavy Skill Execution (CLI spawn)
**Test via Telegram:**
> "Create a Plane work item: ELLIE-99 - Test pipeline execution"

**Expected:**
- Heavy execution (needs Plane MCP tools)
- execution_type: "heavy"
- CLI spawn with `--allowedTools mcp__plane__*`

**Verify:**
```bash
journalctl --user -u claude-telegram-relay -n 50 | grep -E "execution_type|plane"
```

#### 7. Pipeline Depth Limit (Max 5 Steps)
**Test via Google Chat:**
> "Do a 10-step analysis: Step 1 search X, Step 2 search Y, Step 3 search Z..." (intentionally request >5 steps)

**Expected:**
- Orchestrator caps at 5 steps
- Logs show: `[orchestrator] Pipeline step count limited to 5`

#### 8. Cost Tracking
**Test via Telegram:**
> Send any pipeline request (e.g., research → summarize)

**Verify:**
```bash
# Check execution plan cost tracking
psql $SUPABASE_URL -c "SELECT total_tokens, total_cost_usd FROM execution_plans ORDER BY created_at DESC LIMIT 1;"
```
**Expected:** Non-zero values for tokens and cost

#### 9. Error Handling: Step Failure
**Test:**
> "Search for [intentionally malformed query that will fail]"

**Expected:**
- Pipeline aborts on step failure
- execution_plans.status = "failed"
- Error message logged

#### 10. Artifact Passing Between Steps
**Test via Telegram:**
> "Search for 'Claude API pricing' and tell me the cost per million tokens for Opus"

**Expected:**
- Step 1: research (finds pricing page)
- Step 2: general (extracts specific cost from step 1 output)
- Final response includes exact cost (proves artifact was passed)

**Verify:**
```bash
# Check step outputs in execution plan
psql $SUPABASE_URL -c "SELECT steps FROM execution_plans ORDER BY created_at DESC LIMIT 1;" | jq '.[] | {step_index, agent_name, output: (.output[:100])}'
```

---

## Integration Tests

### Test 1: Skill → Pipeline Flow
**Test via Google Chat:**
> "Find my open Plane work items and create a priority-sorted summary"

**Expected:**
- Classifier matches skill: `plane_query`
- Orchestrator detects pipeline mode
- Step 1: dev agent (fetch issues)
- Step 2: general agent (sort + format)

### Test 2: Multi-Channel Consistency
**Test:**
1. Send pipeline request via Telegram
2. Send same request via Google Chat

**Expected:** Both channels invoke orchestrator correctly

### Test 3: Session Continuity with Pipelines
**Test via Telegram:**
1. "What are my open work items?" (single agent)
2. "Now summarize them" (should use continuity to reference previous output)

**Expected:**
- First message: single-agent mode
- Second message: session continuity works (may or may not trigger pipeline)

---

## Performance Benchmarks

| Scenario | Target Latency | Max Cost |
|----------|----------------|----------|
| Single-agent (baseline) | <5s | $0.01 |
| 2-step pipeline (light → light) | <10s | $0.02 |
| 2-step pipeline (heavy → light) | <30s | $0.05 |
| 3-step pipeline (heavy → heavy → light) | <60s | $0.10 |
| 5-step pipeline (max depth) | <120s | $0.20 |

**Verify:**
```bash
# Check recent execution plans
psql $SUPABASE_URL -c "SELECT mode, array_length(steps, 1) as step_count, total_duration_ms, total_cost_usd FROM execution_plans ORDER BY created_at DESC LIMIT 10;"
```

---

## Regression Tests

### Existing Features (Should Not Break)
1. **Slash commands** — `/dev`, `/finance`, `/research` should bypass orchestrator
2. **Session continuity** — Follow-up messages should resume sessions
3. **Cross-domain override** — Finance question after dev session should switch agents
4. **Google Chat + Telegram** — Both channels work
5. **Voice transcription** — Voice messages still transcribe correctly
6. **Memory/goals/approvals** — Tag processing still works

**Quick Smoke Test:**
```bash
# Send one message to each channel
curl -X POST http://localhost:3001/test/send-telegram -d '{"message": "hello"}'
curl -X POST http://localhost:3001/test/send-gchat -d '{"message": "hello"}'

# Check for errors
journalctl --user -u claude-telegram-relay -n 100 | grep -i error
```

---

## Success Criteria

### ELLIE-53 (Skill Registry)
- ✅ skills table exists with 15+ skills
- ✅ GET /api/skills returns skill catalog
- ✅ Classifier routes to skills (not just agents)
- ✅ Skill context passed to agent dispatch
- ✅ Chain-scoped skill filtering works

### ELLIE-54 (Sequential Pipeline)
- ✅ orchestrator.ts handles pipeline mode
- ✅ Light skills use API-first execution (<500ms)
- ✅ Heavy skills use CLI spawn (full tool access)
- ✅ Artifact passing works between steps
- ✅ execution_plans table logs all pipelines
- ✅ Cost tracking per step accurate
- ✅ Max depth limit enforced (5 steps)
- ✅ At least 3 working pipeline examples tested

---

## Test Commands

### Start Testing
```bash
# Restart relay to ensure latest code
systemctl --user restart claude-telegram-relay

# Watch logs in real-time
journalctl --user -u claude-telegram-relay -f
```

### Check Database State
```bash
# Skills table
psql $SUPABASE_URL -c "SELECT name, agent_name, complexity, enabled FROM skills ORDER BY priority DESC;"

# Recent execution plans
psql $SUPABASE_URL -c "SELECT id, mode, status, total_tokens, total_cost_usd, created_at FROM execution_plans ORDER BY created_at DESC LIMIT 10;"

# Agent sessions with skills
psql $SUPABASE_URL -c "SELECT session_id, agent_name, skill_name, created_at FROM agent_sessions ORDER BY created_at DESC LIMIT 10;"
```

### Clear Test Data
```bash
# Clear execution plans (if needed between test runs)
psql $SUPABASE_URL -c "DELETE FROM execution_plans WHERE created_at > NOW() - INTERVAL '1 hour';"
```

---

## Known Limitations (v1)

1. **Pipeline depth** — Max 5 steps (by design)
2. **No branching** — Sequential only (fan-out is ELLIE-55)
3. **No critic loops** — Iterative refinement is ELLIE-56
4. **Approximate tokens for CLI** — Heavy skills use ~4 chars/token estimate
5. **No DAG visualization yet** — Dashboard timeline view is in ELLIE-57

---

## Next Steps After Testing

If all tests pass:
1. **Mark ELLIE-53 and ELLIE-54 as Done** ✅ (ELLIE-53 already Done)
2. **Move to ELLIE-55** (parallel fan-out)
3. **Document any bugs** as new issues
4. **Update skill registry** with real-world learnings from tests

If tests fail:
1. Log specific failures
2. Fix blocking issues
3. Re-test before moving to ELLIE-55

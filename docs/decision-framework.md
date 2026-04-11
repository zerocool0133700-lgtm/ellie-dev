# Decision Framework — Dave

> How Dave makes decisions, what signals he needs, and how Ellie should support the process. This isn't a decision tree — it's a map of how decisions actually happen.

**Profile:** Dave
**Date:** March 19, 2026
**Document:** 5 of 7

---

## Core Philosophy

**Decisions are about momentum, not perfection.**

Dave doesn't optimize for the "right" answer. He optimizes for:

1. **Speed of course correction** — Can I detect failure fast and pivot?
2. **Preservation of momentum** — Does this decision keep things moving?
3. **Understanding of failure modes** — Do I know what to watch for?

A good decision isn't one that's always right. It's one where you **know what wrong looks like** and can respond before it costs you.

---

## Two Decision Modes

Dave operates in two distinct modes depending on confidence and stakes.

### Mode 1: Fast Decisions

**Trigger:** 90%+ confidence with clear monitoring thresholds

**How it works:**
- Quick evaluation of available data
- Execute immediately
- Monitor known signals for course correction
- Adjust fast if signals trip

**What enables this mode:**
- Familiar domain — he's seen this pattern before
- Clear monitoring — he knows what "going wrong" looks like
- Low switching cost — pivoting doesn't break momentum
- High signal-to-noise — the data is clean, not ambiguous

**Example:** Choosing a technical approach in a familiar codebase. He's done this before, knows the tradeoffs, and can spot problems in a PR review.

### Mode 2: Gated Decisions

**Trigger:** Lower confidence, higher stakes, or unclear failure modes

**How it works:**
- Gather more data before committing
- Build understanding of monitoring signals
- Increase confidence AND understanding simultaneously
- Only commit when he can articulate what to watch for

**What triggers this mode:**
- Unfamiliar territory — new systems, new domains
- High blast radius — mistakes are expensive to reverse
- Unclear monitoring — he doesn't know what failure looks like yet
- Ambiguous data — signals conflict or are hard to read

**Example:** Choosing architecture for a new subsystem. He needs to understand not just which approach is better, but what happens when each approach breaks and how he'd detect it.

### The Critical Difference

Most people think gated decisions are about **higher confidence**. For Dave, they're about **higher understanding**.

- ❌ "I'm 95% sure this will work" (confidence without understanding)
- ✅ "I'm 80% sure this will work, and if it doesn't, I'll see X signal within Y timeframe" (understanding with monitoring)

The second position is **stronger** even at lower confidence because it preserves the ability to course-correct and maintain momentum.

---

## Decision Inputs

### What Dave Needs to Decide

Not every decision needs all of these. But the higher the stakes, the more of these matter.

| Input | Purpose | When It Matters |
|-------|---------|-----------------|
| **Options with tradeoffs** | See the landscape, not just one path | Always |
| **Failure modes per option** | Know what "wrong" looks like for each | High stakes |
| **Monitoring signals** | Know what to watch after deciding | High stakes |
| **Reversibility assessment** | How hard is it to undo? | Gated decisions |
| **Momentum impact** | Will this create a hard stop? | Always |
| **Prior art** | Have we or others done this before? | Unfamiliar territory |

### What Dave Does NOT Need

- **Excessive hedging** — Don't present 12 options when 3 are real contenders
- **Analysis paralysis support** — Don't add data that doesn't change the decision
- **Artificial certainty** — Don't pretend confidence you don't have
- **Consensus seeking** — He values input but doesn't need everyone to agree

---

## How Decisions Flow

### Stage 1: Frame the Decision

**What happens:** Define what's actually being decided. Separate real decisions from preferences and non-decisions.

**Dave's pattern:**
- Cuts through framing quickly — doesn't overthink what the decision is
- Distinguishes between "this matters" and "this is noise"
- Prefers to see constraints first, then options

### Stage 2: Gather Data (When Needed)

**For fast decisions:** This stage is near-instant. He already has the data from experience.

**For gated decisions:**
- Research is focused, not exhaustive
- He looks for **disconfirming evidence**, not just supporting data
- Stops gathering when he can articulate failure modes, not when he's "sure"

### Stage 3: Evaluate Options

**How Dave evaluates:**
- **Non-binary thinking** — Options aren't right/wrong, they're tradeoff profiles
- **Triple constraint awareness** — Scope, time, resources are always in tension
- **Momentum lens** — Which option keeps things moving?
- **Failure mode comparison** — Which failures are more survivable?

**What he wants from Ellie:**
- Present 2-3 real options with clear tradeoffs
- Bold the key differentiator between options
- Include what to watch for with each option
- Flag which option preserves momentum best

### Stage 4: Commit and Monitor

**Fast decisions:** Commit immediately, monitor passively.

**Gated decisions:** Commit when monitoring signals are clear, monitor actively for a defined period.

**After committing:**
- Don't second-guess unless monitoring signals trip
- Course-correct fast when they do
- Don't restart the evaluation — adjust the current path

---

## Decision Categories

Different types of decisions get different treatment.

### Technical Decisions

- Usually fast mode (familiar territory)
- Delegate implementation details to agents freely
- Care about architecture more than implementation
- **Signal for escalation:** "This changes something foundational"

### Strategic Decisions

- Usually gated mode (higher stakes, broader impact)
- Wants to think through implications before committing
- Benefits from brainstorming and what-if scenarios
- **Signal for escalation:** "This affects the product direction"

### Operational Decisions

- Fast mode by default — keep things running
- Agents should handle most of these autonomously
- Only escalate on novel failures or pattern breaks
- **Signal for escalation:** "This isn't a known failure mode"

### People & Relationship Decisions

- Always gated — these aren't reversible
- Values directness but has learned to soften delivery
- Will let someone try the wrong path if the cost is low (strategic failure as teaching)
- **Signal for escalation:** "This affects trust"

---

## How Ellie Should Support Decisions

### Present Options, Not Recommendations (by Default)

Dave wants to see the landscape and decide. Lead with options and tradeoffs, not a single recommendation.

**Exception:** When Dave asks "what do you think?" or "what would you do?" — then give a clear recommendation with reasoning.

### Always Include Monitoring Signals

For any significant decision, include:
- **What to watch for** — Specific signals that indicate success or failure
- **When to check** — Timeframe for when signals would become visible
- **What to do if it fails** — The course-correction path

### Respect the Two Modes

**When Dave is in fast mode:**
- Don't slow him down with excessive analysis
- Present clean options, let him pick and move
- Trust his instincts in familiar territory

**When Dave is in gated mode:**
- Help build understanding, not just confidence
- Surface failure modes he might not have considered
- Don't rush to a recommendation — help him get there

### Protect Momentum Through Decisions

- **Frame decisions as momentum-preserving** when possible
- **Flag hard stops early** — if a decision will break flow, say so upfront
- **Offer reversible defaults** — "We could start with X and switch to Y if we see Z"
- **Batch small decisions** — don't make him decide 10 things when 3 matter

### Match His Non-Binary Thinking

- Don't present right/wrong framings
- Use "tradeoff" language instead of "correct" language
- Acknowledge uncertainty honestly — "I'm not sure, but here's what I'd watch for"
- When pushing back, frame as "I see it differently" not "that's wrong"

---

## Decision Anti-Patterns

Things that break Dave's decision flow:

| Anti-Pattern | Why It Fails | What to Do Instead |
|-------------|-------------|-------------------|
| **Presenting one option as "the answer"** | Removes agency, feels prescriptive | Present 2-3 options with tradeoffs |
| **Excessive hedging** | Creates noise, buries the signal | Be direct about uncertainty levels |
| **Binary framing** | Doesn't match how he thinks | Use spectrum/tradeoff language |
| **Artificial urgency** | Pressure without real constraint is noise | Only flag real deadlines |
| **Surprise blockers** | Breaks momentum, creates frustration | Surface risks early |
| **Revisiting settled decisions** | Momentum killer | Only revisit if monitoring signals trip |
| **Data dumps without synthesis** | Cognitive load, not useful | Synthesize, then offer detail on request |

---

## When Dave Says "Just Do It"

This means he's in fast mode and trusts the agent's judgment. Appropriate response:

- Execute without additional confirmation
- Log what was decided (for future reference)
- Monitor for issues
- Only interrupt if something unexpected happens

**This is not blanket authorization.** It applies to the current decision context. New contexts still need their own evaluation.

---

## Course Correction Protocol

When a decision isn't working:

1. **Detect** — Monitoring signal trips
2. **Assess** — Is this a tweak or a pivot?
3. **Decide** — Small adjustment vs. new approach
4. **Execute** — Make the change, don't deliberate
5. **Update monitoring** — New signals for the new path

**Key principle:** Course correction is cheap when monitoring is in place. The investment is in the monitoring, not in being right the first time.

---

## Decision Memory

Decisions should be recorded when they're significant enough that future sessions would benefit from knowing:

- **What was decided** — The choice made
- **Why** — The reasoning (especially what was traded off)
- **What to watch for** — Monitoring signals that were identified
- **Context** — What made this the right call at the time

**Where:** Forest bridge (type: `decision`) for institutional knowledge. Working memory for session-scoped decisions.

---

## Document Status

**Version:** 1.0
**Last Updated:** March 19, 2026
**Data Sources:**
- Cognitive Operating Profile interview (Mar 19, 2026)
- Collaboration & Feedback Operating Profile (Mar 19, 2026)
- Historical context from life context system
- Observed patterns from work sessions

**Next Steps:**
- Validate against real decision scenarios
- Refine with ongoing observations
- Migrate to River vault when all 7 foundational documents are complete

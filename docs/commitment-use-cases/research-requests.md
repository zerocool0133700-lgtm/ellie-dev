# Research Requests — Behavioral Use Case

**Use Case:** Handling research and information gathering requests
**System:** Brave Search MCP + Web Fetch + Agent Router
**Relevant Agents:** `research` (primary), `general` (triage)

---

## When This Use Case Applies

Trigger this workflow when the user:

- **Explicitly asks for research:** "Research X", "Find out about Y", "What are the options for Z"
- **Asks a knowledge question you don't know:** "What's the best way to do X in 2026?", "How does Y work?"
- **Requests evidence or data:** "Show me examples of X", "Find case studies on Y"
- **Needs current information:** "What's the latest on X?", "Is Y still recommended?"
- **Requests comparison:** "Compare X and Y", "What are the pros/cons of Z?"

**Do NOT trigger for:**
- Questions you can answer directly from your training or context
- Simple factual lookups (dates, definitions, syntax)
- User is just thinking out loud, not requesting research

---

## Research Workflow

### 1. Clarify the Request

Before diving in, understand what the user actually needs:

**Ask clarifying questions if unclear:**
- **Scope:** "Are you looking for technical details, high-level overview, or specific examples?"
- **Depth:** "Do you want a quick summary or a deep dive?"
- **Use case:** "What are you trying to accomplish with this information?"
- **Constraints:** "Any specific timeframe, technology, or industry focus?"

**Don't over-clarify:**
- If the request is clear, just start researching
- If you need one clarifying detail, ask inline: "Researching X — do you want the free or paid options?"

---

### 2. Gather Sources

**Search strategy:**

1. **Start broad:** Use Brave Search to gather initial sources
   ```
   mcp__brave-search__brave_web_search("query keywords")
   ```

2. **Evaluate source quality:** Prioritize:
   - Official documentation (for technical topics)
   - Recent articles (published within last 12 months for fast-moving fields)
   - Reputable sources (established publications, industry leaders)
   - Primary sources over secondary (original research over blog summaries)

3. **Fetch full content:** For promising sources, use WebFetch to read the full article
   ```
   WebFetch("https://example.com/article")
   ```

4. **Cross-reference:** Confirm findings across 2-3 sources (don't rely on a single article)

**Source quality hierarchy:**

| Tier | Source Type | Trust Level | Use When |
|------|-------------|-------------|----------|
| **1** | Official docs, academic papers, primary research | High | Technical accuracy matters |
| **2** | Reputable tech publications (Ars Technica, The Verge), industry blogs | Medium-High | Current trends, best practices |
| **3** | General news, aggregator sites, forums (Reddit, HN) | Medium | Crowd sentiment, real-world experience |
| **4** | Personal blogs, social media, unverified claims | Low | Supplemental only, flag as unverified |

**Red flags:**
- Source is 3+ years old (for fast-moving tech topics)
- Source has obvious bias or agenda
- Source lacks author attribution or publication date
- Claims are extraordinary but lack evidence

---

### 3. Analyze & Synthesize

Don't just dump links. **Extract insights:**

**Good analysis includes:**
- **Key findings:** What are the main takeaways?
- **Consensus vs. debate:** Where do sources agree? Where do they differ?
- **Trade-offs:** What are the pros and cons of each approach?
- **Relevance:** How does this apply to the user's situation?
- **Confidence level:** How certain are you about these findings?

**Example of good synthesis:**

> **Research: Best Node.js API frameworks in 2026**
>
> **Key findings:**
> - **Express.js** still dominant (62% usage), but considered "legacy stable" — mature, well-documented, but not innovating
> - **Fastify** gaining traction (28% usage) — 2x faster than Express, modern async/await patterns, strong typing support
> - **Hono** emerging (10% usage) — edge-first design, works on Cloudflare Workers, very lightweight
>
> **Trade-offs:**
> - Express: Best for teams with existing Express experience, huge ecosystem, but slower performance
> - Fastify: Best for greenfield projects prioritizing speed and TypeScript, smaller ecosystem
> - Hono: Best for edge deployments (Cloudflare, Deno), still maturing
>
> **Recommendation:** For your use case (existing Express project), stay with Express unless performance is a bottleneck. If starting fresh, Fastify is the safe modern choice.
>
> **Sources:** [3 articles linked]

---

### 4. Format & Deliver

**Default format: Structured summary**

Use this template:

```markdown
**Research: [Topic]**

**Key Findings:**
- [Point 1]
- [Point 2]
- [Point 3]

**Options/Approaches:**
1. **Option A** — Pros: X, Cons: Y, Best for: Z
2. **Option B** — Pros: X, Cons: Y, Best for: Z

**Recommendation:** [Your take, based on user's context]

**Sources:** [Links to 2-5 primary sources]
```

**Adapt format to request:**

| Request Type | Format |
|--------------|--------|
| "What is X?" | Definition + context + why it matters |
| "Compare X and Y" | Side-by-side table with criteria |
| "Should I use X?" | Pros/cons + recommendation |
| "How does X work?" | Step-by-step explanation with examples |
| "What are the options for X?" | Numbered list with trade-offs |
| "Find examples of X" | 3-5 curated examples with brief context |

**Tables are your friend:**

Use tables for comparisons, feature matrices, or multi-criteria decisions.

**Example:**

| Framework | Speed | TypeScript | Ecosystem | Edge Support | Best For |
|-----------|-------|------------|-----------|--------------|----------|
| Express | Medium | Partial | Huge | No | Legacy projects, large teams |
| Fastify | Fast | Native | Growing | No | New projects, performance-critical |
| Hono | Very Fast | Native | Small | Yes | Edge deployments, Cloudflare |

---

### 5. Follow-Up

After delivering research, offer next steps:

- **Clarification:** "Want me to dig deeper into any of these?"
- **Action:** "Want me to create a GTD task to evaluate these options?"
- **Delegation:** "Should I have the dev agent prototype option A?"

**Don't disappear after dropping research.** Stay engaged to see if it answered the question.

---

## When to Delegate to Research Agent

**General agent handles:**
- Quick lookups (1-2 searches, < 5 minutes)
- Simple factual questions
- User just needs a link or a quick summary

**Research agent handles:**
- Deep research (5+ sources, synthesis required)
- Comparative analysis (evaluating multiple options)
- Evidence-based recommendations
- Current state of a field (trends, best practices, emerging tech)

**Delegation pattern:**

```
User: "Research the best database for time-series data"

General Agent:
  - Recognizes this is a deep research task
  - Routes to research agent
  - Notifies user: "Handing this to Kate (research agent) — she'll gather options and analysis."

Research Agent:
  - Searches for time-series database options
  - Evaluates: InfluxDB, TimescaleDB, Prometheus, QuestDB
  - Compares features, performance, use cases
  - Delivers structured report with recommendation
```

---

## Source Citation

Always cite sources. Two formats:

### Inline Citations (for short reports)

> **Key Finding:** Node.js 22 LTS released in October 2025 ([source](https://nodejs.org/blog)).

### End Citations (for longer reports)

> **Sources:**
> 1. [Node.js 22 Release Notes](https://nodejs.org/blog/release-22) — Official announcement
> 2. [Fastify vs Express Benchmark](https://fastify.io/benchmarks) — Performance comparison
> 3. [Hono Edge Framework Guide](https://hono.dev/docs) — Official documentation

**Why citation matters:**
- User can verify your findings
- User can go deeper if interested
- Builds trust (you're not making stuff up)

---

## Confidence Levels

Tag your research with confidence:

| Level | Meaning | When to Use |
|-------|---------|-------------|
| **High** | Multiple reputable sources agree, recent data | Well-established facts, official docs |
| **Medium** | 2-3 sources agree, some conflicting info | Emerging consensus, industry practices |
| **Low** | Limited sources, conflicting data, anecdotal | Cutting-edge topics, niche fields |
| **Speculative** | No solid sources, educated guess | Hypothetical scenarios, future predictions |

**Example:**
> **Confidence:** Medium — Two major sources agree Fastify is faster than Express, but real-world benchmarks vary by use case.

**If confidence is low, say so:**
> I found limited recent data on this — most articles are from 2023. Take these findings as directional, not definitive.

---

## Research Quality Checklist

Before delivering research, verify:

- [ ] **Answered the question:** Did I actually address what the user asked?
- [ ] **Cited sources:** Are all claims backed by links?
- [ ] **Synthesized, not dumped:** Did I extract insights, or just list links?
- [ ] **Relevant to user:** Does this apply to their situation/project?
- [ ] **Formatted clearly:** Can they scan this on a phone?
- [ ] **Confidence tagged:** Did I note how certain I am?
- [ ] **Follow-up offered:** Did I ask if they need more?

---

## Edge Cases & Exceptions

### No Good Sources Found

**Q:** Search returns no relevant or trustworthy results.
**A:** Report it honestly:
> I searched for X but didn't find reliable recent sources. The most recent info I found is from 2023, which may be outdated. Want me to search with different terms, or is this too niche?

### Conflicting Information

**Q:** Sources disagree on key facts.
**A:** Present both sides:
> **Conflicting info:** Source A claims X is faster, Source B claims Y is faster. This likely depends on use case — X may be faster for small datasets, Y for large.

### Paywall Blocking

**Q:** Best source is behind a paywall.
**A:** Note it:
> The most authoritative source (IEEE paper on X) is paywalled. I found a summary here [free source], but it's secondary. Want me to keep searching?

### User Asks for Opinion

**Q:** "What do YOU think is the best option?"
**A:** Give your take, but frame it:
> **My take:** Based on your use case (real-time analytics), I'd go with TimescaleDB — it's battle-tested and has strong PostgreSQL compatibility. But if you're optimizing for write throughput over query flexibility, QuestDB is worth testing.

### Research Sprawls

**Q:** Research keeps expanding (5 hours in, still finding more).
**A:** Checkpoint and ask:
> I've gathered a lot here — 10 sources, 5 options. Want me to keep going, or should I synthesize what I have and deliver a report now?

---

## Anti-Patterns (What NOT to Do)

❌ **Link dumping**
- Don't just paste 10 URLs and say "here you go"
- Extract insights, synthesize findings

❌ **Citing without reading**
- Don't link to sources you didn't actually read
- User will ask follow-ups you can't answer

❌ **Recency bias**
- Don't assume newer is always better
- Sometimes the 2022 guide is more thorough than the 2026 tweet

❌ **Ignoring user context**
- Don't research "best database" without knowing their use case
- Generic research is low-value

❌ **Overconfidence**
- Don't present speculative findings as fact
- Tag confidence level

❌ **No recommendation**
- Don't just list options and leave the user to decide
- Offer a recommendation based on their context

❌ **Forgetting to follow up**
- Don't drop research and disappear
- Ask if it answered the question

---

## Quick Reference: Research Checklist

When handling a research request:

- [ ] Clarify the request (scope, depth, use case)
- [ ] Search broadly (Brave Search)
- [ ] Evaluate source quality (official docs > blogs > forums)
- [ ] Fetch full content (WebFetch for promising sources)
- [ ] Cross-reference (2-3 sources minimum)
- [ ] Synthesize findings (don't just list links)
- [ ] Format clearly (structured summary, tables, bullets)
- [ ] Cite sources (inline or end citations)
- [ ] Tag confidence (high, medium, low, speculative)
- [ ] Offer recommendation (based on user context)
- [ ] Follow up ("Want me to dig deeper?")

---

## Integration with Other Systems

- **GTD:** Create tasks for follow-up research or action items from findings
- **Plane:** Research can inform ticket scope and design decisions
- **Forest:** Log research findings to Forest so future sessions can reference them
- **Work Sessions:** Large research efforts can trigger formal work sessions

---

**Version:** 1.0
**Last Updated:** 2026-03-19
**Author:** Ellie (general)
**Status:** Active use case — part of Commitment Framework

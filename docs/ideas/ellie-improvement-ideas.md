# Ellie Improvement Ideas

> Collected Feb 19, 2026 — inspired by reviewing other voice agent architectures and analyzing Feb 19 operational data.

## Quick Wins

### Digest Mode
Batch low-priority notifications into a single summary every N minutes instead of firing individually. Would prevent alert storms like the 42-message spike in 32 minutes during the Feb 19 stabilization sprint.

### Channel Routing Preferences
Let Dave set rules like "urgent = GChat, FYI = Telegram, nothing = Alexa" so messages find the right channel automatically. Currently all channels fire independently with no routing intelligence.

## Medium Lifts

### Voice Memory Enrichment
Voice channel works (8/8 exchanges on Feb 19) but conversations there probably aren't feeding back into the memory system as richly as text. Could be a differentiator vs other voice agent stacks that have zero memory.

### Agent Work Summaries / Rollups
Instead of 148 individual session notifications, produce a single "here's what your agents accomplished in the last hour" rollup. Reduces noise, increases signal.

## Bigger Bets

### Proactive Context Injection
When Dave starts talking about a topic, Ellie pulls relevant memories, recent tickets, and related conversations *before* he asks. Like a briefing that assembles itself based on conversation trajectory.

### Cross-Agent Learning
When one dev agent discovers something (like the respondedSync bug), that insight automatically becomes available to other agents without Dave relaying it manually. Shared discovery propagation.

## Meta Observation

Ellie's *capabilities* are strong. The next frontier is **intelligence about when and how to communicate** — which is exactly what ELLIE-80 (notification cadence) is about. The pattern: collect UX ideas from other people's stacks even when their architecture is weaker — they sometimes stumble onto patterns worth stealing.

## External Stack Comparison (Feb 19)

Reviewed a voice agent stack posted online:
- **Orchestration:** Pipecat + RTVI protocol (WebSocket transport)
- **STT/TTS:** Speechmatics (free tier: 480 min STT + 1M chars TTS)
- **LLM:** OpenRouter → Llama 3.3 70B Instruct

**Assessment:** Optimized for "cheapest possible" not "best possible." Weakest links are LLM choice (70B open model vs Claude) and zero memory layer. Ellie's stack (Groq Whisper + ElevenLabs + Claude + Supabase memory) is stronger across the board. Worth watching Speechmatics and RTVI protocol as potential components though.

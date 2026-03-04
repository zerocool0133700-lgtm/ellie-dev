# OpenClaw vs. Ellie Relay — Architecture Comparison

**Date:** March 3, 2026
**Context:** After ~90min of chat instability and QMD permission loops, Dave requested architectural analysis comparing our relay/gateway against Claude Code's proven patterns.

---

## Executive Summary

**OpenClaw** (Claude Code's gateway) is a **production-grade multi-channel orchestration system** handling 15+ messaging channels with battle-tested resilience patterns. **Ellie Relay** is a **single-process all-in-one bot** that evolved from a Telegram bot into a multi-channel coordinator. Both handle similar problems (multi-channel messaging, context gathering, agent dispatch), but OpenClaw's architecture has **3+ years of production hardening** that we can learn from.

**Key findings:**

| **Pattern** | **OpenClaw** | **Ellie Relay** | **Winner** |
|-------------|-------------|----------------|------------|
| **Channel isolation** | Plugin-based, each channel is independent async task with own AbortController | Single process, all channels share state | OpenClaw |
| **Error boundaries** | Each channel has independent error handling + health monitor | No error boundaries — Promise.all cascades failures | OpenClaw |
| **Restart resilience** | Exponential backoff (5s → 5min), max 10 attempts, rate-limited (3/hour), cooldown between restarts | No automatic restart, manual systemd restart required | OpenClaw |
| **Context gathering** | Not applicable (gateway doesn't gather AI context) | Promise.all — single timeout kills entire request | N/A (different scope) |
| **Health monitoring** | Dedicated ChannelHealthMonitor runs every 5min, independent of main loop | No health monitoring — relies on systemd | OpenClaw |
| **Startup safety** | 60s grace period before health checks start, explicit ready state | No readiness gate — periodic tasks can fire before deps are ready | OpenClaw |
| **Config reload** | Hot-reload without restart, versioned config snapshots | Requires full relay restart | OpenClaw |
| **Logging** | Subsystem loggers (gateway, channels, health, cron, plugins) — structured, filterable | Single logger, flat structure | OpenClaw |
| **Message queue** | Lane-based concurrency, queue per channel | Two shared queues (main, ellie-chat) with busy flags | OpenClaw |

---

## Core Architectural Differences

### 1. Channel Abstraction

**OpenClaw:**
- **Plugin system** — each channel (Telegram, Slack, Discord, WhatsApp, etc.) is a self-contained plugin
- Plugin provides:
  - `startAccount()` / `stopAccount()` lifecycle hooks
  - Config adapter (listAccountIds, resolveAccount, isEnabled, isConfigured)
  - Status adapter (runtime snapshot)
  - Threading adapter, mention adapter, command adapter
- Channels run as **independent async tasks** with their own AbortController
- Failure in one channel **does not affect others**

**Ellie Relay:**
- **Monolithic integration** — Telegram, Google Chat, Ellie Chat all wired directly into relay.ts
- Channels share:
  - The same Express server
  - The same message queue
  - The same global state (bot instance, supabase client, etc.)
- Failure in context gathering or queue processing **affects all channels**

**Lesson:**
> **Plugin-based isolation prevents cascade failures.** When Telegram crashes, Slack keeps running. When context gathering times out, the gateway stays healthy.

---

### 2. Error Boundaries

**OpenClaw:**
- **Independent error handling per channel** — each `startAccount()` task is wrapped in its own error boundary
- Health monitor detects stuck/failed channels and restarts them **without affecting others**
- Exponential backoff with jitter (5s → 10s → 20s → 40s → ... → 5min max)
- Max 10 restart attempts before giving up
- Rate-limited restarts: max 3/hour per channel

```typescript
// Simplified from server-channels.ts
const task = startAccount({ cfg, accountId, runtime, abortSignal, log })
  .catch(async (err) => {
    const currentAttempts = restartAttempts.get(rKey) ?? 0;
    if (currentAttempts >= MAX_RESTART_ATTEMPTS) {
      log.error('Max restart attempts reached, giving up');
      setRuntime(channelId, accountId, { running: false, lastError: 'max-restarts' });
      return;
    }
    const backoffMs = computeBackoff(CHANNEL_RESTART_POLICY, currentAttempts);
    await sleepWithAbort(backoffMs, abortSignal);
    if (!abortSignal.aborted) {
      restartAttempts.set(rKey, currentAttempts + 1);
      await startChannelInternal(channelId, accountId, { preserveRestartAttempts: true });
    }
  });
```

**Ellie Relay:**
- **No error boundaries** — errors propagate up and kill the entire request/queue
- Context gathering uses `Promise.all()` at line 908 of context-sources.ts:
  ```typescript
  const entries = await Promise.all(
    sourceNames.map(async (name) => {
      const content = await SOURCE_REGISTRY[name](supabase);
      // ...
    })
  );
  ```
  If **any single context source** (Forest, calendar, Gmail, tasks, etc.) times out or throws, **the entire context load fails** and the chat request dies.
- No automatic restart — relies on systemd service recovery
- Periodic tasks (14+ `setInterval` calls) have individual try/catch but no backoff or rate limiting

**Lesson:**
> **Use `Promise.allSettled()` instead of `Promise.all()` for parallel context gathering.** A Forest timeout should not kill the entire chat response.

---

### 3. Health Monitoring

**OpenClaw:**
- **Dedicated ChannelHealthMonitor** (`channel-health-monitor.ts`)
- Runs every 5 minutes (configurable)
- **Startup grace period:** 60 seconds before first check (lets channels stabilize)
- **Cooldown period:** 10 minutes between restarts (2 cycles × 5min)
- **Rate limiting:** Max 3 restarts per hour per channel
- Tracks:
  - `running` — is the channel task alive?
  - `connected` — is the channel connected to the remote service?
  - `enabled` — is the channel enabled in config?
  - `configured` — does the channel have valid credentials?
- Only restarts **unhealthy managed accounts** (enabled + configured but not running/connected)
- Respects **manual stops** — if user stopped a channel, health monitor won't restart it

```typescript
// From channel-health-monitor.ts
export function startChannelHealthMonitor(deps: ChannelHealthMonitorDeps) {
  const startedAt = Date.now();
  const timer = setInterval(async () => {
    const now = Date.now();
    if (now - startedAt < startupGraceMs) return; // Grace period

    const snapshot = channelManager.getRuntimeSnapshot();
    for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
      for (const [accountId, status] of Object.entries(accounts)) {
        if (!isChannelHealthy(status)) {
          // Check cooldown, rate limits, then restart
          await channelManager.stopChannel(channelId, accountId);
          await channelManager.startChannel(channelId, accountId);
        }
      }
    }
  }, checkIntervalMs);
  return { stop };
}
```

**Ellie Relay:**
- **No health monitoring** — relies entirely on systemd service watchdog
- No automatic channel restart
- No health checks for:
  - Telegram bot connectivity
  - Google Chat webhook availability
  - Supabase connection health
  - Forest Bridge availability
- If a channel disconnects, it stays disconnected until manual restart

**Lesson:**
> **Health monitoring should be independent of the main process.** Don't wait for systemd — detect and recover from failures automatically with rate limits and backoff.

---

### 4. Startup Safety

**OpenClaw:**
- **Explicit readiness gate** — services don't start accepting traffic until dependencies are confirmed ready
- Health monitor has **60s grace period** before first check
- Startup sequence:
  1. Load config
  2. Initialize gateway server (WebSocket/HTTP)
  3. Start plugins
  4. Start channels (with exponential backoff if initial connect fails)
  5. Mark as ready
  6. Enable health monitoring
- Periodic tasks (cron, maintenance) only run **after ready state**

**Ellie Relay:**
- **No readiness gate** — services start immediately
- **Race conditions possible:** periodic tasks (14+ `setInterval` calls) can fire before dependencies are ready
  - Example: creature reaper fires at 5min even if Forest isn't connected yet
  - Example: calendar sync fires at 10s even if Google auth hasn't completed
- Initial calendar sync at line 224 fires **10 seconds after startup**, regardless of readiness

```typescript
// From relay.ts line 224
setTimeout(async () => {
  await syncAllCalendars(); // Fires regardless of Google auth state
}, 10_000);
```

**Lesson:**
> **Don't start periodic tasks until dependencies are confirmed ready.** Add a `ready` flag and gate all timers behind it.

---

### 5. Context Gathering Resilience

**OpenClaw:**
- N/A — OpenClaw is a **gateway/router**, not an AI agent. It doesn't gather AI context.
- However, it **does** handle parallel operations (multiple channel health checks, multiple account refreshes) using `Promise.allSettled()` when failures must not cascade.

**Ellie Relay:**
- **Context gathering is a critical path** — every Ellie Chat response requires context (goals, facts, calendar, tasks, Forest, etc.)
- Uses `Promise.all()` to fetch 15+ context sources in parallel (context-sources.ts line 908)
- **Single point of failure:** If Forest times out (3s), calendar fetch fails, or any other source throws → **entire chat request fails**
- No fallback, no cached context, no graceful degradation

**Current code (context-sources.ts):**
```typescript
const entries = await Promise.all(
  sourceNames.map(async (name) => {
    const content = await SOURCE_REGISTRY[name](supabase);
    return { name, content };
  })
);
```

**Better pattern (stolen from OpenClaw's health checks):**
```typescript
const entries = await Promise.allSettled(
  sourceNames.map(async (name) => {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 3000)
    );
    const content = await Promise.race([SOURCE_REGISTRY[name](supabase), timeoutPromise]);
    return { name, content };
  })
);

// Filter successful results, log failures
const successful = entries
  .map((result, i) => {
    if (result.status === 'fulfilled') return result.value;
    logger.warn(`Context source ${sourceNames[i]} failed: ${result.reason}`);
    return { name: sourceNames[i], content: '' }; // Empty fallback
  });
```

**Lesson:**
> **Use `Promise.allSettled()` for parallel context fetches.** Graceful degradation > complete failure.

---

### 6. Configuration Reload

**OpenClaw:**
- **Hot-reload without restart** — config changes are detected and applied live
- `config-reload.ts` — watches config file for changes
- Versioned config snapshots — each reload creates a new snapshot, old one stays valid until all references are released
- Channels can reload config **without restarting the gateway**

**Ellie Relay:**
- **Requires full restart** for any config change
- No hot-reload
- `.env` changes require `systemctl --user restart claude-telegram-relay`

**Lesson:**
> **Hot-reload is a quality-of-life feature** but not critical for our use case (single-user, infrequent config changes). Low priority.

---

### 7. Message Queue Architecture

**OpenClaw:**
- **Lane-based concurrency** — each channel can have its own queue/lane
- Independent processing per lane
- No shared "busy" flags across lanes

**Ellie Relay:**
- **Two shared queues:**
  1. Main message queue (Telegram, Google Chat)
  2. Ellie Chat queue (dashboard messages)
- Separate `busy` flags but **broadcast combined status**
- Race conditions possible when both queues process simultaneously

**Lesson:**
> **Consolidate to a single queue with atomic state transitions.** Current dual-queue design creates race conditions and complexity for minimal benefit.

---

## Specific Patterns to Steal

### Pattern 1: Channel Plugin System

**What:**
```typescript
type ChannelPlugin = {
  id: ChannelId;
  config: {
    listAccountIds: (cfg: Config) => string[];
    resolveAccount: (cfg: Config, id: string) => AccountConfig;
    isEnabled: (account: AccountConfig, cfg: Config) => boolean;
    isConfigured: (account: AccountConfig, cfg: Config) => Promise<boolean>;
  };
  gateway: {
    startAccount: (opts: StartAccountOpts) => Promise<void>;
    stopAccount: (accountId: string) => Promise<void>;
  };
  status: {
    defaultRuntime: () => ChannelAccountSnapshot;
  };
};
```

**Why:**
- **Isolation** — each channel is self-contained
- **Testability** — mock a channel plugin without touching the gateway
- **Extensibility** — add new channels without modifying core relay code

**Apply to Ellie Relay:**
- Extract Telegram integration into `src/channels/telegram.ts` plugin
- Extract Google Chat into `src/channels/google-chat.ts` plugin
- Extract Ellie Chat into `src/channels/ellie-chat.ts` plugin
- Create `src/channels/manager.ts` — orchestrates all channel plugins
- Main relay.ts becomes **thin orchestrator** that delegates to channel manager

---

### Pattern 2: Channel Health Monitor

**What:**
```typescript
export function startChannelHealthMonitor(deps: {
  channelManager: ChannelManager;
  checkIntervalMs?: number;
  startupGraceMs?: number;
  cooldownCycles?: number;
  maxRestartsPerHour?: number;
}): { stop: () => void };
```

**Why:**
- **Automatic recovery** from transient failures
- **Rate-limited** to prevent restart loops
- **Independent** — doesn't block the main loop

**Apply to Ellie Relay:**
- Create `src/channel-health-monitor.ts`
- Check every 5 minutes:
  - Is Telegram bot connected? (ping Telegram API)
  - Is Google Chat receiving webhooks? (check last received message timestamp)
  - Is Supabase reachable? (simple SELECT 1 query)
  - Is Forest Bridge responding? (health check endpoint)
- If unhealthy → restart channel (with backoff + rate limits)
- Log health events to Forest for observability

---

### Pattern 3: Exponential Backoff with Jitter

**What:**
```typescript
type BackoffPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};

function computeBackoff(policy: BackoffPolicy, attempt: number): number {
  const base = Math.min(policy.initialMs * Math.pow(policy.factor, attempt), policy.maxMs);
  const jitterAmount = base * policy.jitter * (Math.random() - 0.5) * 2;
  return Math.max(0, base + jitterAmount);
}
```

**Why:**
- **Prevents thundering herd** — multiple services restarting at same time
- **Gives remote services time to recover** — don't hammer a failing API
- **Exponential scaling** — first retry is fast, later retries are slow

**Apply to Ellie Relay:**
- Use for:
  - Channel reconnect attempts
  - Forest Bridge retries
  - Context source timeouts
  - Periodic task failures

---

### Pattern 4: AbortController per Channel

**What:**
```typescript
const abort = new AbortController();
store.aborts.set(accountId, abort);

const task = startAccount({
  accountId,
  abortSignal: abort.signal,
  // ...
});

// Later, on shutdown or restart:
abort.abort();
await task; // Clean shutdown
```

**Why:**
- **Clean shutdown** — no orphaned tasks
- **Cancellation propagation** — long-running operations can check `abortSignal.aborted`
- **No memory leaks** — tasks clean up properly

**Apply to Ellie Relay:**
- Each channel gets its own AbortController
- Each periodic task gets an AbortController
- On relay shutdown, abort all controllers → wait for tasks to finish → exit
- No more zombie processes or hanging timers

---

### Pattern 5: Subsystem Loggers

**What:**
```typescript
const log = createSubsystemLogger("gateway");
const logChannels = log.child("channels");
const logHealth = log.child("health");
const logCron = log.child("cron");
```

**Why:**
- **Filterable logs** — `journalctl --user -u relay | grep "\[health\]"`
- **Structured context** — each subsystem has its own metadata
- **Performance** — can disable verbose subsystems in production

**Apply to Ellie Relay:**
- Replace flat logger with subsystem loggers:
  - `[telegram]` — Telegram bot logs
  - `[gchat]` — Google Chat logs
  - `[ellie-chat]` — Dashboard WebSocket logs
  - `[forest]` — Forest Bridge logs
  - `[context]` — Context gathering logs
  - `[health]` — Health monitoring logs
  - `[orchestrator]` — Agent dispatch logs

---

### Pattern 6: Startup Readiness Gate

**What:**
```typescript
let ready = false;
const readyPromise = new Promise<void>(resolve => {
  // Wait for all deps
  Promise.all([
    initSupabase(),
    connectTelegram(),
    loadConfig(),
    // ...
  ]).then(() => {
    ready = true;
    resolve();
  });
});

// Don't start periodic tasks until ready
await readyPromise;
startPeriodicTasks();
```

**Why:**
- **No race conditions** — tasks don't fire before deps are ready
- **Graceful startup** — users see clear "starting..." vs "ready" state
- **Debuggability** — if startup hangs, we know which dep is blocking

**Apply to Ellie Relay:**
- Add `ready` flag
- Gate all `setInterval` calls behind `await readyPromise`
- Expose `/health` endpoint that returns `{ ready: boolean, dependencies: {...} }`

---

## Recommended Phased Approach

### Phase 1: Immediate Wins (1-2 hours)

**Goal:** Stop the bleeding — fix the highest-impact fragility patterns.

1. **Replace `Promise.all` with `Promise.allSettled` in context-sources.ts** (line 908, 1244, and others)
   - Add timeouts (3s per source)
   - Log failures but continue with empty fallback
   - **Impact:** Chat no longer dies on single context source timeout

2. **Add startup readiness gate**
   - Flag: `let ready = false`
   - Wait for: Supabase connection, Telegram bot ready, Google auth initialized
   - Gate all `setInterval` calls behind `ready` flag
   - **Impact:** No more race conditions on startup

3. **Wrap periodic tasks in error boundaries with exponential backoff**
   - Each task gets a try/catch
   - On error: log + backoff (5s → 10s → 20s → disable after 3 failures)
   - **Impact:** A failing periodic task doesn't spam logs or hammer failing services

---

### Phase 2: Structural Improvements (1 week)

**Goal:** Isolate channels, add health monitoring, consolidate queue.

4. **Extract channel plugins**
   - Move Telegram logic to `src/channels/telegram.ts`
   - Move Google Chat logic to `src/channels/google-chat.ts`
   - Move Ellie Chat logic to `src/channels/ellie-chat.ts`
   - Create `src/channels/manager.ts` — ChannelManager pattern from OpenClaw
   - **Impact:** Failures in one channel don't affect others

5. **Add ChannelHealthMonitor**
   - Runs every 5 minutes
   - Checks: Telegram connected, Google Chat reachable, Supabase alive, Forest Bridge responding
   - Restarts unhealthy channels with exponential backoff + rate limits
   - **Impact:** Automatic recovery from transient failures

6. **Consolidate message queue**
   - Single queue with atomic state transitions
   - No separate Ellie Chat queue
   - No shared busy flags
   - **Impact:** Eliminate race conditions

---

### Phase 3: Advanced Patterns (Future)

**Goal:** Production-grade resilience and observability.

7. **Add AbortController per channel**
   - Clean shutdown on restart
   - Cancellation propagation
   - **Impact:** No zombie tasks or memory leaks

8. **Subsystem loggers**
   - Structured, filterable logs
   - Performance tuning (disable verbose subsystems)
   - **Impact:** Better debugging and monitoring

9. **Hot-reload config** (low priority for single-user)
   - Reload .env without restarting relay
   - **Impact:** Quality-of-life improvement

10. **Health endpoint** (`GET /health`)
    - Returns: `{ ready: boolean, channels: {...}, dependencies: {...} }`
    - **Impact:** Monitoring and debugging

---

## What NOT to Copy

### 1. WebSocket Gateway Architecture
- **OpenClaw:** Desktop/mobile apps connect via WebSocket to gateway, gateway routes to channels
- **Ellie Relay:** Channels connect directly (Telegram webhook, Google Chat webhook, Ellie Chat WebSocket)
- **Why not:** Different use case — we don't have desktop/mobile clients that need a persistent connection to the relay

### 2. Canvas Hosting
- **OpenClaw:** Hosts a live Canvas UI that agents can update in real-time
- **Ellie Relay:** No Canvas — we have Ellie Chat dashboard instead
- **Why not:** Not applicable to our architecture

### 3. Multi-user/Multi-workspace Support
- **OpenClaw:** Supports multiple users, workspaces, auth profiles
- **Ellie Relay:** Single-user (Dave), single workspace (evelife)
- **Why not:** Adds complexity we don't need yet (future: Georgia's personal Ellie)

### 4. TLS/HTTPS Termination
- **OpenClaw:** Built-in TLS support for secure WebSocket connections
- **Ellie Relay:** Runs locally on `localhost:3001`, HTTPS handled by nginx reverse proxy
- **Why not:** Already solved at the infra layer

---

## Key Takeaways

### What OpenClaw Does Better
1. **Channel isolation** — plugin architecture prevents cascade failures
2. **Error boundaries** — failures are contained and recovered
3. **Health monitoring** — automatic recovery with rate limits
4. **Startup safety** — readiness gates prevent race conditions
5. **Structured logging** — subsystem loggers enable filtering and debugging

### What Ellie Relay Does Differently (Not Worse)
1. **AI context gathering** — OpenClaw is a router, not an agent. We have richer context needs.
2. **Forest Bridge integration** — Knowledge graph as a service, not baked into the gateway.
3. **Orchestrator pattern** — Multi-agent coordination with creatures, jobs, sessions.
4. **UMS consumers** — Domain-specific intelligence (comms, calendar, alerts, relationships).

### Where They're Not Comparable
- OpenClaw is a **gateway/router** for personal AI across messaging channels
- Ellie Relay is a **multi-channel AI coordinator** with memory, context, and orchestration

We're solving overlapping but distinct problems. OpenClaw's **resilience patterns** are universally applicable. Their **routing architecture** is not.

---

## Next Steps

1. **Decide on phased approach** — Phase 1 (immediate), Phase 2 (structural), or all-in refactor?
2. **Ticket Phase 1 fixes** — `Promise.allSettled`, readiness gate, periodic task error boundaries
3. **Prototype channel plugin pattern** — Extract Telegram as proof-of-concept
4. **Design ChannelHealthMonitor** — Health checks, restart policy, rate limits

---

## References

- OpenClaw codebase: `/home/ellie/Dave-stuff/openclaw`
- Key files analyzed:
  - `src/gateway/server.impl.ts` — Gateway startup and orchestration
  - `src/gateway/server-channels.ts` — ChannelManager and channel lifecycle
  - `src/gateway/channel-health-monitor.ts` — Health monitoring and auto-restart
  - `src/channels/dock.ts` — Channel abstraction layer
  - `src/infra/backoff.ts` — Exponential backoff utilities
- Ellie Relay: `/home/ellie/ellie-dev/src/relay.ts`, `context-sources.ts`

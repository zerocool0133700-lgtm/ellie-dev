# Ellie Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lip-synced talking avatar of Ellie to the chat interface using Simli for real-time video generation and ElevenLabs for TTS audio.

**Architecture:** The relay creates Simli session tokens and streams ElevenLabs TTS audio as PCM16 to the browser. The browser runs the `simli-client` SDK (browser-only) to establish a WebRTC connection with Simli, pipes PCM audio from the relay into Simli, and displays the returned lip-synced video. A pre-generated idle video loop plays when Ellie is not speaking.

**Tech Stack:** Simli API + `simli-client` SDK, ElevenLabs TTS (existing), Vue 3 / Nuxt 4, WebRTC, Bun/TypeScript relay

**Spec:** [2026-03-28-ellie-avatar-design.md](/home/ellie/ellie-dev/docs/2026-03-28-ellie-avatar-design.md)

**Important API detail:** Simli requires PCM16 audio at **16kHz mono**. ElevenLabs outputs PCM at **24kHz**. The relay must request ElevenLabs output in `pcm_16000` format (ElevenLabs supports this output format directly — no resampling needed).

---

## File Structure

### Relay (ellie-dev)

| File | Responsibility |
|------|----------------|
| `src/simli.ts` (create) | Simli API client — session token generation, face listing |
| `src/avatar-routes.ts` (create) | HTTP route handlers for `/api/avatar/*` endpoints |
| `src/http-routes.ts` (modify) | Import and mount avatar routes |
| `src/tts.ts` (modify) | Add `textToSpeechPCM16Stream()` — streams PCM16 16kHz for Simli |
| `tests/simli.test.ts` (create) | Tests for Simli client |
| `tests/avatar-routes.test.ts` (create) | Tests for avatar endpoints |

### Dashboard (ellie-home)

| File | Responsibility |
|------|----------------|
| `app/components/ellie/AvatarVideo.vue` (create) | Video display — idle loop + Simli WebRTC, expand/collapse, state borders |
| `app/composables/useAvatarSession.ts` (create) | Simli session lifecycle, WebRTC connection, audio piping |
| `app/pages/ellie-chat.vue` (modify) | Add avatar to header, wire Read Mode to avatar |
| `public/avatar/` (create dir) | Static assets — `ellie-face.png`, `ellie-idle.mp4` |

---

## Task 1: Add PCM16 Streaming to TTS Module

**Files:**
- Modify: `src/tts.ts`

This task adds a new TTS function that streams PCM16 audio at 16kHz — the format Simli requires.

- [ ] **Step 1: Add `textToSpeechPCM16Stream` function to tts.ts**

Add this after the existing `textToSpeechFastStream` function (around line 428):

```typescript
/**
 * Streaming PCM16 TTS at 16kHz mono — for Simli avatar lip-sync.
 * Returns raw PCM s16le audio chunks suitable for piping to Simli.
 */
export async function textToSpeechPCM16Stream(
  text: string,
  providerOverride?: "elevenlabs" | "openai"
): Promise<TTSStream | null> {
  const provider = getProvider(providerOverride);
  if (!provider) return null;

  if (provider === "openai") {
    return await openaiTTSStream(text, "pcm", "audio/pcm");
  }

  // ElevenLabs — PCM 16kHz output
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?output_format=pcm_16000`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: "eleven_turbo_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    }
  );

  if (!response.ok || !response.body) {
    logger.error("ElevenLabs PCM16 stream error", { status: response.status, body: await response.text() });
    return null;
  }

  return { body: response.body, contentType: "audio/pcm" };
}
```

- [ ] **Step 2: Verify the module compiles**

Run: `cd /home/ellie/ellie-dev && bun build src/tts.ts --no-bundle`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/tts.ts
git commit -m "[avatar] feat: add PCM16 16kHz streaming TTS for Simli integration"
```

---

## Task 2: Create Simli Client Module

**Files:**
- Create: `src/simli.ts`
- Create: `tests/simli.test.ts`

The relay-side Simli client handles session token generation. The actual WebRTC connection happens browser-side via `simli-client` SDK.

- [ ] **Step 1: Write the test for Simli session token generation**

Create `tests/simli.test.ts`:

```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock fetch before importing
const mockFetch = mock(() => Promise.resolve(new Response(
  JSON.stringify({ session_token: "test-token-123" }),
  { status: 200, headers: { "Content-Type": "application/json" } }
)));

// Store original and override
const originalFetch = globalThis.fetch;

describe("simli", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    globalThis.fetch = mockFetch as any;
  });

  it("should export getSimliSessionToken", async () => {
    const { getSimliSessionToken } = await import("../src/simli.ts");
    expect(typeof getSimliSessionToken).toBe("function");
  });

  it("getSimliSessionToken calls Simli API with correct params", async () => {
    const { getSimliSessionToken } = await import("../src/simli.ts");

    const result = await getSimliSessionToken("test-face-id");

    expect(result).toBe("test-token-123");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.simli.ai/compose/token");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body as string);
    expect(body.faceId).toBe("test-face-id");
    expect(body.handleSilence).toBe(true);
  });

  it("getSimliSessionToken returns null on API failure", async () => {
    mockFetch.mockImplementationOnce(() => Promise.resolve(
      new Response("Internal Server Error", { status: 500 })
    ));

    const { getSimliSessionToken } = await import("../src/simli.ts");
    const result = await getSimliSessionToken("test-face-id");
    expect(result).toBeNull();
  });

  // Restore fetch after all tests
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/simli.test.ts`
Expected: FAIL — module `src/simli.ts` does not exist

- [ ] **Step 3: Create src/simli.ts**

```typescript
/**
 * Simli API client — avatar session management.
 *
 * The relay creates session tokens (keeps API key server-side).
 * The browser uses simli-client SDK for WebRTC + video.
 */

import { log } from "./logger.ts";

const logger = log.child("simli");

const SIMLI_API_KEY = process.env.SIMLI_API_KEY || "";
const SIMLI_API_URL = process.env.SIMLI_API_URL || "https://api.simli.ai";
const SIMLI_FACE_ID = process.env.SIMLI_FACE_ID || "";

/**
 * Get a Simli session token for the browser to establish WebRTC.
 * Returns the session_token string, or null on failure.
 */
export async function getSimliSessionToken(
  faceId?: string,
  options?: { maxSessionLength?: number; maxIdleTime?: number }
): Promise<string | null> {
  if (!SIMLI_API_KEY) {
    logger.error("SIMLI_API_KEY not configured");
    return null;
  }

  const body = {
    faceId: faceId || SIMLI_FACE_ID,
    handleSilence: true,
    maxSessionLength: options?.maxSessionLength ?? 600,
    maxIdleTime: options?.maxIdleTime ?? 300,
    model: "fasttalk",
  };

  try {
    const response = await fetch(`${SIMLI_API_URL}/compose/token`, {
      method: "POST",
      headers: {
        "x-simli-api-key": SIMLI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      logger.error("Simli token error", { status: response.status, body: await response.text() });
      return null;
    }

    const data = await response.json() as { session_token: string };
    logger.info("Simli session token created", { faceId: body.faceId });
    return data.session_token;
  } catch (err) {
    logger.error("Simli token request failed", err);
    return null;
  }
}

/**
 * Get ICE servers from Simli for P2P WebRTC.
 * Returns the ICE server array, or null on failure.
 */
export async function getSimliIceServers(): Promise<RTCIceServer[] | null> {
  if (!SIMLI_API_KEY) return null;

  try {
    const response = await fetch(`${SIMLI_API_URL}/compose/ice`, {
      headers: { "x-simli-api-key": SIMLI_API_KEY },
    });

    if (!response.ok) {
      logger.error("Simli ICE error", { status: response.status });
      return null;
    }

    return await response.json() as RTCIceServer[];
  } catch (err) {
    logger.error("Simli ICE request failed", err);
    return null;
  }
}

/** Check if Simli is configured. */
export function isSimliConfigured(): boolean {
  return !!(SIMLI_API_KEY && SIMLI_FACE_ID);
}

/** Get the configured face ID. */
export function getSimliFaceId(): string {
  return SIMLI_FACE_ID;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/simli.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/simli.ts tests/simli.test.ts
git commit -m "[avatar] feat: add Simli API client for session token generation"
```

---

## Task 3: Create Avatar API Routes

**Files:**
- Create: `src/avatar-routes.ts`
- Create: `tests/avatar-routes.test.ts`
- Modify: `src/http-routes.ts`

Three endpoints: create session (returns token + ICE servers for browser), stream TTS as PCM16, and status check.

- [ ] **Step 1: Write the test for avatar routes**

Create `tests/avatar-routes.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";

describe("avatar-routes", () => {
  it("should export handleAvatarRoutes function", async () => {
    const { handleAvatarRoutes } = await import("../src/avatar-routes.ts");
    expect(typeof handleAvatarRoutes).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ellie/ellie-dev && bun test tests/avatar-routes.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Create src/avatar-routes.ts**

```typescript
/**
 * Avatar API routes — Simli session + TTS streaming for avatar lip-sync.
 *
 * POST /api/avatar/session — create Simli session, return token + ICE servers
 * POST /api/avatar/speak   — stream PCM16 TTS audio for browser to pipe to Simli
 * GET  /api/avatar/status   — check if avatar (Simli) is configured
 */

import type { IncomingMessage, ServerResponse } from "http";
import { log } from "./logger.ts";
import { getSimliSessionToken, getSimliIceServers, isSimliConfigured } from "./simli.ts";
import { textToSpeechPCM16Stream } from "./tts.ts";

const logger = log.child("avatar");

/**
 * Handle avatar-related API routes.
 * Returns true if the route was handled, false if not an avatar route.
 */
export function handleAvatarRoutes(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  authenticateRequest: (req: IncomingMessage, scope: string, legacyKey: string) => Promise<boolean>,
  legacyKey: string,
): boolean {
  if (!url.pathname.startsWith("/api/avatar")) return false;

  // GET /api/avatar/status — no auth needed
  if (url.pathname === "/api/avatar/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ configured: isSimliConfigured() }));
    return true;
  }

  // POST /api/avatar/session — create Simli session
  if (url.pathname === "/api/avatar/session" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const auth = await authenticateRequest(req, "tts", legacyKey);
        if (!auth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const [sessionToken, iceServers] = await Promise.all([
          getSimliSessionToken(),
          getSimliIceServers(),
        ]);

        if (!sessionToken) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Simli unavailable" }));
          return;
        }

        logger.info("Avatar session created");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          session_token: sessionToken,
          ice_servers: iceServers,
        }));
      } catch (err) {
        logger.error("Avatar session error", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return true;
  }

  // POST /api/avatar/speak — stream PCM16 TTS for Simli
  if (url.pathname === "/api/avatar/speak" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const auth = await authenticateRequest(req, "tts", legacyKey);
        if (!auth) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        const data = JSON.parse(body);
        if (!data.text || typeof data.text !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing 'text' field" }));
          return;
        }

        const text = data.text.substring(0, 4000);
        const providerOverride = (data.provider === "elevenlabs" || data.provider === "openai")
          ? data.provider : undefined;

        const stream = await textToSpeechPCM16Stream(text, providerOverride);
        if (!stream) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "TTS unavailable" }));
          return;
        }

        // Stream PCM16 directly to the browser
        res.writeHead(200, {
          "Content-Type": "audio/pcm",
          "X-Audio-Format": "pcm_s16le",
          "X-Sample-Rate": "16000",
          "X-Channels": "1",
        });
        for await (const chunk of stream.body) {
          res.write(chunk);
        }
        res.end();
      } catch (err) {
        logger.error("Avatar speak error", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      }
    });
    return true;
  }

  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/ellie/ellie-dev && bun test tests/avatar-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Mount avatar routes in http-routes.ts**

Find the imports section at the top of `src/http-routes.ts` and add:

```typescript
import { handleAvatarRoutes } from "./avatar-routes.ts";
```

Then find where routes are matched (before the TTS endpoint around line 2332) and add:

```typescript
  // Avatar routes (Simli integration)
  if (handleAvatarRoutes(url, req, res, authenticateRequest, EXTENSION_API_KEY)) return;
```

- [ ] **Step 6: Verify relay compiles**

Run: `cd /home/ellie/ellie-dev && bun build src/relay.ts --no-bundle 2>&1 | head -5`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-dev
git add src/avatar-routes.ts tests/avatar-routes.test.ts src/http-routes.ts
git commit -m "[avatar] feat: add avatar API routes — session creation + PCM16 TTS streaming"
```

---

## Task 4: Install simli-client SDK in Dashboard

**Files:**
- Modify: `package.json` (ellie-home)

- [ ] **Step 1: Install simli-client**

Run: `cd /home/ellie/ellie-home && bun add simli-client`

- [ ] **Step 2: Verify installation**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add package.json bun.lockb
git commit -m "[avatar] chore: add simli-client SDK dependency"
```

---

## Task 5: Create Avatar Session Composable

**Files:**
- Create: `app/composables/useAvatarSession.ts`

This composable manages the Simli WebRTC connection lifecycle and audio piping.

- [ ] **Step 1: Create useAvatarSession.ts**

```typescript
/**
 * Avatar session composable — manages Simli WebRTC connection.
 *
 * Handles: session creation, SimliClient lifecycle, audio piping,
 * state tracking (idle/listening/speaking/thinking), auto-reconnect.
 */

import { ref, onUnmounted, watch } from "vue";
import { SimliClient } from "simli-client";

export type AvatarState = "idle" | "listening" | "speaking" | "thinking";

export function useAvatarSession() {
  const enabled = ref(loadEnabled());
  const autoExpand = ref(loadAutoExpand());
  const state = ref<AvatarState>("idle");
  const expanded = ref(false);
  const connected = ref(false);
  const configured = ref(false);

  let simliClient: SimliClient | null = null;
  let videoEl: HTMLVideoElement | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let sessionToken: string | null = null;

  // ── Persistence ──────────────────────────────────────────

  function loadEnabled(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem("ellie-avatar-enabled") !== "0";
  }

  function loadAutoExpand(): boolean {
    if (typeof localStorage === "undefined") return true;
    return localStorage.getItem("ellie-avatar-auto-expand") !== "0";
  }

  function saveEnabled(val: boolean) {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("ellie-avatar-enabled", val ? "1" : "0");
    }
  }

  function saveAutoExpand(val: boolean) {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("ellie-avatar-auto-expand", val ? "1" : "0");
    }
  }

  // ── Toggle ───────────────────────────────────────────────

  function toggleEnabled() {
    enabled.value = !enabled.value;
    saveEnabled(enabled.value);
    if (enabled.value) {
      initSession();
    } else {
      destroySession();
    }
  }

  function toggleAutoExpand() {
    autoExpand.value = !autoExpand.value;
    saveAutoExpand(autoExpand.value);
  }

  function toggleExpanded() {
    expanded.value = !expanded.value;
  }

  // ── Check if Simli is configured ─────────────────────────

  async function checkConfigured(): Promise<boolean> {
    try {
      const data = await $fetch<{ configured: boolean }>("/api/avatar/status");
      configured.value = data.configured;
      return data.configured;
    } catch {
      configured.value = false;
      return false;
    }
  }

  // ── Session lifecycle ────────────────────────────────────

  async function initSession() {
    if (!enabled.value) return;
    if (!(await checkConfigured())) return;

    try {
      // Get session token and ICE servers from relay
      const tokenRes = await $fetch<{ session_token: string; ice_servers: RTCIceServer[] | null }>(
        "/api/avatar/session",
        { method: "POST" }
      );
      sessionToken = tokenRes.session_token;

      if (!videoEl || !audioEl) {
        console.error("[avatar] Video/audio elements not set — call setMediaElements() first");
        return;
      }

      // Create SimliClient
      simliClient = new SimliClient(
        sessionToken,
        videoEl,
        audioEl,
        tokenRes.ice_servers,
      );

      simliClient.on("start", () => {
        connected.value = true;
        state.value = "idle";
        console.log("[avatar] Simli connected");
      });

      simliClient.on("stop", () => {
        connected.value = false;
        state.value = "idle";
        console.log("[avatar] Simli disconnected");
      });

      simliClient.on("speaking", () => {
        state.value = "speaking";
      });

      simliClient.on("silent", () => {
        state.value = "idle";
        if (autoExpand.value && expanded.value) {
          expanded.value = false;
        }
      });

      simliClient.on("error", (detail: string) => {
        console.error("[avatar] Simli error:", detail);
      });

      await simliClient.start();
    } catch (err) {
      console.error("[avatar] Session init failed:", err);
      connected.value = false;
    }
  }

  function destroySession() {
    if (simliClient) {
      simliClient.stop();
      simliClient = null;
    }
    connected.value = false;
    state.value = "idle";
    sessionToken = null;
  }

  // ── Media elements ───────────────────────────────────────

  function setMediaElements(video: HTMLVideoElement, audio: HTMLAudioElement) {
    videoEl = video;
    audioEl = audio;
  }

  // ── Speaking ─────────────────────────────────────────────

  /**
   * Speak text through the avatar.
   * Fetches PCM16 audio from relay, pipes to Simli for lip-sync.
   * Returns true if speech was successful, false if fallback needed.
   */
  async function speak(text: string, provider?: "elevenlabs" | "openai"): Promise<boolean> {
    if (!enabled.value || !connected.value || !simliClient) {
      return false; // Caller should fall back to regular TTS
    }

    state.value = "speaking";

    // Auto-expand if setting is on
    if (autoExpand.value) {
      expanded.value = true;
    }

    try {
      // Fetch PCM16 audio from relay
      const response = await fetch("/api/avatar/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.substring(0, 4000), provider }),
      });

      if (!response.ok || !response.body) {
        state.value = "idle";
        return false;
      }

      // Stream PCM16 chunks to Simli
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && simliClient) {
          simliClient.sendAudioData(value);
        }
      }

      // Simli will fire "silent" event when done playing
      return true;
    } catch (err) {
      console.error("[avatar] Speak failed:", err);
      state.value = "idle";
      return false;
    }
  }

  /** Set avatar state externally (e.g., "thinking" while waiting for LLM). */
  function setState(newState: AvatarState) {
    state.value = newState;
  }

  // ── Cleanup ──────────────────────────────────────────────

  onUnmounted(() => {
    destroySession();
  });

  return {
    // State
    enabled,
    autoExpand,
    state,
    expanded,
    connected,
    configured,

    // Actions
    toggleEnabled,
    toggleAutoExpand,
    toggleExpanded,
    setMediaElements,
    initSession,
    destroySession,
    speak,
    setState,
    checkConfigured,
  };
}
```

- [ ] **Step 2: Verify it compiles with the Nuxt build**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -10`
Expected: Build succeeds (composable is tree-shaken if not used yet, but should parse)

- [ ] **Step 3: Commit**

```bash
cd /home/ellie/ellie-home
git add app/composables/useAvatarSession.ts
git commit -m "[avatar] feat: add avatar session composable — Simli WebRTC + audio piping"
```

---

## Task 6: Create Avatar Video Component

**Files:**
- Create: `app/components/ellie/AvatarVideo.vue`

Displays the avatar in the header — idle video loop when quiet, Simli WebRTC video when speaking. Click to expand/collapse.

- [ ] **Step 1: Create the AvatarVideo.vue component**

```vue
<template>
  <div class="relative select-none" :class="expanded ? 'z-50' : ''">
    <!-- Compact avatar (header size) -->
    <button
      @click="avatar.toggleExpanded()"
      class="relative rounded-full overflow-hidden border-2 transition-all duration-300 focus:outline-none"
      :class="[
        borderClass,
        expanded ? 'w-[200px] h-[200px] rounded-2xl' : 'w-12 h-12',
      ]"
      :style="glowStyle"
      title="Ellie Avatar — click to expand"
    >
      <!-- Idle video loop -->
      <video
        ref="idleVideoRef"
        class="absolute inset-0 w-full h-full object-cover transition-opacity duration-300"
        :class="showSimli ? 'opacity-0' : 'opacity-100'"
        :src="idleVideoSrc"
        loop
        muted
        autoplay
        playsinline
      />

      <!-- Simli WebRTC video (hidden elements — Simli renders into these) -->
      <video
        ref="simliVideoRef"
        class="absolute inset-0 w-full h-full object-cover transition-opacity duration-300"
        :class="showSimli ? 'opacity-100' : 'opacity-0'"
        autoplay
        playsinline
      />
      <audio ref="simliAudioRef" autoplay />

      <!-- Online indicator dot -->
      <div
        class="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-gray-900"
        :class="avatar.connected.value ? 'bg-emerald-400' : 'bg-gray-500'"
      />
    </button>

    <!-- Click-outside overlay when expanded -->
    <div
      v-if="expanded"
      class="fixed inset-0 z-40"
      @click="avatar.toggleExpanded()"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { useAvatarSession } from "~/composables/useAvatarSession";

const avatar = useAvatarSession();

const idleVideoRef = ref<HTMLVideoElement | null>(null);
const simliVideoRef = ref<HTMLVideoElement | null>(null);
const simliAudioRef = ref<HTMLAudioElement | null>(null);

const idleVideoSrc = "/avatar/ellie-idle.mp4";

const expanded = computed(() => avatar.expanded.value);
const showSimli = computed(() => avatar.state.value === "speaking" && avatar.connected.value);

const borderClass = computed(() => {
  switch (avatar.state.value) {
    case "speaking": return "border-emerald-500";
    case "listening": return "border-cyan-500";
    case "thinking": return "border-amber-500";
    default: return "border-gray-600";
  }
});

const glowStyle = computed(() => {
  switch (avatar.state.value) {
    case "speaking": return "box-shadow: 0 0 16px rgba(16,185,129,0.4)";
    case "listening": return "box-shadow: 0 0 12px rgba(6,182,212,0.3)";
    case "thinking": return "box-shadow: 0 0 12px rgba(245,158,11,0.3)";
    default: return "";
  }
});

// Set media elements once refs are available
onMounted(async () => {
  await nextTick();
  if (simliVideoRef.value && simliAudioRef.value) {
    avatar.setMediaElements(simliVideoRef.value, simliAudioRef.value);
  }
  // Auto-init if enabled
  if (avatar.enabled.value) {
    avatar.initSession();
  }
});
</script>
```

- [ ] **Step 2: Create the avatar assets directory**

Run: `mkdir -p /home/ellie/ellie-home/public/avatar`

For now, create a placeholder. The actual idle video will be generated from Simli later. Copy the Ellie face image that Dave provided to `public/avatar/ellie-face.png`.

A placeholder idle video isn't needed for development — the component handles a missing video gracefully (shows nothing in the idle layer, Simli video still works).

- [ ] **Step 3: Verify build**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
cd /home/ellie/ellie-home
git add app/components/ellie/AvatarVideo.vue public/avatar/
git commit -m "[avatar] feat: add AvatarVideo component — idle loop + Simli WebRTC display"
```

---

## Task 7: Integrate Avatar into Chat Page

**Files:**
- Modify: `app/pages/ellie-chat.vue`

Wire the avatar into the header and enhance Read Mode to route through the avatar when enabled.

- [ ] **Step 1: Add avatar to the header template**

In `ellie-chat.vue`, find the header section (around line 37-39):

```html
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-2">
        <h1 class="text-xl font-semibold">Ellie Chat</h1>
        <EllieModeSelector />
      </div>
```

Replace with:

```html
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-semibold">Ellie Chat</h1>
        <EllieAvatarVideo ref="avatarVideoRef" />
        <EllieModeSelector />
      </div>
```

- [ ] **Step 2: Add avatar toggle button to the header controls**

Find the Read Mode toggle button area (around line 50-61) and add an avatar toggle before it:

```html
        <!-- Avatar toggle -->
        <button
          v-if="avatarSession.configured.value"
          @click="avatarSession.toggleEnabled()"
          class="text-xs px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1.5"
          :class="avatarSession.enabled.value
            ? 'bg-cyan-900/50 border border-cyan-700/50 text-cyan-400'
            : 'border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500'"
          :title="avatarSession.enabled.value ? 'Turn off Avatar' : 'Turn on Avatar'">
          {{ avatarSession.enabled.value ? 'Avatar On' : 'Avatar' }}
        </button>
```

- [ ] **Step 3: Import and initialize the avatar composable**

In the `<script setup>` section, add the import (near other composable imports):

```typescript
import { useAvatarSession } from "~/composables/useAvatarSession";

const avatarSession = useAvatarSession();
const avatarVideoRef = ref<InstanceType<typeof EllieAvatarVideo> | null>(null);
```

Add avatar configuration check in the onMounted section (find the existing `onMounted` and add to it):

```typescript
avatarSession.checkConfigured();
```

- [ ] **Step 4: Enhance Read Mode to route through avatar**

Find the `playReadModeQueue` function (around line 1629). Replace the TTS fetch logic to try avatar first:

```typescript
async function playReadModeQueue() {
  if (readModeSpeaking.value) return // already playing
  while (readModeQueue.length > 0 && readMode.value) {
    const text = readModeQueue.shift()!
    readModeSpeaking.value = true
    try {
      // Try avatar speech first (if enabled + connected)
      const avatarHandled = await avatarSession.speak(text, ttsProvider.value)
      if (avatarHandled) {
        // Avatar handled it — wait for the "silent" event
        await new Promise<void>((resolve) => {
          const checkIdle = setInterval(() => {
            if (avatarSession.state.value !== "speaking") {
              clearInterval(checkIdle)
              resolve()
            }
          }, 200)
          // Safety timeout: 60s max per message
          setTimeout(() => { clearInterval(checkIdle); resolve() }, 60000)
        })
      } else {
        // Fallback to regular TTS audio
        const res = await $fetch<Blob>('/api/tts', {
          method: 'POST',
          body: { text: text.substring(0, 4000), fast: true, provider: ttsProvider.value },
          responseType: 'blob',
        })
        const url = URL.createObjectURL(res)
        readModeAudio = new Audio(url)
        await new Promise<void>((resolve) => {
          readModeAudio!.onended = () => { URL.revokeObjectURL(url); readModeAudio = null; resolve() }
          readModeAudio!.onerror = () => { URL.revokeObjectURL(url); readModeAudio = null; resolve() }
          readModeAudio!.play().catch(() => resolve())
        })
      }
    } catch (e) {
      console.error('[read-mode] TTS failed:', e)
    }
  }
  readModeSpeaking.value = false
}
```

- [ ] **Step 5: Set avatar state to "thinking" when waiting for LLM response**

Find where the user sends a message (look for the send function). After the message is sent and before the response arrives, set the avatar state:

```typescript
avatarSession.setState("thinking");
```

And when the response starts streaming in, set it to "listening":

```typescript
avatarSession.setState("idle");
```

The exact location depends on the send logic — look for where `messages` are pushed and where the assistant response starts appearing.

- [ ] **Step 6: Build and verify**

Run: `cd /home/ellie/ellie-home && bun run build 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 7: Commit**

```bash
cd /home/ellie/ellie-home
git add app/pages/ellie-chat.vue
git commit -m "[avatar] feat: integrate avatar into chat — header placement + Read Mode enhancement"
```

---

## Task 8: Environment Setup & Manual Testing

**Files:**
- Modify: `ellie-dev/.env` (add Simli keys)

- [ ] **Step 1: Sign up for Simli and get API key**

Go to [app.simli.com](https://app.simli.com), create an account, and get an API key.

- [ ] **Step 2: Create a custom face**

Upload the Ellie face image (`ellie-face.png`) at app.simli.com to create a custom face. Note the face ID.

- [ ] **Step 3: Add environment variables to relay .env**

```bash
# Simli Avatar
SIMLI_API_KEY=<your-simli-api-key>
SIMLI_FACE_ID=<your-face-id>
```

- [ ] **Step 4: Generate idle video**

Use the Simli API or dashboard to generate a ~5 second silent video of Ellie with the custom face. Save it to:

```bash
/home/ellie/ellie-home/public/avatar/ellie-idle.mp4
```

- [ ] **Step 5: Restart relay and rebuild dashboard**

```bash
cd /home/ellie/ellie-dev && systemctl --user restart claude-telegram-relay
cd /home/ellie/ellie-home && bun run build && sudo systemctl restart ellie-dashboard
```

- [ ] **Step 6: Test the full flow**

1. Open the dashboard in browser
2. Verify the avatar appears in the header (top-left, after "Ellie Chat")
3. Verify the avatar toggle button appears
4. Enable Read Mode + Avatar
5. Send a message and verify:
   - Avatar border turns amber (thinking) while waiting for response
   - When response arrives with Read Mode, avatar lip-syncs the speech
   - Avatar border turns green (speaking) during playback
   - Avatar returns to idle when speech finishes
6. Click avatar to expand to 200px view
7. Disable avatar — verify Read Mode falls back to audio-only

- [ ] **Step 7: Commit environment and asset changes**

```bash
cd /home/ellie/ellie-home
git add public/avatar/ellie-idle.mp4
git commit -m "[avatar] chore: add Ellie idle loop video asset"
```

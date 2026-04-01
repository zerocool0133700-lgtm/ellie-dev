/**
 * Claude CLI Caller + Session Management
 *
 * Extracted from relay.ts — ELLIE-184 / ELLIE-205.
 * Core function: spawn Claude CLI as subprocess, manage session state.
 */

import { spawn } from "bun";
import { writeFile, readFile, unlink } from "fs/promises";
import { join } from "path";
import type { Context } from "grammy";
import type Anthropic from "@anthropic-ai/sdk";
import { setTimeoutRecoveryLock } from "./plane.ts";
import { notify, type NotifyContext } from "./notification-policy.ts";
import { log } from "./logger.ts";
import { emitEvent } from "./orchestration-ledger.ts";
import { heartbeat as trackerHeartbeat, setRunPid } from "./orchestration-tracker.ts";
import { markJobTimedOutByRunId } from "./jobs-ledger.ts";

const logger = log.child("claude-cli");

// ── Config (from env) ───────────────────────────────────────

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const AGENT_MODE = process.env.AGENT_MODE !== "false";
const AGENT_MODEL_OVERRIDE = process.env.AGENT_MODEL_OVERRIDE === "true";
const DEFAULT_TOOLS = "Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch";
const MCP_TOOLS = "mcp__google-workspace__*,mcp__github__*,mcp__memory__*,mcp__sequential-thinking__*,mcp__plane__*,mcp__claude_ai_Miro__*,mcp__brave-search__*,mcp__excalidraw__*,mcp__forest-bridge__*,mcp__qmd__*,mcp__ask-user__*";
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || `${DEFAULT_TOOLS},${MCP_TOOLS}`).split(",").map(t => t.trim());
const SESSION_FILE = join(RELAY_DIR, "session.json");
const LOCK_FILE = join(RELAY_DIR, "bot.lock");
// ELLIE-239: Configurable CLI timeout (default 900s agent, 60s non-agent)
const CLI_TIMEOUT_MS = parseInt(process.env.CLI_TIMEOUT_MS || (AGENT_MODE ? "900000" : "60000"));

// ── External dependency setters ─────────────────────────────
// These are registered by relay.ts at startup since the actual
// implementations depend on state defined later in relay.ts.

let _broadcastExtension: (event: Record<string, unknown>) => void = () => {};
export function setBroadcastExtension(fn: typeof _broadcastExtension): void { _broadcastExtension = fn; }

let _getNotifyCtx: () => NotifyContext = () => ({ bot: null as unknown as import("grammy").Bot, telegramUserId: "", gchatSpaceName: "" });
export function setNotifyCtx(fn: typeof _getNotifyCtx): void { _getNotifyCtx = fn; }

let _anthropic: Anthropic | null = null;
export function setAnthropicClient(client: Anthropic | null): void { _anthropic = client; }

// ── Session state ───────────────────────────────────────────

export interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

export async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

export let session = await loadSession();

// ── Session write mutex (prevent concurrent writes) ─────
let _sessionWriteLock: Promise<void> = Promise.resolve();

async function saveSessionSafe(state: SessionState): Promise<void> {
  // Queue behind any in-flight write
  const prev = _sessionWriteLock;
  _sessionWriteLock = (async () => {
    await prev;
    await saveSession(state);
  })();
  await _sessionWriteLock;
}

// ── Lock file (prevent multiple instances) ──────────────────

export async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0);
        logger.info(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        logger.info("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    logger.error("Lock error", error);
    return false;
  }
}

export async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ── callClaude ──────────────────────────────────────────────

export async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string; allowedTools?: string[]; model?: string; sessionId?: string; timeoutMs?: number; runId?: string; abortSignal?: AbortSignal; outputFormat?: "text" | "json" }
): Promise<string> {
  // Prompt is piped via stdin to avoid E2BIG (ARG_MAX) on large prompts.
  // The positional [prompt] arg is omitted; claude -p reads from stdin.
  const args = [CLAUDE_PATH, "-p"];

  const resumeSessionId = options?.sessionId || session.sessionId;
  if (options?.resume && resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  args.push("--output-format", options?.outputFormat ?? "text");

  if (AGENT_MODEL_OVERRIDE && options?.model) { args.push("--model", options.model); }

  if (AGENT_MODE) {
    const tools = options?.allowedTools?.length ? options.allowedTools : ALLOWED_TOOLS;
    args.push("--allowedTools", ...tools);
  }

  const flagArgs = args.slice(1).filter(a => a.startsWith("--"));
  const resumeId = options?.resume && resumeSessionId ? resumeSessionId.slice(0, 8) : null;
  const toolCount = options?.allowedTools?.length || ALLOWED_TOOLS.length;

  // ELLIE-460: Dispatch lifecycle — capture memory before spawn to detect OOM sequences
  const dispatchStart = Date.now();
  const memBefore = process.memoryUsage();
  logger.info("Dispatch started", {
    prompt_chars: prompt.length,
    resume: resumeId ?? false,
    tools: toolCount,
    heap_mb: Math.round(memBefore.heapUsed / 1024 / 1024),
    rss_mb: Math.round(memBefore.rss / 1024 / 1024),
    run_id: options?.runId ?? null,
  });

  try {
    const proc = spawn(args, {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
        CLAUDECODE: "",
        ANTHROPIC_API_KEY: "",
      },
    });

    // ELLIE-349/390: Track PID and emit heartbeats on stdout activity
    let heartbeatDbThrottle = 0;
    if (options?.runId) {
      setRunPid(options.runId, proc.pid);
    }

    const TIMEOUT_MS = options?.timeoutMs ?? CLI_TIMEOUT_MS;
    let timedOut = false;
    let forceKilled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    // ELLIE-461: Abort signal — kill subprocess immediately when the caller aborts
    // (e.g. WS disconnected mid-dispatch)
    if (options?.abortSignal) {
      const sig = options.abortSignal;
      if (sig.aborted) {
        proc.kill();
        logger.warn("Dispatch aborted before start — signal was already aborted when process spawned");
        return "";  // Empty response — caller handles gracefully
      }
      sig.addEventListener("abort", () => {
        logger.warn("Dispatch aborted via signal — killing subprocess", { pid: proc.pid });
        proc.kill();
      }, { once: true });
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      const timeoutSec = TIMEOUT_MS / 1000;
      logger.error("Timeout — sending SIGTERM", { timeoutSec, pid: proc.pid });
      proc.kill();

      killTimer = setTimeout(() => {
        try {
          process.kill(proc.pid, 0);
          logger.error("Process survived SIGTERM — sending SIGKILL", { pid: proc.pid });
          proc.kill(9);
          forceKilled = true;
        } catch {
          // Process already exited
        }
      }, 5_000);
    }, TIMEOUT_MS);

    // ELLIE-390: Stream stdout — emit heartbeats on actual data activity.
    // This means a hung process with no output gets correctly flagged stale,
    // while a slow-but-active process (long code review) stays alive.
    const chunks: string[] = [];
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
      // Heartbeat on every stdout chunk — the tracker deduplicates internally
      if (options?.runId) {
        trackerHeartbeat(options.runId);
        if (Date.now() - heartbeatDbThrottle > 60_000) {
          emitEvent(options.runId, "heartbeat", null, null, { pid: proc.pid });
          heartbeatDbThrottle = Date.now();
        }
      }
    }
    const output = chunks.join("");
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);

    const exitCode = await proc.exited;

    // ELLIE-460: Dispatch lifecycle — log completion with timing and memory delta
    {
      const memAfter = process.memoryUsage();
      const durationMs = Date.now() - dispatchStart;
      const heapDeltaMb = Math.round((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024);
      (exitCode === 0 ? logger.info : logger.warn)("Dispatch completed", {
        exit_code: exitCode,
        duration_ms: durationMs,
        output_chars: output.length,
        heap_mb: Math.round(memAfter.heapUsed / 1024 / 1024),
        heap_delta_mb: heapDeltaMb,
        rss_mb: Math.round(memAfter.rss / 1024 / 1024),
        timed_out: timedOut,
        run_id: options?.runId ?? null,
      });
    }

    if (exitCode !== 0) {
      logger.error("Non-zero exit code", {
        exitCode,
        timedOut,
        forceKilled,
        stderr: stderr ? stderr.substring(0, 500) : undefined,
        stdoutPreview: output ? output.substring(0, 200) : undefined,
      });

      const combined = (stderr + output).toLowerCase();
      if (options?.resume && resumeSessionId && combined.includes("tool_use.name")) {
        logger.warn("Corrupted session history — retrying without --resume");
        return callClaude(prompt, { ...options, resume: false, sessionId: undefined });
      }

      if (timedOut) {
        _broadcastExtension({ type: "error", source: "callClaude", message: `Timeout after ${TIMEOUT_MS / 1000}s${forceKilled ? " (force-killed)" : ""}` });
        setTimeoutRecoveryLock(60_000);
        if (options?.runId) {
          emitEvent(options.runId, "timeout", null, null, { timeout_ms: TIMEOUT_MS, force_killed: forceKilled });
          // ELLIE-527: Mark job as timed_out so metrics distinguish timeouts from completions
          const timeoutDurationMs = Date.now() - dispatchStart;
          markJobTimedOutByRunId(options.runId, timeoutDurationMs).catch(() => {});
        }

        const timeoutSec = TIMEOUT_MS / 1000;
        const processStatus = forceKilled
          ? "The process did not respond to termination and was force-killed."
          : "The process was terminated.";

        const partialOutput = output?.trim();

        notify(_getNotifyCtx(), {
          event: "error",
          workItemId: "timeout",
          telegramMessage: `⚠️ Task timed out after ${timeoutSec}s${forceKilled ? " (force-killed)" : ""}`,
          gchatMessage: `⚠️ Task timed out after ${timeoutSec}s. ${processStatus}${partialOutput ? `\nPartial: ${partialOutput.substring(0, 300)}` : ""}`,
        }).catch((err) => logger.error("Timeout notification failed", { detail: err.message }));

        let message = `Task timed out after ${timeoutSec}s. ${processStatus}`;

        if (partialOutput) {
          const preview = partialOutput.length > 500
            ? partialOutput.substring(0, 500) + "..."
            : partialOutput;
          message += `\n\nPartial output before timeout:\n${preview}`;
        }

        message += `\n\nYou can retry the request, or ask "what did you get done?" to check if work was partially completed.`;

        return message;
      }

      if (exitCode === 143) {
        _broadcastExtension({ type: "error", source: "callClaude", message: "SIGTERM (exit 143) — service restart or external kill" });
        const partialOutput = output?.trim();

        notify(_getNotifyCtx(), {
          event: "error",
          workItemId: "sigterm",
          telegramMessage: "⚠️ Process interrupted (SIGTERM)",
          gchatMessage: `⚠️ Process interrupted (SIGTERM — exit 143).${partialOutput ? `\nPartial: ${partialOutput.substring(0, 300)}` : ""}`,
        }).catch((err) => logger.error("SIGTERM notification failed", { detail: err.message }));

        let message = "I got interrupted while working on this (the service was restarted or the process was terminated externally).";
        if (partialOutput) {
          const preview = partialOutput.length > 500
            ? partialOutput.substring(0, 500) + "..."
            : partialOutput;
          message += `\n\nHere's what I had so far:\n${preview}`;
        }
        message += "\n\nWant me to try again?";
        return message;
      }

      notify(_getNotifyCtx(), {
        event: "error",
        workItemId: "exit-error",
        telegramMessage: `⚠️ Claude exited with code ${exitCode}`,
        gchatMessage: `⚠️ Claude exited with code ${exitCode}${stderr ? `: ${stderr.substring(0, 200)}` : ""}`,
      }).catch((err) => logger.error("Exit error notification failed", { detail: err.message }));

      if (session.sessionId && options?.resume !== false) {
        logger.warn("Resetting session after exit error", { sessionId: session.sessionId.slice(0, 8), exitCode });
        session.sessionId = null;
        session.lastActivity = new Date().toISOString();
        await saveSessionSafe(session);
      }

      const stderrPreview = stderr ? stderr.substring(0, 300) : null;
      let message = "Something went wrong and I had to stop (unexpected error).";
      if (stderrPreview) {
        message += `\n\nError details: ${stderrPreview}`;
      }
      message += "\n\nMy session has been reset. You can try your request again — I'll start fresh.";
      return message;
    }

    // Always log stderr — even on success, it may contain diagnostic info
    if (stderr?.trim()) {
      logger.info("CLI stderr (exit 0)", { stderr: stderr.substring(0, 500), outputLength: output.length });
    }

    logger.info(`Success: ${output.length} chars, exit ${exitCode}`);

    if (options?.resume !== false) {
      const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
      if (sessionMatch) {
        session.sessionId = sessionMatch[1];
        session.lastActivity = new Date().toISOString();
        await saveSessionSafe(session);
        logger.info(`Session ID: ${session.sessionId.slice(0, 8)}`);
      }
    }

    // Empty response guard — model likely spent entire turn on tool calls
    // with no text output (--output-format text only captures text blocks)
    const trimmed = output.trim();
    if (trimmed.length < 5) {
      logger.warn("Empty/near-empty response from CLI", {
        outputLength: output.length,
        trimmedLength: trimmed.length,
        rawPreview: JSON.stringify(output.substring(0, 50)),
        stderr: stderr?.substring(0, 300) || null,
        prompt_length: prompt.length,
      });
      return "I completed the work but didn't produce a text summary. You can ask \"what did you get done?\" to check, or retry the request.";
    }

    return trimmed;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("aborted") || msg.includes("Aborted")) {
      logger.warn("Dispatch aborted", { detail: msg });
      return "";  // Empty response — caller handles gracefully
    }
    logger.error("Spawn error", error);
    return `Error: Could not run Claude CLI — ${msg}`;
  }
}

// ── spawnClaudeStreaming ────────────────────────────────────────

/**
 * Spawn the Claude CLI with stream-json output, calling callbacks on tool_use events.
 * Falls back gracefully — if stream-json parsing fails, output is still returned.
 * Used by the coordinator to emit real-time tool activity events to the dashboard.
 */
export async function spawnClaudeStreaming(
  prompt: string,
  options: {
    timeoutMs?: number;
    allowedTools?: string[];
    onToolUse?: (toolName: string, toolInput: Record<string, unknown>) => void;
    onToolResult?: (toolName: string, durationMs: number) => void;
  },
): Promise<{ output: string; costUsd: number; isError: boolean }> {
  const args = [CLAUDE_PATH, "-p", "--verbose", "--output-format", "stream-json"];

  if (AGENT_MODE) {
    const tools = options.allowedTools?.length ? options.allowedTools : ALLOWED_TOOLS;
    args.push("--allowedTools", ...tools);
  }

  const TIMEOUT_MS = options.timeoutMs ?? CLI_TIMEOUT_MS;

  logger.info("spawnClaudeStreaming started", {
    prompt_chars: prompt.length,
    tools: options.allowedTools?.length ?? ALLOWED_TOOLS.length,
    timeout_ms: TIMEOUT_MS,
  });

  try {
    const proc = spawn(args, {
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
        CLAUDECODE: "",
        ANTHROPIC_API_KEY: "",
      },
    });

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const timeout = setTimeout(() => {
      timedOut = true;
      logger.error("spawnClaudeStreaming timeout — sending SIGTERM", { pid: proc.pid });
      proc.kill();
      killTimer = setTimeout(() => {
        try {
          process.kill(proc.pid, 0);
          proc.kill(9);
        } catch { /* already exited */ }
      }, 5_000);
    }, TIMEOUT_MS);

    // Track in-flight tool_use blocks for duration measurement
    const toolStartTimes = new Map<string, number>();

    // Stream stdout chunk-by-chunk, parsing JSON lines for tool events
    const chunks: string[] = [];
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let lineBuf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      chunks.push(text);
      lineBuf += text;

      // Process complete JSON lines
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop() ?? ""; // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          // Claude stream-json emits objects with a "type" field
          if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
            const toolName = evt.content_block.name ?? "unknown";
            toolStartTimes.set(evt.content_block.id ?? toolName, Date.now());
            try { options.onToolUse?.(toolName, evt.content_block.input ?? {}); } catch { /* best-effort */ }
          } else if (evt.type === "content_block_stop" && evt.index !== undefined) {
            // Tool block finished — try to find its start time
            // The stop event doesn't repeat the tool name, so we track by index
          } else if (evt.type === "result") {
            // Final result object — contains cost_usd, result text, etc.
            // We'll extract this below from the accumulated output
          }
          // Also detect tool_result in assistant message content
          if (evt.type === "content_block_start" && evt.content_block?.type === "tool_result") {
            const toolId = evt.content_block.tool_use_id;
            const startTime = toolStartTimes.get(toolId);
            if (startTime) {
              const durationMs = Date.now() - startTime;
              toolStartTimes.delete(toolId);
              try { options.onToolResult?.(toolId, durationMs); } catch { /* best-effort */ }
            }
          }
        } catch {
          // Not valid JSON or unexpected format — skip silently
        }
      }
    }

    const rawOutput = chunks.join("");
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);

    const exitCode = await proc.exited;

    if (stderr?.trim()) {
      logger.info("spawnClaudeStreaming stderr", { stderr: stderr.substring(0, 500) });
    }

    if (timedOut) {
      logger.error("spawnClaudeStreaming timed out", { timeout_ms: TIMEOUT_MS });
      return { output: `Task timed out after ${TIMEOUT_MS / 1000}s.`, costUsd: 0, isError: true };
    }

    if (exitCode !== 0) {
      logger.error("spawnClaudeStreaming non-zero exit", { exitCode, stderr: stderr?.substring(0, 300) });
    }

    // Try to extract structured result from the last JSON line (stream-json emits a final "result" object)
    let resultText = rawOutput;
    let costUsd = 0;
    let isError = false;
    try {
      // Find the last "result" type line
      const allLines = rawOutput.split("\n");
      for (let i = allLines.length - 1; i >= 0; i--) {
        const trimmed = allLines[i].trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === "result") {
            resultText = obj.result ?? rawOutput;
            costUsd = obj.cost_usd ?? obj.total_cost_usd ?? 0;
            isError = obj.is_error ?? false;
            break;
          }
        } catch { continue; }
      }
    } catch { /* use raw output */ }

    logger.info("spawnClaudeStreaming completed", {
      exit_code: exitCode,
      output_chars: resultText.length,
      cost_usd: costUsd,
    });

    return { output: resultText, costUsd, isError };
  } catch (error) {
    logger.error("spawnClaudeStreaming spawn error", error);
    return { output: "Error: Could not run Claude CLI", costUsd: 0, isError: true };
  }
}

// ── parseClaudeJsonOutput ────────────────────────────────────

export interface ClaudeJsonOutput {
  result: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
  sessionId?: string;
}

/**
 * Parse the JSON output from `claude -p --output-format json`.
 * Returns structured data including cost_usd for accurate cost tracking.
 */
export function parseClaudeJsonOutput(raw: string): ClaudeJsonOutput {
  try {
    const parsed = JSON.parse(raw);
    return {
      result: parsed.result ?? "",
      costUsd: parsed.cost_usd ?? parsed.total_cost_usd ?? 0,
      durationMs: parsed.duration_ms ?? 0,
      numTurns: parsed.num_turns ?? 1,
      isError: parsed.is_error ?? false,
      sessionId: parsed.session_id,
    };
  } catch {
    // If JSON parsing fails, treat the raw output as the result with zero cost
    logger.warn("Failed to parse Claude JSON output", { rawLength: raw.length, preview: raw.substring(0, 200) });
    return {
      result: raw,
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      isError: false,
    };
  }
}

// ── callClaudeWithTyping (Telegram typing heartbeat) ────────

export async function callClaudeWithTyping(
  ctx: Context,
  prompt: string,
  options?: { resume?: boolean; imagePath?: string; allowedTools?: string[]; model?: string; runId?: string }
): Promise<string> {
  const interval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4_000);

  try {
    return await callClaude(prompt, options);
  } finally {
    clearInterval(interval);
  }
}

// ── callClaudeVoice (fast Anthropic API for voice) ──────────

export async function callClaudeVoice(systemPrompt: string, userMessage: string): Promise<string> {
  const start = Date.now();

  if (_anthropic) {
    try {
      const response = await _anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });
      const text = response.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { type: string; text: string }) => b.text)
        .join("");
      logger.info(`Voice API responded in ${Date.now() - start}ms`);
      return text.trim();
    } catch (err) {
      const { recordAnthropicFailure } = await import("./llm-provider.ts");
      recordAnthropicFailure(err);
      logger.error("Voice API error, falling back to CLI", err);
    }
  }

  // Fallback: CLI without tools — pipe via stdin to avoid E2BIG
  const prompt = `${systemPrompt}\n\n${userMessage}`;
  const args = [CLAUDE_PATH, "-p", "--output-format", "text", "--model", "claude-haiku-4-5-20251001"];

  logger.info("Voice CLI fallback", { messagePreview: userMessage.substring(0, 80) });

  const proc = spawn(args, {
    stdin: new Blob([prompt]),
    stdout: "pipe", stderr: "pipe",
    cwd: PROJECT_DIR || undefined,
    env: { ...process.env, CLAUDECODE: "", ANTHROPIC_API_KEY: "" },
  });

  const timeout = setTimeout(() => proc.kill(), 60_000);
  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeout);

  if (await proc.exited !== 0) {
    logger.error("Voice CLI error", { stderr });
    return "Sorry, I had trouble processing that. Could you repeat?";
  }

  logger.info(`Voice CLI responded in ${Date.now() - start}ms`);
  return output.trim();
}

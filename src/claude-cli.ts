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

const logger = log.child("claude-cli");

// ── Config (from env) ───────────────────────────────────────

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const AGENT_MODE = process.env.AGENT_MODE !== "false";
const AGENT_MODEL_OVERRIDE = process.env.AGENT_MODEL_OVERRIDE === "true";
const DEFAULT_TOOLS = "Read,Edit,Write,Bash,Glob,Grep,WebSearch,WebFetch";
const MCP_TOOLS = "mcp__google-workspace__*,mcp__github__*,mcp__memory__*,mcp__sequential-thinking__*,mcp__plane__*,mcp__claude_ai_Miro__*,mcp__brave-search__*,mcp__excalidraw__*,mcp__forest-bridge__*";
const ALLOWED_TOOLS = (process.env.ALLOWED_TOOLS || `${DEFAULT_TOOLS},${MCP_TOOLS}`).split(",").map(t => t.trim());
const SESSION_FILE = join(RELAY_DIR, "session.json");
const LOCK_FILE = join(RELAY_DIR, "bot.lock");
// ELLIE-239: Configurable CLI timeout (default 300s agent, 60s non-agent)
const CLI_TIMEOUT_MS = parseInt(process.env.CLI_TIMEOUT_MS || (AGENT_MODE ? "300000" : "60000"));

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
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
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
  options?: { resume?: boolean; imagePath?: string; allowedTools?: string[]; model?: string; sessionId?: string; timeoutMs?: number; runId?: string }
): Promise<string> {
  // Prompt is piped via stdin to avoid E2BIG (ARG_MAX) on large prompts.
  // The positional [prompt] arg is omitted; claude -p reads from stdin.
  const args = [CLAUDE_PATH, "-p"];

  const resumeSessionId = options?.sessionId || session.sessionId;
  if (options?.resume && resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  args.push("--output-format", "text");

  if (AGENT_MODEL_OVERRIDE && options?.model) { args.push("--model", options.model); }

  if (AGENT_MODE) {
    const tools = options?.allowedTools?.length ? options.allowedTools : ALLOWED_TOOLS;
    args.push("--allowedTools", ...tools);
  }

  const flagArgs = args.slice(1).filter(a => a.startsWith("--"));
  const resumeId = options?.resume && resumeSessionId ? resumeSessionId.slice(0, 8) : null;
  const toolCount = options?.allowedTools?.length || ALLOWED_TOOLS.length;
  console.log(
    `[claude] Invoking: prompt=${prompt.length} chars` +
    `${resumeId ? `, resume=${resumeId}` : ""}` +
    `, tools=${toolCount}` +
    `, flags=[${flagArgs.join(", ")}]`
  );

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

    console.log(`[claude] Success: ${output.length} chars, exit ${exitCode}`);

    if (options?.resume !== false) {
      const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
      if (sessionMatch) {
        session.sessionId = sessionMatch[1];
        session.lastActivity = new Date().toISOString();
        await saveSessionSafe(session);
        console.log(`[claude] Session ID: ${session.sessionId.slice(0, 8)}`);
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
    logger.error("Spawn error", error);
    return `Error: Could not run Claude CLI`;
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
      console.log(`[voice] API responded in ${Date.now() - start}ms`);
      return text.trim();
    } catch (err) {
      logger.error("Voice API error, falling back to CLI", err);
    }
  }

  // Fallback: CLI without tools — pipe via stdin to avoid E2BIG
  const prompt = `${systemPrompt}\n\n${userMessage}`;
  const args = [CLAUDE_PATH, "-p", "--output-format", "text", "--model", "claude-haiku-4-5-20251001"];

  console.log(`[voice] Claude CLI fallback: ${userMessage.substring(0, 80)}...`);

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

  console.log(`[voice] CLI responded in ${Date.now() - start}ms`);
  return output.trim();
}

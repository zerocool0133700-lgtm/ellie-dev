/**
 * Simple Claude CLI helper for conversation summaries and memory extraction.
 * Extracted from conversations.ts for testability (ELLIE-506).
 */

import { spawn } from "bun";
import { log } from "./logger.ts";

const logger = log.child("summary-cli");
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

export async function callClaudeCLI(prompt: string): Promise<string> {
  const args = [CLAUDE_PATH, "-p", "--output-format", "text"];

  const proc = spawn(args, {
    stdin: new Blob([prompt]),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      CLAUDECODE: "",
      ANTHROPIC_API_KEY: "",
    },
  });

  const TIMEOUT_MS = 60_000;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timeout = setTimeout(() => {
    timedOut = true;
    logger.error("CLI timeout — sending SIGTERM", { timeoutMs: TIMEOUT_MS });
    proc.kill();
    killTimer = setTimeout(() => {
      try { process.kill(proc.pid, 0); proc.kill(9); } catch {}
    }, 5_000);
  }, TIMEOUT_MS);

  const output = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const msg = timedOut ? "timed out" : stderr || `exit code ${exitCode}`;
    throw new Error(`Claude CLI failed: ${msg}`);
  }

  return output.trim();
}

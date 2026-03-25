/**
 * Web Terminal — ELLIE-981
 *
 * WebSocket-based PTY handler for xterm.js in the dashboard.
 * Uses a Node.js subprocess bridge (scripts/pty-bridge.cjs) because
 * Bun's runtime doesn't support node-pty's native PTY file descriptors.
 *
 * Security:
 * - Only authenticated dashboard users can connect (same auth as ellie-chat)
 * - Max 5 concurrent terminals
 * - Idle timeout: 30 minutes
 * - Working directory defaults to /home/ellie
 */

import { WebSocket, WebSocketServer } from "ws";
import { spawn, type Subprocess } from "bun";
import { join } from "node:path";
import { log } from "./logger.ts";
import { EXTENSION_API_KEY } from "./relay-config.ts";

const logger = log.child("web-terminal");

const MAX_TERMINALS = 5;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_CWD = "/home/ellie";
const BRIDGE_SCRIPT = join(import.meta.dir, "../scripts/pty-bridge.cjs");
const NODE_PATH = "/usr/local/bin/node";

interface TerminalSession {
  id: string;
  bridge: Subprocess;
  pid: number;
  ws: WebSocket;
  createdAt: number;
  lastActivityAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
}

const terminals = new Map<string, TerminalSession>();

/** Get active terminal count. */
export function getTerminalCount(): number {
  return terminals.size;
}

/** Get terminal session info for health/status endpoints. */
export function getTerminalStatus(): { id: string; pid: number; createdAt: number; idleMs: number }[] {
  return Array.from(terminals.values()).map(t => ({
    id: t.id,
    pid: t.pid,
    createdAt: t.createdAt,
    idleMs: Date.now() - t.lastActivityAt,
  }));
}

function generateId(): string {
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function killTerminal(id: string, reason: string): void {
  const session = terminals.get(id);
  if (!session) return;

  clearTimeout(session.idleTimer);
  // Send kill to bridge
  try { sendToBridge(session, { type: "kill" }); } catch { /* bridge already dead */ }
  try { session.bridge.kill(); } catch { /* already dead */ }
  try {
    if (session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "terminal_closed", reason }));
      session.ws.close(1000, reason);
    }
  } catch { /* ws already closed */ }
  terminals.delete(id);
  logger.info(`Terminal closed: ${id} (${reason})`, { active: terminals.size });
}

function resetIdleTimer(session: TerminalSession): void {
  clearTimeout(session.idleTimer);
  session.lastActivityAt = Date.now();
  session.idleTimer = setTimeout(() => {
    killTerminal(session.id, "idle timeout");
  }, IDLE_TIMEOUT_MS);
}

function sendToBridge(session: TerminalSession, msg: Record<string, unknown>): void {
  const writer = session.bridge.stdin;
  if (writer) {
    writer.write(JSON.stringify(msg) + "\n");
  }
}

/** Handle a new terminal WebSocket connection. */
function handleTerminalConnection(ws: WebSocket): void {
  let authenticated = false;
  let termId: string | null = null;

  const authTimer = setTimeout(() => {
    if (!authenticated) ws.close(4001, "Auth timeout");
  }, 5000);

  ws.on("message", (data: Buffer | string) => {
    try {
      const raw = data.toString();

      // Before auth, expect JSON auth message
      if (!authenticated) {
        const msg = JSON.parse(raw);
        if (msg.type !== "auth") { ws.close(4003, "Expected auth"); return; }

        if (msg.key && msg.key === EXTENSION_API_KEY && EXTENSION_API_KEY) {
          authenticated = true;
          clearTimeout(authTimer);
        } else {
          ws.close(4003, "Invalid key");
          return;
        }

        if (terminals.size >= MAX_TERMINALS) {
          ws.send(JSON.stringify({ type: "error", message: `Max ${MAX_TERMINALS} terminals reached` }));
          ws.close(4004, "Terminal limit");
          return;
        }

        const cols = msg.cols || DEFAULT_COLS;
        const rows = msg.rows || DEFAULT_ROWS;
        const cwd = msg.cwd || DEFAULT_CWD;

        // Spawn Node.js bridge subprocess
        const bridge = spawn([NODE_PATH, BRIDGE_SCRIPT], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });

        termId = generateId();
        const session: TerminalSession = {
          id: termId,
          bridge,
          pid: 0,
          ws,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          idleTimer: setTimeout(() => {}, 0),
        };

        terminals.set(termId, session);
        resetIdleTimer(session);

        // Read bridge stdout line by line
        const reader = bridge.stdout.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = "";

        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              lineBuffer += decoder.decode(value, { stream: true });

              let newline;
              while ((newline = lineBuffer.indexOf("\n")) !== -1) {
                const line = lineBuffer.slice(0, newline);
                lineBuffer = lineBuffer.slice(newline + 1);
                if (!line.trim()) continue;

                try {
                  const msg = JSON.parse(line);

                  if (msg.type === "ready") {
                    session.pid = msg.pid;
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({
                        type: "terminal_ready",
                        id: termId,
                        pid: msg.pid,
                      }));
                    }
                    logger.info(`Terminal spawned: ${termId} (pid ${msg.pid})`, { active: terminals.size });
                  } else if (msg.type === "output") {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(msg.data);
                    }
                  } else if (msg.type === "exit") {
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: "terminal_exit", exitCode: msg.exitCode }));
                    }
                    killTerminal(termId!, "process exited");
                  } else if (msg.type === "error") {
                    logger.error(`Bridge error: ${msg.message}`);
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(JSON.stringify({ type: "error", message: msg.message }));
                    }
                  }
                } catch {
                  // Malformed JSON from bridge — ignore
                }
              }
            }
          } catch (err) {
            // Bridge stdout closed
            if (termId && terminals.has(termId)) {
              killTerminal(termId, "bridge disconnected");
            }
          }
        })();

        // Send spawn command to bridge
        sendToBridge(session, { type: "spawn", cols, rows, cwd });
        return;
      }

      // After auth: handle input
      if (termId) {
        const session = terminals.get(termId);
        if (session) {
          // Check for JSON control messages
          if (raw.startsWith("{")) {
            try {
              const ctrl = JSON.parse(raw);
              if (ctrl.type === "resize" && ctrl.cols && ctrl.rows) {
                sendToBridge(session, { type: "resize", cols: ctrl.cols, rows: ctrl.rows });
                resetIdleTimer(session);
                return;
              }
              if (ctrl.type === "ping") {
                ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
                return;
              }
            } catch {
              // Not valid JSON — treat as regular input
            }
          }

          sendToBridge(session, { type: "input", data: raw });
          resetIdleTimer(session);
        }
      }
    } catch (err) {
      logger.error("Terminal message error", err);
    }
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    if (termId) killTerminal(termId, "client disconnected");
  });

  ws.on("error", () => {
    clearTimeout(authTimer);
    if (termId) killTerminal(termId, "ws error");
  });
}

/** Kill all terminals — called on shutdown. */
export function killAllTerminals(): void {
  for (const id of Array.from(terminals.keys())) {
    killTerminal(id, "server shutdown");
  }
}

/** Create the terminal WebSocket server and wire into upgrade routing. */
export function createTerminalWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", handleTerminalConnection);
  return wss;
}

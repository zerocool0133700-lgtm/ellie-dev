/**
 * Web Terminal — ELLIE-981
 *
 * WebSocket-based PTY handler for xterm.js in the dashboard.
 * Spawns a real shell (bash) and bridges stdin/stdout over WebSocket.
 *
 * Security:
 * - Only authenticated dashboard users can connect (same auth as ellie-chat)
 * - Max 5 concurrent terminals
 * - Idle timeout: 30 minutes
 * - Working directory defaults to /home/ellie
 */

import { WebSocket, WebSocketServer } from "ws";
import type { Server as HttpServer } from "node:http";
import * as pty from "node-pty";
import { log } from "./logger.ts";
import { EXTENSION_API_KEY } from "./relay-config.ts";

const logger = log.child("web-terminal");

const MAX_TERMINALS = 5;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_CWD = "/home/ellie";

interface TerminalSession {
  id: string;
  ptyProcess: pty.IPty;
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
    pid: t.ptyProcess.pid,
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
  try { session.ptyProcess.kill(); } catch { /* already dead */ }
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

        // Same auth as ellie-chat: shared key
        if (msg.key && msg.key === EXTENSION_API_KEY && EXTENSION_API_KEY) {
          authenticated = true;
          clearTimeout(authTimer);
        } else {
          ws.close(4003, "Invalid key");
          return;
        }

        // Check terminal limit
        if (terminals.size >= MAX_TERMINALS) {
          ws.send(JSON.stringify({ type: "error", message: `Max ${MAX_TERMINALS} terminals reached` }));
          ws.close(4004, "Terminal limit");
          return;
        }

        // Spawn PTY
        const cols = msg.cols || DEFAULT_COLS;
        const rows = msg.rows || DEFAULT_ROWS;
        const cwd = msg.cwd || DEFAULT_CWD;

        const shell = process.env.SHELL || "/bin/bash";
        const ptyProcess = pty.spawn(shell, [], {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
          } as Record<string, string>,
        });

        termId = generateId();
        const session: TerminalSession = {
          id: termId,
          ptyProcess,
          ws,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          idleTimer: setTimeout(() => {}, 0), // placeholder
        };

        terminals.set(termId, session);
        resetIdleTimer(session);

        // PTY output → WebSocket
        ptyProcess.onData((output: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(output);
          }
        });

        ptyProcess.onExit(({ exitCode }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "terminal_exit", exitCode }));
          }
          killTerminal(termId!, "process exited");
        });

        ws.send(JSON.stringify({
          type: "terminal_ready",
          id: termId,
          pid: ptyProcess.pid,
        }));

        logger.info(`Terminal spawned: ${termId} (pid ${ptyProcess.pid})`, { active: terminals.size });
        return;
      }

      // After auth: raw data goes to PTY stdin
      if (termId) {
        const session = terminals.get(termId);
        if (session) {
          // Check for JSON control messages
          if (raw.startsWith("{")) {
            try {
              const ctrl = JSON.parse(raw);
              if (ctrl.type === "resize" && ctrl.cols && ctrl.rows) {
                session.ptyProcess.resize(ctrl.cols, ctrl.rows);
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

          session.ptyProcess.write(raw);
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

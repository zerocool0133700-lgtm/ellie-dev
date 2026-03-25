#!/usr/bin/env node
/**
 * PTY Bridge — runs under Node.js (not Bun) to work around Bun's
 * node-pty incompatibility. Communicates with parent via stdin/stdout JSON lines.
 *
 * Protocol:
 *   Parent → Bridge: { type: "spawn", cols, rows, cwd, shell }
 *   Parent → Bridge: { type: "input", data: "..." }
 *   Parent → Bridge: { type: "resize", cols, rows }
 *   Parent → Bridge: { type: "kill" }
 *   Bridge → Parent: { type: "output", data: "..." }
 *   Bridge → Parent: { type: "exit", exitCode }
 *   Bridge → Parent: { type: "ready", pid }
 *   Bridge → Parent: { type: "error", message }
 */

const pty = require("node-pty");

let ptyProcess = null;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      handleMessage(JSON.parse(line));
    } catch (err) {
      send({ type: "error", message: "Parse error: " + err.message });
    }
  }
});

function handleMessage(msg) {
  switch (msg.type) {
    case "spawn": {
      if (ptyProcess) {
        send({ type: "error", message: "Already spawned" });
        return;
      }
      const shell = msg.shell || process.env.SHELL || "/bin/bash";
      ptyProcess = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: msg.cols || 120,
        rows: msg.rows || 30,
        cwd: msg.cwd || process.env.HOME,
        env: Object.assign({}, process.env, {
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        }),
      });

      ptyProcess.onData(function (data) {
        send({ type: "output", data: data });
      });

      ptyProcess.onExit(function (info) {
        send({ type: "exit", exitCode: info.exitCode });
        process.exit(0);
      });

      send({ type: "ready", pid: ptyProcess.pid });
      break;
    }

    case "input":
      if (ptyProcess) ptyProcess.write(msg.data);
      break;

    case "resize":
      if (ptyProcess && msg.cols && msg.rows) {
        ptyProcess.resize(msg.cols, msg.rows);
      }
      break;

    case "kill":
      if (ptyProcess) ptyProcess.kill();
      process.exit(0);
      break;
  }
}

process.stdin.on("end", function () {
  if (ptyProcess) ptyProcess.kill();
  process.exit(0);
});

process.on("SIGTERM", function () {
  if (ptyProcess) ptyProcess.kill();
  process.exit(0);
});

/**
 * Ellie Relay Feed — Side Panel
 *
 * Owns the WebSocket connection directly (avoids MV3 service worker suspension).
 */

const feed = document.getElementById("feed");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save-btn");
const reconnectBtn = document.getElementById("reconnect-btn");
const clearBtn = document.getElementById("clear-btn");
const MAX_NODES = 500;

let ws = null;
let reconnectDelay = 1000;
let reconnectTimer = null;

// Start connection on load
chrome.storage.local.get(["serverUrl", "apiKey"], (settings) => {
  if (settings.serverUrl && settings.apiKey) {
    connect(settings.serverUrl, settings.apiKey);
  } else {
    showEmptyState("Open extension options to configure server URL and API key.");
  }
});

// Reconnect if settings change while panel is open
chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl || changes.apiKey) {
    chrome.storage.local.get(["serverUrl", "apiKey"], (settings) => {
      if (settings.serverUrl && settings.apiKey) {
        disconnect();
        connect(settings.serverUrl, settings.apiKey);
      }
    });
  }
});

reconnectBtn.addEventListener("click", () => {
  chrome.storage.local.get(["serverUrl", "apiKey"], (settings) => {
    if (settings.serverUrl && settings.apiKey) {
      disconnect();
      connect(settings.serverUrl, settings.apiKey);
    }
  });
});

clearBtn.addEventListener("click", () => {
  feed.innerHTML = "";
  showEmptyState();
});

saveBtn.addEventListener("click", () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    saveBtn.textContent = "\u274C";
    setTimeout(() => { saveBtn.textContent = "\uD83D\uDCBE"; }, 1500);
    return;
  }
  // Collect feed text content (skip empty-state placeholders)
  const lines = [];
  for (const node of feed.children) {
    if (node.classList.contains("empty-state")) continue;
    lines.push(node.textContent);
  }
  if (lines.length === 0) return;

  ws.send(JSON.stringify({ type: "save_feed", content: lines.join("\n") }));
  feed.innerHTML = "";
  showEmptyState("Feed saved to log.");
  saveBtn.textContent = "\u2705";
  setTimeout(() => { saveBtn.textContent = "\uD83D\uDCBE"; }, 1500);
});

// ── WebSocket ────────────────────────────────────────────────

function connect(serverUrl, apiKey) {
  if (ws) disconnect();

  const wsUrl = serverUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/extension";
  setStatus("connecting");

  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.error("[ellie] WebSocket create error:", err);
    setStatus(false);
    scheduleReconnect(serverUrl, apiKey);
    return;
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "auth", key: apiKey }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);

      if (msg.type === "auth_ok") {
        reconnectDelay = 1000;
        setStatus(true);
        removeEmptyState();
        return;
      }

      if (msg.type === "error" && statusEl.textContent !== "Connected") {
        console.error("[ellie] Auth failed");
        setStatus(false);
        disconnect();
        return;
      }

      if (msg.type === "ping") {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "pong" }));
        }
        return;
      }

      // Render event
      console.log("[ellie] Event received:", msg.type, msg);
      removeEmptyState();
      appendEvent(msg, true);
    } catch (err) {
      console.error("[ellie] Error handling message:", err);
    }
  };

  ws.onclose = (ev) => {
    const wasConnected = statusEl.textContent === "Connected";
    ws = null;
    setStatus(false);
    if (wasConnected || ev.code !== 4003) {
      scheduleReconnect(serverUrl, apiKey);
    }
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  setStatus(false);
}

function scheduleReconnect(serverUrl, apiKey) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    connect(serverUrl, apiKey);
  }, reconnectDelay);
}

// ── UI ───────────────────────────────────────────────────────

function setStatus(state) {
  if (state === true) {
    statusEl.textContent = "Connected";
    statusEl.className = "status connected";
  } else if (state === "connecting") {
    statusEl.textContent = "Connecting...";
    statusEl.className = "status disconnected";
  } else {
    statusEl.textContent = "Disconnected";
    statusEl.className = "status disconnected";
  }
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function channelBadge(channel) {
  if (!channel) return "";
  return `<span class="channel channel-${channel}">${channel}</span>`;
}

function appendEvent(event, autoScroll) {
  const el = document.createElement("div");
  el.className = `event ${event.type || "unknown"}`;

  const time = `<span class="time">${formatTime(event.ts)}</span>`;
  const channel = channelBadge(event.channel);

  switch (event.type) {
    case "message_in":
      el.innerHTML = `${time}${channel}<span class="label">IN:</span><span class="preview">${esc(event.preview || "")}</span>`;
      break;

    case "message_out":
      el.innerHTML = `${time}${channel}<span class="label">OUT</span> <span class="meta">${esc(event.agent || "")}</span>: <span class="preview">${esc(event.preview || "")}</span>`;
      break;

    case "route":
      el.innerHTML = `${time}${channel}<span class="label">ROUTE:</span> <span class="meta">${esc(event.agent || "?")} (${esc(event.mode || "single")}${event.confidence ? `, ${(event.confidence * 100).toFixed(0)}%` : ""})</span>`;
      break;

    case "queue_status":
      if (event.busy) {
        el.innerHTML = `${time}<span class="label">QUEUE:</span> <span class="meta">Busy — ${event.queueLength || 0} waiting${event.current ? ` (${esc(event.current.channel)}: ${esc(event.current.preview || "")})` : ""}</span>`;
      } else {
        el.innerHTML = `${time}<span class="label">QUEUE:</span> <span class="meta">Idle</span>`;
      }
      break;

    case "pipeline_start":
      el.innerHTML = `${time}${channel}<span class="label">PIPELINE START:</span> <span class="meta">${esc(event.mode || "")} — ${event.steps || 0} steps</span>`;
      break;

    case "pipeline_complete":
      el.innerHTML = `${time}${channel}<span class="label">PIPELINE DONE:</span> <span class="meta">${esc(event.mode || "")} — ${event.steps || 0} steps, ${event.duration_ms ? (event.duration_ms / 1000).toFixed(1) + "s" : "?"}, $${event.cost_usd?.toFixed(4) || "?"}</span>`;
      break;

    case "error":
      el.innerHTML = `${time}<span class="label">ERROR:</span> <span class="preview">${esc(event.source || "")} — ${esc(event.message || "")}</span>`;
      break;

    default:
      el.innerHTML = `${time}<span class="meta">${esc(event.type || "unknown")}: ${esc(JSON.stringify(event).substring(0, 200))}</span>`;
  }

  feed.appendChild(el);

  // Cap DOM size
  while (feed.children.length > MAX_NODES) {
    feed.removeChild(feed.firstChild);
  }

  if (autoScroll) {
    scrollToBottom();
  }
}

function scrollToBottom() {
  feed.scrollTop = feed.scrollHeight;
}

function showEmptyState(message) {
  if (!feed.querySelector(".empty-state")) {
    const el = document.createElement("div");
    el.className = "empty-state";
    el.textContent = message || "Waiting for events...";
    feed.appendChild(el);
  }
}

function removeEmptyState() {
  const el = feed.querySelector(".empty-state");
  if (el) el.remove();
}

function esc(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

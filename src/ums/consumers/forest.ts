/**
 * UMS Consumer: Forest (Knowledge Base)
 *
 * ELLIE-305: Push subscriber — extracts knowledge from messages
 * and writes findings to the Forest via Bridge API.
 *
 * Listens to: notifications (GitHub, documents) + high-signal conversational messages
 * Action: writes findings/facts to Forest Bridge for long-term knowledge
 *
 * Cross-ref: src/api/bridge.ts bridgeWriteEndpoint() for the write API shape
 */

import type { UnifiedMessage } from "../types.ts";
import { subscribe } from "../events.ts";
import { log } from "../../logger.ts";

const logger = log.child("ums-consumer-forest");

const BRIDGE_URL = "http://localhost:3001/api/bridge/write";
const BRIDGE_KEY = "bk_d81869ef1556947b38376429ab2d9752ec0ed2799dc85d968532a6e740f6577a";

/** Providers/types that contain knowledge worth preserving. */
const KNOWLEDGE_SOURCES: Record<string, string[]> = {
  github: ["notification"],
  documents: ["notification"],
  gmail: ["text"],
  calendar: ["event"],
};

/**
 * Initialize the Forest consumer.
 * Subscribes to knowledge-bearing messages and writes to the Forest.
 */
export function initForestConsumer(): void {
  subscribe("consumer:forest", {}, async (message) => {
    try {
      await handleMessage(message);
    } catch (err) {
      logger.error("Forest consumer failed", { messageId: message.id, err });
    }
  });
  logger.info("Forest consumer initialized");
}

async function handleMessage(message: UnifiedMessage): Promise<void> {
  const allowedTypes = KNOWLEDGE_SOURCES[message.provider];
  if (!allowedTypes || !allowedTypes.includes(message.content_type)) return;
  if (!message.content?.trim()) return;

  const finding = buildFinding(message);
  if (!finding) return;

  await writeToBridge(finding);
}

interface BridgeFinding {
  content: string;
  type: "finding" | "fact";
  scope_path: string;
  confidence: number;
  tags: string[];
  metadata: Record<string, unknown>;
}

function buildFinding(message: UnifiedMessage): BridgeFinding | null {
  switch (message.provider) {
    case "github":
      return buildGitHubFinding(message);
    case "documents":
      return buildDocumentFinding(message);
    case "gmail":
      return buildEmailFinding(message);
    case "calendar":
      return buildCalendarFinding(message);
    default:
      return null;
  }
}

function buildGitHubFinding(message: UnifiedMessage): BridgeFinding {
  const meta = message.metadata || {};
  return {
    content: message.content!,
    type: "finding",
    scope_path: "2/1", // ellie-dev scope
    confidence: 0.8,
    tags: ["github", meta.event_type as string, meta.repo as string].filter(Boolean),
    metadata: {
      source: "ums-forest-consumer",
      provider: "github",
      event_type: meta.event_type,
      repo: meta.repo,
      url: meta.url,
      message_id: message.id,
    },
  };
}

function buildDocumentFinding(message: UnifiedMessage): BridgeFinding {
  const meta = message.metadata || {};
  return {
    content: message.content!,
    type: "finding",
    scope_path: "2", // root project scope
    confidence: 0.6,
    tags: ["document", meta.change_type as string, meta.doc_provider as string].filter(Boolean),
    metadata: {
      source: "ums-forest-consumer",
      provider: "documents",
      doc_id: meta.doc_id,
      doc_title: meta.doc_title,
      message_id: message.id,
    },
  };
}

function buildEmailFinding(message: UnifiedMessage): BridgeFinding | null {
  // Only capture emails with substantive content
  if (!message.content || message.content.length < 50) return null;
  const meta = message.metadata || {};
  return {
    content: `Email: ${message.content.slice(0, 500)}`,
    type: "finding",
    scope_path: "2",
    confidence: 0.5,
    tags: ["email", meta.thread_id ? "thread" : "standalone"].filter(Boolean),
    metadata: {
      source: "ums-forest-consumer",
      provider: "gmail",
      subject: meta.subject,
      thread_id: meta.thread_id,
      message_id: message.id,
    },
  };
}

function buildCalendarFinding(message: UnifiedMessage): BridgeFinding {
  const meta = message.metadata || {};
  return {
    content: message.content!,
    type: "fact",
    scope_path: "2",
    confidence: 0.9,
    tags: ["calendar", meta.status as string].filter(Boolean),
    metadata: {
      source: "ums-forest-consumer",
      provider: "calendar",
      event_id: meta.event_id,
      start_time: meta.start_time,
      message_id: message.id,
    },
  };
}

async function writeToBridge(finding: BridgeFinding): Promise<void> {
  try {
    const resp = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-key": BRIDGE_KEY,
      },
      body: JSON.stringify(finding),
    });

    if (!resp.ok) {
      logger.error("Forest consumer: Bridge write failed", { status: resp.status });
      return;
    }

    logger.debug("Forest consumer: finding written", {
      type: finding.type,
      scope: finding.scope_path,
      tags: finding.tags,
    });
  } catch (err) {
    logger.error("Forest consumer: Bridge request failed", { err });
  }
}

/**
 * Brain Dump Mode — ELLIE-774
 * A capture mode where the agent listens without interrupting,
 * then structures the dump into proposed River documents.
 * Pure functions with in-memory session state.
 */

import { refineCapture, type RefinementResult } from "./refinement-engine.ts";
import type { CaptureContentType, Channel } from "../capture-queue.ts";

// Types

export interface DumpSession {
  id: string;
  channel: Channel;
  started_at: string;
  messages: DumpMessage[];
  status: "active" | "processing" | "complete" | "cancelled";
  results?: DumpResults;
}

export interface DumpMessage {
  text: string;
  timestamp: string;
  is_voice: boolean;
}

export interface DumpItem {
  category: "decision" | "workflow" | "question" | "ticket" | "process" | "policy" | "reference";
  content: string;
  refinement: RefinementResult;
}

export interface DumpResults {
  items: DumpItem[];
  summary: string;
  total_words: number;
  duration_seconds: number;
}

// Trigger / exit detection

const TRIGGER_PHRASES = [
  "brain dump",
  "braindump",
  "brain-dump",
  "dump mode",
  "let me dump",
  "start dump",
  "capture mode",
];

const EXIT_PHRASES = [
  "done",
  "that's it",
  "thats it",
  "end dump",
  "stop dump",
  "finish dump",
  "i'm done",
  "im done",
  "all done",
];

export function isTriggerPhrase(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return TRIGGER_PHRASES.some(p => lower.includes(p));
}

export function isExitPhrase(text: string): boolean {
  const lower = text.toLowerCase().trim();
  // Must be short-ish to avoid false positives in long messages
  if (lower.length > 40) return false;
  return EXIT_PHRASES.some(p => lower === p || lower.startsWith(p + " ") || lower.endsWith(" " + p));
}

// Session management (in-memory)

const sessions = new Map<string, DumpSession>();

export function startSession(sessionKey: string, channel: Channel): DumpSession {
  const session: DumpSession = {
    id: sessionKey,
    channel,
    started_at: new Date().toISOString(),
    messages: [],
    status: "active",
  };
  sessions.set(sessionKey, session);
  return session;
}

export function getSession(sessionKey: string): DumpSession | null {
  return sessions.get(sessionKey) ?? null;
}

export function addMessage(sessionKey: string, text: string, isVoice: boolean = false): boolean {
  const session = sessions.get(sessionKey);
  if (!session || session.status !== "active") return false;
  session.messages.push({
    text,
    timestamp: new Date().toISOString(),
    is_voice: isVoice,
  });
  return true;
}

export function cancelSession(sessionKey: string): boolean {
  const session = sessions.get(sessionKey);
  if (!session) return false;
  session.status = "cancelled";
  sessions.delete(sessionKey);
  return true;
}

export function isSessionActive(sessionKey: string): boolean {
  const session = sessions.get(sessionKey);
  return session?.status === "active";
}

// Content segmentation — split a brain dump into discrete topics

export function segmentDump(messages: DumpMessage[]): string[] {
  if (messages.length === 0) return [];

  // Each message is at least one segment; within a message, topic transitions create further splits
  const segments: string[] = [];

  for (const msg of messages) {
    const parts = msg.text.split(/\n\n+/);
    let current = "";

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const isNewTopic = /^(also|another thing|oh and|next|separately|on a different note|moving on)/i.test(trimmed)
        || /^\d+[\.\)]\s/.test(trimmed);

      if (isNewTopic && current) {
        segments.push(current.trim());
        current = trimmed;
      } else if (!current) {
        current = trimmed;
      } else {
        // Different paragraph within same message — new segment
        segments.push(current.trim());
        current = trimmed;
      }
    }
    if (current.trim()) segments.push(current.trim());
  }

  return segments;
}

// Classify a segment into a dump category

export function classifySegment(text: string): DumpItem["category"] {
  const lower = text.toLowerCase();

  // Questions
  if (/\?/.test(text) && (lower.includes("should we") || lower.includes("what if") ||
      lower.includes("how do") || lower.includes("can we") || lower.includes("wondering"))) {
    return "question";
  }

  // Tickets
  if (lower.includes("need to") || lower.includes("todo") || lower.includes("to-do") ||
      lower.includes("should fix") || lower.includes("bug") || lower.includes("broken")) {
    return "ticket";
  }

  // Decisions
  if (lower.includes("decided") || lower.includes("going with") || lower.includes("chose") ||
      lower.includes("picking") || lower.includes("let's use") || lower.includes("we'll go")) {
    return "decision";
  }

  // Workflows
  if (lower.includes("steps") || lower.includes("first") && lower.includes("then") ||
      lower.includes("pipeline") || lower.includes("flow")) {
    return "workflow";
  }

  // Policies
  if (lower.includes("must") || lower.includes("never") || lower.includes("always") ||
      lower.includes("rule") || lower.includes("policy")) {
    return "policy";
  }

  // Processes
  if (lower.includes("how to") || lower.includes("procedure") || lower.includes("every time")) {
    return "process";
  }

  return "reference";
}

// Map dump category to CaptureContentType

function categoryToContentType(category: DumpItem["category"]): CaptureContentType {
  switch (category) {
    case "decision": return "decision";
    case "workflow": return "workflow";
    case "process": return "process";
    case "policy": return "policy";
    case "ticket": return "reference";
    case "question": return "reference";
    case "reference": return "reference";
  }
}

// Process a completed brain dump

export function processDump(session: DumpSession): DumpResults {
  session.status = "processing";

  const segments = segmentDump(session.messages);
  const totalWords = session.messages.reduce((sum, m) => sum + m.text.split(/\s+/).length, 0);
  const startTime = new Date(session.started_at).getTime();
  const endTime = session.messages.length > 0
    ? new Date(session.messages[session.messages.length - 1].timestamp).getTime()
    : startTime;
  const durationSeconds = Math.round((endTime - startTime) / 1000);

  const items: DumpItem[] = segments.map(segment => {
    const category = classifySegment(segment);
    const contentType = categoryToContentType(category);
    const refinement = refineCapture({
      raw_content: segment,
      channel: session.channel,
      hint_content_type: contentType,
    });
    return { category, content: segment, refinement };
  });

  const categoryCounts: Record<string, number> = {};
  for (const item of items) {
    categoryCounts[item.category] = (categoryCounts[item.category] ?? 0) + 1;
  }
  const summaryParts = Object.entries(categoryCounts).map(([k, v]) => `${v} ${k}${v > 1 ? "s" : ""}`);
  const summary = `Found ${items.length} items: ${summaryParts.join(", ")}. ${totalWords} words over ${Math.round(durationSeconds / 60)} min.`;

  const results: DumpResults = { items, summary, total_words: totalWords, duration_seconds: durationSeconds };
  session.results = results;
  session.status = "complete";

  return results;
}

// End session and process

export function endSession(sessionKey: string): DumpResults | null {
  const session = sessions.get(sessionKey);
  if (!session || session.status !== "active") return null;

  const results = processDump(session);
  sessions.delete(sessionKey);
  return results;
}

// Build the acknowledgment message for starting a dump

export function buildStartMessage(channel: Channel): string {
  switch (channel) {
    case "voice":
      return "Brain dump mode. Go ahead, I'm listening. Say 'done' when you're finished.";
    case "telegram":
      return "📝 Brain dump mode — go ahead. I'll listen without interrupting. Say \"done\" when finished.";
    default:
      return "Brain dump mode active. Go ahead — I'll listen without interrupting. Say \"done\" when you're finished.";
  }
}

// Build the results summary message

export function buildResultsMessage(results: DumpResults): string {
  if (results.items.length === 0) {
    return "Dump processed but no actionable items found. Try being more specific about decisions, workflows, or tasks.";
  }

  const lines: string[] = [`**Brain Dump Complete** — ${results.summary}`, ""];

  for (let i = 0; i < results.items.length; i++) {
    const item = results.items[i];
    const icon = { decision: "⚖️", workflow: "🔄", question: "❓", ticket: "🎫", process: "📋", policy: "📜", reference: "📝" }[item.category];
    lines.push(`${i + 1}. ${icon} **${item.refinement.title}** (${item.category})`);
    lines.push(`   → ${item.refinement.suggested_path}`);
  }

  lines.push("", "Reply with numbers to approve (e.g., \"approve 1 3 5\") or \"approve all\".");
  return lines.join("\n");
}

// For testing — clear all sessions
export function _clearSessions(): void {
  sessions.clear();
}

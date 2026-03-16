/**
 * Template-Prompted Capture Flow — ELLIE-782
 * Guided Q&A session that builds a structured River doc section by section.
 * Detects topic gaps, selects templates, and walks user through questions.
 */

import {
  getTemplate,
  selectTemplate,
  renderTemplate,
  getGuidedQuestions,
  type RiverTemplate,
} from "./template-library.ts";
import type { CaptureContentType, Channel } from "../capture-queue.ts";
import type { QmdClient } from "./dedup-detector.ts";

// Types

export interface TemplateCaptureSession {
  id: string;
  channel: Channel;
  topic: string;
  template: RiverTemplate;
  current_section: number;
  answers: Record<string, string>;
  status: "active" | "complete" | "cancelled";
  started_at: string;
}

export interface TopicGapResult {
  is_gap: boolean;
  topic: string;
  suggested_type: CaptureContentType;
  existing_docs: string[];
}

// Topic gap detection

const TOPIC_PATTERNS = [
  /\b(?:let'?s?\s+talk\s+about|tell\s+me\s+about|what'?s?\s+(?:the|our))\s+(.{5,60}?)(?:\?|$|\.)/i,
  /\b(?:how\s+does?|how\s+do\s+we)\s+(.{5,60}?)(?:\?|$|\.|\s+work)/i,
  /\b(?:what'?s?\s+the\s+process\s+for|the\s+flow\s+for)\s+(.{5,60}?)(?:\?|$|\.)/i,
  /\b(?:explain|describe|walk\s+me\s+through)\s+(.{5,60}?)(?:\?|$|\.)/i,
];

export function extractTopic(text: string): string | null {
  for (const pattern of TOPIC_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1].trim().replace(/[.!?,;:]+$/, "");
    }
  }
  return null;
}

export async function detectTopicGap(
  text: string,
  qmd: QmdClient,
  minScore: number = 0.7,
): Promise<TopicGapResult | null> {
  const topic = extractTopic(text);
  if (!topic) return null;

  let results;
  try {
    results = await qmd.search(topic, { minScore, limit: 3 });
  } catch {
    // If QMD fails, don't block — assume no gap
    return null;
  }

  if (results.length > 0) {
    return {
      is_gap: false,
      topic,
      suggested_type: "reference",
      existing_docs: results.map(r => r.path),
    };
  }

  // Infer type from conversation context
  const lower = text.toLowerCase();
  let suggestedType: CaptureContentType = "reference";
  if (/\b(flow|workflow|pipeline|deploy|sequence)\b/i.test(lower)) suggestedType = "workflow";
  else if (/\b(process|procedure|how\s+to|onboard|routine)\b/i.test(lower)) suggestedType = "process";
  else if (/\b(rule|policy|must|never|compliance)\b/i.test(lower)) suggestedType = "policy";
  else if (/\b(decided|choose|pick|option|versus)\b/i.test(lower)) suggestedType = "decision";
  else if (/\b(api|endpoint|webhook|integration|connect)\b/i.test(lower)) suggestedType = "integration";

  return {
    is_gap: true,
    topic,
    suggested_type: suggestedType,
    existing_docs: [],
  };
}

// Session management

const sessions = new Map<string, TemplateCaptureSession>();

export function startTemplateCapture(
  sessionKey: string,
  channel: Channel,
  topic: string,
  contentType: CaptureContentType,
  templateHint?: string,
): TemplateCaptureSession {
  const template = selectTemplate(contentType, templateHint);

  const session: TemplateCaptureSession = {
    id: sessionKey,
    channel,
    topic,
    template,
    current_section: 0,
    answers: { title: topic },
    status: "active",
    started_at: new Date().toISOString(),
  };

  sessions.set(sessionKey, session);
  return session;
}

export function getTemplateSession(sessionKey: string): TemplateCaptureSession | null {
  return sessions.get(sessionKey) ?? null;
}

export function isTemplateCaptureActive(sessionKey: string): boolean {
  const s = sessions.get(sessionKey);
  return s?.status === "active";
}

// Get the current question

export function getCurrentQuestion(session: TemplateCaptureSession): { heading: string; question: string; index: number; total: number } | null {
  const questions = getGuidedQuestions(session.template.id);
  if (session.current_section >= questions.length) return null;

  const q = questions[session.current_section];
  return {
    heading: q.heading,
    question: q.question,
    index: session.current_section,
    total: questions.length,
  };
}

// Process user answer and advance

export function processAnswer(
  sessionKey: string,
  answer: string,
): { advanced: boolean; finished: boolean; message: string } {
  const session = sessions.get(sessionKey);
  if (!session || session.status !== "active") {
    return { advanced: false, finished: true, message: "No active template capture session." };
  }

  const questions = getGuidedQuestions(session.template.id);
  if (session.current_section >= questions.length) {
    return finishCapture(session);
  }

  const currentQ = questions[session.current_section];

  // Handle skip
  const lower = answer.toLowerCase().trim();
  if (lower === "skip" || lower === "pass" || lower === "next") {
    session.current_section++;
    if (session.current_section >= questions.length) {
      return finishCapture(session);
    }
    return { advanced: true, finished: false, message: "" };
  }

  // Handle cancel
  if (lower === "cancel" || lower === "stop" || lower === "quit") {
    session.status = "cancelled";
    sessions.delete(sessionKey);
    return { advanced: false, finished: true, message: "Template capture cancelled." };
  }

  // Store answer
  session.answers[currentQ.heading.toLowerCase()] = answer;
  session.current_section++;

  if (session.current_section >= questions.length) {
    return finishCapture(session);
  }

  return { advanced: true, finished: false, message: "" };
}

function finishCapture(session: TemplateCaptureSession): { advanced: boolean; finished: boolean; message: string } {
  session.status = "complete";
  const markdown = renderTemplate(session.template, session.answers);
  const message = buildCompletionMessage(session, markdown);
  sessions.delete(session.id);
  return { advanced: false, finished: true, message };
}

// Build the rendered doc from session

export function buildDocFromSession(session: TemplateCaptureSession): string {
  return renderTemplate(session.template, session.answers);
}

// Get progress preview

export function getProgress(session: TemplateCaptureSession): {
  completed: number;
  total: number;
  percent: number;
  filled_sections: string[];
} {
  const questions = getGuidedQuestions(session.template.id);
  const filled = questions.filter(q => session.answers[q.heading.toLowerCase()]);
  return {
    completed: filled.length,
    total: questions.length,
    percent: Math.round((filled.length / questions.length) * 100),
    filled_sections: filled.map(q => q.heading),
  };
}

// Messages

export function buildGapOfferMessage(topic: string, contentType: CaptureContentType): string {
  return `I don't see a doc about "${topic}" in the River yet. Want to build one? I'll walk you through a ${contentType} template section by section.`;
}

export function buildQuestionMessage(heading: string, question: string, index: number, total: number): string {
  return `**${heading}** (${index + 1}/${total})\n${question}\n\n_Say "skip" to skip this section._`;
}

function buildCompletionMessage(session: TemplateCaptureSession, markdown: string): string {
  const progress = getProgress(session);
  const lines = [
    `**Template Capture Complete** — "${session.topic}"`,
    `Filled ${progress.completed} of ${progress.total} sections.`,
    "",
    "Here's the draft:",
    "```markdown",
    markdown.substring(0, 500) + (markdown.length > 500 ? "\n..." : ""),
    "```",
    "",
    "Approve to write to River, or say \"edit\" to make changes.",
  ];
  return lines.join("\n");
}

// For testing
export function _clearSessions(): void {
  sessions.clear();
}

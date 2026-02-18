/**
 * Alexa Custom Skill Channel Handler
 *
 * Handles incoming Alexa webhook requests, verifies signatures,
 * dispatches to intent handlers, and builds SSML responses.
 *
 * ELLIE-42: Build Alexa Custom Skill integration (voice channel)
 */

import verifier from "alexa-verifier";

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://localhost:3000";
const ALEXA_SKILL_ID = process.env.ALEXA_SKILL_ID || "";

// ============================================================
// REQUEST VERIFICATION
// ============================================================

export async function verifyAlexaRequest(
  certUrl: string,
  signature: string,
  rawBody: string,
): Promise<boolean> {
  try {
    await verifier(certUrl, signature, rawBody);
    return true;
  } catch (err) {
    console.error("[alexa] Signature verification failed:", err);
    return false;
  }
}

// ============================================================
// REQUEST PARSING
// ============================================================

export interface AlexaRequest {
  version: string;
  session: {
    sessionId: string;
    application: { applicationId: string };
    user: { userId: string };
    new: boolean;
  };
  request: {
    type: "LaunchRequest" | "IntentRequest" | "SessionEndedRequest";
    requestId: string;
    timestamp: string;
    intent?: {
      name: string;
      slots?: Record<string, { name: string; value?: string }>;
    };
    reason?: string;
  };
}

export interface ParsedAlexaRequest {
  type: string;
  intentName: string | null;
  slots: Record<string, string>;
  userId: string;
  sessionId: string;
  applicationId: string;
  text: string; // Human-readable version of the request
}

export function parseAlexaRequest(body: AlexaRequest): ParsedAlexaRequest {
  const intent = body.request.intent;
  const slots: Record<string, string> = {};

  if (intent?.slots) {
    for (const [key, slot] of Object.entries(intent.slots)) {
      if (slot.value) slots[key] = slot.value;
    }
  }

  // Build human-readable text from intent + slots
  let text = "";
  if (intent) {
    switch (intent.name) {
      case "AddTodoIntent":
        text = `Add a todo: ${slots.todoText || ""}`;
        break;
      case "GetTodosIntent":
        text = "What's on my todo list?";
        break;
      case "GetBriefingIntent":
        text = "Give me my briefing";
        break;
      case "AskEllieIntent":
        text = slots.query || "Hey Ellie";
        break;
      default:
        text = intent.name;
    }
  } else if (body.request.type === "LaunchRequest") {
    text = "Open Ellie";
  }

  return {
    type: body.request.type,
    intentName: intent?.name || null,
    slots,
    userId: body.session?.user?.userId || "unknown",
    sessionId: body.session?.sessionId || "unknown",
    applicationId: body.session?.application?.applicationId || "",
    text,
  };
}

// ============================================================
// INTENT HANDLERS
// ============================================================

export async function handleAddTodo(slots: Record<string, string>): Promise<string> {
  const todoText = slots.todoText;
  if (!todoText) {
    return "I didn't catch what you wanted to add. Try saying: add a todo, then your task.";
  }

  try {
    await fetch(`${DASHBOARD_URL}/api/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: todoText }),
    });
    return `Got it. I added "${todoText}" to your todo list.`;
  } catch (err) {
    console.error("[alexa] Failed to add todo:", err);
    return "Sorry, I couldn't add that todo right now. Try again in a moment.";
  }
}

export async function handleGetTodos(): Promise<string> {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/todos?status=open&limit=5`);
    const todos = (await res.json()) as any[];

    if (!todos?.length) {
      return "Your todo list is clear. Nice work!";
    }

    const items = todos.map((t: any, i: number) => `${i + 1}. ${t.content}`);
    const count = todos.length;
    const intro = count === 1 ? "You have one open todo." : `You have ${count} open todos.`;

    return `${intro} <break time="300ms"/> ${items.join(' <break time="200ms"/> ')}`;
  } catch (err) {
    console.error("[alexa] Failed to fetch todos:", err);
    return "Sorry, I couldn't load your todos right now.";
  }
}

export async function handleGetBriefing(): Promise<string> {
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/context`);
    const data = (await res.json()) as { document: string };

    if (!data.document) {
      return "I don't have anything to brief you on right now.";
    }

    // Extract key sections for spoken briefing
    const doc = data.document;
    const parts: string[] = [];

    // Time
    const timeMatch = doc.match(/CURRENT TIME: (.+)/);
    if (timeMatch) parts.push(`It's ${timeMatch[1]}.`);

    // Next action
    const nextMatch = doc.match(/SUGGESTED NEXT ACTION:\n- (.+)/);
    if (nextMatch) parts.push(`Your next action is: ${nextMatch[1]}.`);

    // Goals count
    const goalMatches = doc.match(/ACTIVE GOALS:/);
    if (goalMatches) {
      const goalLines = doc.split("ACTIVE GOALS:")[1]?.split("\n").filter((l) => l.startsWith("- "));
      if (goalLines?.length) {
        parts.push(`You have ${goalLines.length} active goal${goalLines.length > 1 ? "s" : ""}.`);
      }
    }

    // Action items count
    const actionMatches = doc.match(/PENDING ACTION ITEMS:/);
    if (actionMatches) {
      const actionLines = doc.split("PENDING ACTION ITEMS:")[1]?.split("\n").filter((l) => l.startsWith("- "));
      if (actionLines?.length) {
        parts.push(`${actionLines.length} pending action item${actionLines.length > 1 ? "s" : ""}.`);
      }
    }

    if (!parts.length) {
      return "Everything looks quiet. No urgent items or goals right now.";
    }

    return parts.join(' <break time="300ms"/> ');
  } catch (err) {
    console.error("[alexa] Failed to fetch briefing:", err);
    return "Sorry, I couldn't load your briefing right now.";
  }
}

// ============================================================
// RESPONSE BUILDING
// ============================================================

export function textToSsml(text: string): string {
  // Strip markdown formatting
  let ssml = text
    .replace(/\*\*(.+?)\*\*/g, '<emphasis level="moderate">$1</emphasis>')
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1"); // Strip markdown links

  // Convert bullet points to break-separated items
  ssml = ssml.replace(/\n[-•]\s+/g, ' <break time="200ms"/> ');

  // Collapse multiple newlines
  ssml = ssml.replace(/\n{2,}/g, ' <break time="400ms"/> ');
  ssml = ssml.replace(/\n/g, " ");

  return `<speak>${ssml}</speak>`;
}

export function buildAlexaResponse(
  speechText: string,
  shouldEndSession: boolean = true,
  cardTitle?: string,
  cardText?: string,
) {
  const response: Record<string, any> = {
    version: "1.0",
    response: {
      outputSpeech: {
        type: "SSML",
        ssml: speechText.startsWith("<speak>") ? speechText : textToSsml(speechText),
      },
      shouldEndSession,
    },
  };

  if (cardTitle) {
    response.response.card = {
      type: "Simple",
      title: cardTitle,
      content: cardText || speechText.replace(/<[^>]+>/g, ""),
    };
  }

  return response;
}

export function buildAlexaErrorResponse(message?: string) {
  return buildAlexaResponse(
    message || "Sorry, I had trouble with that. Please try again.",
    true,
  );
}

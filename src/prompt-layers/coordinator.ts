/**
 * Coordinator Layered Context — ELLIE-1452
 *
 * Builds structured prompt layers specifically for Max (the coordinator agent).
 * Three layers mirror the Ellie pipeline but with coordinator-specific content:
 *
 *   Layer 1: Identity — Max's role, tools, behavioral rules
 *   Layer 2: Awareness — Active dispatches, agent statuses, queue state
 *   Layer 3: Knowledge — Enriched specialist profiles, recipes, routing patterns
 */

import { log } from "../logger.ts";
import { getActiveRunStates } from "../orchestration-tracker.ts";
import { getRecentEvents } from "../orchestration-ledger.ts";
import type { FoundationRegistry } from "../foundation-registry.ts";

const logger = log.child("coordinator-layers");

// ── Types ────────────────────────────────────────────────────────────────────

export interface CoordinatorLayeredContext {
  identity: string;
  awareness: string;
  knowledge: string;
  totalBytes: number;
}

// ── Layer 1: Coordinator Identity ────────────────────────────────────────────

/**
 * Build Max's identity layer — who he is, what tools he has, behavioral rules.
 * This replaces the top portion of getCoordinatorPrompt() with a structured layer.
 */
export function buildCoordinatorIdentity(
  coordinatorAgent: string,
  foundationName: string,
  foundationDescription: string,
  behavior: { tone: string; proactivity: string; escalation: string },
): string {
  const isMax = coordinatorAgent === "max";

  const sections: string[] = [
    "## COORDINATOR IDENTITY",
    "",
    `You are ${isMax ? "Max, Dave's behind-the-scenes coordinator" : `${coordinatorAgent}, Dave's coordinator assistant`}. You manage a team of specialist agents.${isMax ? " Dave talks to Ellie — not you. Ellie is the face, the voice, the relationship. You are her operations layer." : ""}`,
    "",
    "### Ellie Delivers ALL Responses",
    "Ellie holds the conversation with Dave. She is his friend and partner — not a specialist the way James or Kate is. Your job is to route and collect. Her job is to deliver.",
    "",
    "**The rule:** After any specialist dispatch, ALWAYS dispatch to **ellie** with the specialist's results and ask her to compose the response to Dave. Do NOT write the final response yourself — Ellie's voice comes from her prompt, not from you trying to imitate her.",
    "",
    "**The only exception:** Simple read_context lookups where no specialist was involved — you can complete directly for those, but keep it brief and factual.",
    "",
    "**For conversation, greetings, brainstorming, emotional support, celebration, partnership discussions** — dispatch to Ellie directly. These are hers.",
    "",
    `### Foundation: ${foundationName} — ${foundationDescription}`,
    "",
    "### Communication Style",
    `- Tone: ${behavior.tone}`,
    `- Proactivity: ${behavior.proactivity}`,
    `- Escalation: ${behavior.escalation}`,
  ];

  return sections.join("\n");
}

// ── Layer 2: Coordinator Awareness ───────────────────────────────────────────

/**
 * Build routing awareness — active dispatches, recent routing patterns, queue state.
 * This gives Max situational awareness of what's happening right now.
 */
export async function buildCoordinatorAwareness(
  threadId?: string,
): Promise<string> {
  const sections: string[] = ["## ROUTING AWARENESS"];

  // Active dispatches
  try {
    let runs = getActiveRunStates().filter(r => r.status === "running");
    if (threadId) {
      runs = runs.filter(r => (r as any).thread_id === threadId);
    }

    if (runs.length > 0) {
      sections.push("");
      sections.push("### Active Dispatches");
      for (const run of runs) {
        const elapsedMin = Math.round((Date.now() - run.startedAt) / 60000);
        const workItem = run.workItemId ? ` on ${run.workItemId}` : "";
        sections.push(`- **${run.agentType || "unknown"}** is working${workItem} (${elapsedMin}min elapsed)`);
      }
      sections.push("");
      sections.push("When Dave's message relates to active work: queue context for that agent.");
      sections.push("When it's new work: dispatch normally.");
    }
  } catch (err) {
    logger.warn("Failed to build active dispatch context", { err });
  }

  // Recent dispatch history (last 10 events) for pattern awareness
  try {
    const events = await getRecentEvents(10);
    const completedRecent = events.filter(e => e.event_type === "completed");
    if (completedRecent.length > 0) {
      sections.push("");
      sections.push("### Recent Completions");
      for (const event of completedRecent.slice(0, 5)) {
        const raw = event.payload;
        const payload = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
        const agent = (payload.agent as string) || event.agent_type || "unknown";
        const title = (payload.title as string) || "";
        const ago = Math.round((Date.now() - new Date(event.created_at).getTime()) / 60000);
        sections.push(`- ${agent}: "${title}" (${ago}min ago)`);
      }
    }
  } catch {
    // Ledger unavailable — skip recent history
  }

  if (sections.length === 1) {
    sections.push("No active dispatches or recent routing activity.");
  }

  return sections.join("\n");
}

// ── Layer 3: Coordinator Knowledge ───────────────────────────────────────────

/**
 * Build the knowledge layer — specialist profiles, recipes, and routing guidance.
 * This is the most context-heavy layer, loaded with the information Max needs to route well.
 */
export async function buildCoordinatorKnowledge(
  registry: FoundationRegistry,
): Promise<string> {
  const foundation = registry.getActive();
  const recipes = registry.getRecipes();
  const agents = foundation?.agents ?? [];

  const sections: string[] = ["## ROUTING KNOWLEDGE"];

  // Tools reference (compact)
  sections.push("");
  sections.push("### Your Tools");
  sections.push("**dispatch_agent** — Send a task to a specialist. Dispatch multiple in parallel when independent.");
  sections.push("**read_context** — Quick lookups (forest, plane, memory, sessions, foundations) before deciding.");
  sections.push("**update_user** — Progress message while specialists work.");
  sections.push("**ask_user** — Pause and ask Dave a question for clarification/approvals.");
  sections.push("**invoke_recipe** — Run a coordination pattern (pipeline, fan-out, debate, round-table).");
  sections.push("**complete** — End the loop and deliver the final response. Every conversation ends here.");

  // Routing guide
  sections.push("");
  sections.push("### When To Do What");
  sections.push("- **Simple greeting or chat** -> Dispatch to ellie.");
  sections.push("- **Question from context** -> read_context, then complete directly (brief, factual).");
  sections.push("- **Task needing specialist tools** -> Dispatch specialist, then dispatch to ellie with results.");
  sections.push("- **Specialist asks a question** -> Use ask_user to relay, then re-dispatch with answer.");
  sections.push("- **Multi-part request** -> Decompose into parallel dispatches, collect, then dispatch to ellie.");
  sections.push("- **Need clarification** -> ask_user before dispatching.");
  sections.push("- **Specialist fails** -> Try different agent, ask user, or dispatch to ellie to explain.");
  sections.push("- **After dispatch completes** -> Suggest natural next step (code review, PR, strategic review).");

  // Enriched agent roster
  sections.push("");
  sections.push("### Your Specialists");
  if (agents.length > 0) {
    try {
      const { getSkillsForCreature } = await import("../../ellie-forest/src/creature-skills");
      const enrichedAgents = await Promise.all(agents.map(async (a) => {
        try {
          const sql = (await import("../../ellie-forest/src/db")).default;
          const [entity] = await sql`SELECT id FROM entities WHERE name = ${a.name} AND type = 'agent' AND active = true`;
          if (entity) {
            const skills = await getSkillsForCreature(entity.id);
            if (skills.length > 0) {
              return `- **${a.name}** (${a.role}): skills: ${skills.join(", ")}`;
            }
          }
        } catch { /* fall through */ }
        return `- **${a.name}** (${a.role}): ${a.tools.slice(0, 5).join(", ")}${a.tools.length > 5 ? "..." : ""}`;
      }));
      sections.push(...enrichedAgents);
    } catch {
      // Fallback: static tools
      for (const a of agents) {
        sections.push(`- **${a.name}** (${a.role}): ${a.tools.slice(0, 5).join(", ")}${a.tools.length > 5 ? "..." : ""}`);
      }
    }
  } else {
    sections.push("No agents available.");
  }

  // Recipes
  sections.push("");
  sections.push("### Recipes");
  if (recipes.length > 0) {
    for (const r of recipes) {
      sections.push(`- **${r.name}** (${r.pattern}): ${r.trigger || "on request"}`);
    }
  } else {
    sections.push("None defined.");
  }

  return sections.join("\n");
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Build the full coordinator layered context.
 * Called when LAYERED_PROMPT=true to replace the monolithic getCoordinatorPrompt().
 */
export async function buildCoordinatorLayeredContext(
  registry: FoundationRegistry,
  threadId?: string,
): Promise<CoordinatorLayeredContext> {
  const start = Date.now();
  const foundation = registry.getActive();
  const behavior = registry.getBehavior();
  const coordinatorAgent = registry.getCoordinatorAgent();

  // Build all three layers in parallel
  const [identity, awareness, knowledge] = await Promise.all([
    Promise.resolve(buildCoordinatorIdentity(
      coordinatorAgent,
      foundation?.name || "none",
      foundation?.description || "",
      behavior,
    )),
    buildCoordinatorAwareness(threadId),
    buildCoordinatorKnowledge(registry),
  ]);

  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(identity).length +
    encoder.encode(awareness).length +
    encoder.encode(knowledge).length;

  const elapsed = Date.now() - start;
  logger.info({ totalBytes, elapsed, coordinatorAgent }, "Coordinator layered context built");

  return { identity, awareness, knowledge, totalBytes };
}

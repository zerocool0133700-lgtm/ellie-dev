/**
 * Off-Hours Prompt Builder — ELLIE-1136
 *
 * Builds task prompts from GTD content + Plane ticket + creature skills.
 */

import { log } from "../logger.ts";
import { getSkillsForCreature } from "../../ellie-forest/src/creature-skills.ts";
import sql from "../../ellie-forest/src/db.ts";

const logger = log.child("overnight-prompt");

interface PromptOpts {
  taskTitle: string;
  taskContent: string;
  assignedAgent: string;
  workItemId?: string;
}

async function getPlaneTicketContext(workItemId: string): Promise<string | null> {
  try {
    const apiKey = process.env.PLANE_API_KEY;
    if (!apiKey) return null;
    const match = workItemId.match(/^ELLIE-(\d+)$/);
    if (!match) return null;

    const res = await fetch(
      `http://localhost:8082/api/v1/workspaces/evelife/projects/7194ace4-b80e-4c83-8042-c925598accf2/issues/?search=${workItemId}`,
      { headers: { "x-api-key": apiKey } },
    );
    const data = await res.json() as { results?: Array<{ sequence_id: number; name: string; description_html: string }> };
    const issue = data.results?.find(i => i.sequence_id === Number(match[1]));
    if (!issue) return null;
    return `## Ticket: ${workItemId} — ${issue.name}\n\n${issue.description_html?.replace(/<[^>]+>/g, "") || "No description."}`;
  } catch (err) {
    logger.warn("Failed to fetch Plane ticket", { workItemId, error: (err as Error).message });
    return null;
  }
}

async function getAgentSkillContext(agentName: string): Promise<string> {
  try {
    const [entity] = await sql`SELECT id FROM entities WHERE name = ${agentName} AND type = 'agent' AND active = true`;
    if (!entity) return "";
    const skills = await getSkillsForCreature(entity.id);
    if (skills.length === 0) return "";
    return `## Your Skills\nYou have access to these skills: ${skills.join(", ")}`;
  } catch {
    return "";
  }
}

export async function buildOvernightPrompt(opts: PromptOpts): Promise<{ prompt: string; systemPrompt: string }> {
  const parts: string[] = [];

  parts.push(`# Task: ${opts.taskTitle}`);
  parts.push(opts.taskContent);

  if (opts.workItemId) {
    const ticketCtx = await getPlaneTicketContext(opts.workItemId);
    if (ticketCtx) parts.push(ticketCtx);
  }

  const prompt = parts.join("\n\n");

  const skillCtx = await getAgentSkillContext(opts.assignedAgent);
  const systemPrompt = [
    `You are the ${opts.assignedAgent} agent working on an overnight autonomous task.`,
    `Work carefully. Commit your changes. Create a PR with a clear summary of what you did.`,
    `If you get stuck, document what went wrong and exit — don't loop.`,
    skillCtx,
  ].filter(Boolean).join("\n\n");

  return { prompt, systemPrompt };
}

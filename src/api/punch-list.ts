/**
 * Punch List — Collaborative daily working document
 *
 * A shared document between Dave and Ellie that tracks today's goals,
 * carrying-forward items, and collaborative todos. Stored in the River
 * vault and surfaced every morning at session start.
 *
 * Endpoints:
 *   GET  /api/punch-list          — Fetch the current punch list
 *   PUT  /api/punch-list          — Replace the entire punch list body
 *   PATCH /api/punch-list/section — Update a single section by heading
 *   POST /api/punch-list/new-day  — Roll over to a new day (carry forward unfinished goals)
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { RIVER_ROOT, parseFrontmatter, serializeWithFrontmatter, qmdReindex } from "./bridge-river.ts";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { log } from "../logger.ts";
import { getToday } from "../timezone.ts";

const logger = log.child("punch-list");

const PUNCH_LIST_PATH = "reference/daily-punch-list.md";

function fullPath(): string {
  return join(RIVER_ROOT, PUNCH_LIST_PATH);
}

/** Read the raw punch list from disk. Returns null if missing. */
async function readPunchList(): Promise<string | null> {
  try {
    return await readFile(fullPath(), "utf-8");
  } catch {
    return null;
  }
}

/** Write the punch list to disk and trigger QMD reindex. */
async function writePunchList(content: string): Promise<void> {
  await writeFile(fullPath(), content, "utf-8");
  await qmdReindex().catch(() => {});
}

// ── GET /api/punch-list ──────────────────────────────────────────────────────

/**
 * Fetch the current punch list. Returns the markdown body and frontmatter.
 */
export async function getPunchList(_req: ApiRequest, res: ApiResponse): Promise<void> {
  try {
    const raw = await readPunchList();
    if (!raw) {
      res.status(404).json({ error: "Punch list not found" });
      return;
    }

    const { frontmatter, body } = parseFrontmatter(raw);
    res.json({ success: true, frontmatter, body, raw });
  } catch (err) {
    logger.error("Failed to read punch list", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── PUT /api/punch-list ──────────────────────────────────────────────────────

/**
 * Replace the entire punch list body. Preserves/updates frontmatter.
 * Body: { content: string }
 */
export async function updatePunchList(req: ApiRequest, res: ApiResponse): Promise<void> {
  try {
    const { content } = req.body || {};
    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const today = getToday();
    const fm: Record<string, unknown> = { type: "punch-list", updated_at: today };
    const final = serializeWithFrontmatter(fm, content);
    await writePunchList(final);

    logger.info("Punch list updated", { date: today });
    res.json({ success: true, updated_at: today });
  } catch (err) {
    logger.error("Failed to update punch list", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── PATCH /api/punch-list/section ────────────────────────────────────────────

/**
 * Update a single section of the punch list by heading match.
 * Body: { heading: string, content: string }
 *
 * Replaces everything under the matched heading (up to the next same-level heading)
 * with the provided content.
 */
export async function updatePunchListSection(req: ApiRequest, res: ApiResponse): Promise<void> {
  try {
    const { heading, content } = req.body || {};
    if (!heading || typeof heading !== "string") {
      res.status(400).json({ error: "heading is required" });
      return;
    }
    if (content === undefined || typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const raw = await readPunchList();
    if (!raw) {
      res.status(404).json({ error: "Punch list not found" });
      return;
    }

    const { frontmatter, body } = parseFrontmatter(raw);
    const updated = replaceSectionContent(body, heading, content);

    if (updated === null) {
      res.status(404).json({ error: `Section "${heading}" not found` });
      return;
    }

    const today = getToday();
    frontmatter.updated_at = today;
    const final = serializeWithFrontmatter(frontmatter, updated);
    await writePunchList(final);

    logger.info("Punch list section updated", { heading, date: today });
    res.json({ success: true, heading, updated_at: today });
  } catch (err) {
    logger.error("Failed to update punch list section", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── POST /api/punch-list/new-day ─────────────────────────────────────────────

/**
 * Roll over to a new day. Moves incomplete "Today's Goals" into "Carrying Forward",
 * clears completed items, and resets for the new day.
 *
 * Body: { goals?: string[] } — optional new goals to seed the day with.
 */
export async function newDayPunchList(req: ApiRequest, res: ApiResponse): Promise<void> {
  try {
    const raw = await readPunchList();
    const today = getToday();

    if (!raw) {
      res.status(404).json({ error: "Punch list not found" });
      return;
    }

    const { body } = parseFrontmatter(raw);

    // Extract current "Today's Focus" content
    const goalsContent = extractSectionContent(body, "Today's Focus");
    // Extract current "Moving This Forward" content
    const carryContent = extractSectionContent(body, "Moving This Forward");

    // Build new carrying forward: existing carry + yesterday's unfinished goals
    const carryParts: string[] = [];
    if (carryContent && carryContent.trim()) {
      carryParts.push(carryContent.trim());
    }
    if (goalsContent && goalsContent.trim() && !goalsContent.includes("No goals set yet") && !goalsContent.includes("we'll fill this in")) {
      carryParts.push(goalsContent.trim());
    }
    const newCarry = carryParts.length > 0 ? carryParts.join("\n\n") : "";

    // Seed new goals
    const { goals } = req.body || {};
    let newGoals = "\n_No goals set yet — we'll fill this in together._\n";
    if (Array.isArray(goals) && goals.length > 0) {
      newGoals = "\n" + goals.map((g: string) => `- ${g}`).join("\n") + "\n";
    }

    // Rebuild document
    let updated = body;
    updated = replaceSectionContent(updated, "Today's Focus", newGoals) || updated;
    updated = replaceSectionContent(updated, "Moving This Forward", newCarry ? "\n" + newCarry + "\n" : "\n") || updated;

    // Clear todo sub-sections
    for (const sub of ["Dave's Todos", "Ellie's Todos", "Joint"]) {
      updated = replaceSectionContent(updated, sub, "\n") || updated;
    }
    updated = replaceSectionContent(updated, "Notes & Context", "\n") || updated;
    updated = replaceSectionContent(updated, "Done (Recent)", "\n") || updated;

    const fm: Record<string, unknown> = { type: "punch-list", updated_at: today };
    const final = serializeWithFrontmatter(fm, updated);
    await writePunchList(final);

    logger.info("Punch list new day", { date: today, carried: carryParts.length });
    res.json({ success: true, date: today, carried_forward: carryParts.length > 0 });
  } catch (err) {
    logger.error("Failed to roll over punch list", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ── Section parsing helpers ──────────────────────────────────────────────────

/**
 * Extract content under a heading (up to the next same-level or higher heading).
 * Returns the content between the heading line and the next heading, or null if not found.
 */
export function extractSectionContent(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  let inSection = false;
  let sectionLevel = 0;
  const content: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      if (inSection && level <= sectionLevel) {
        break; // Hit next same-level or higher heading
      }

      if (title === heading) {
        inSection = true;
        sectionLevel = level;
        continue; // Skip the heading line itself
      }
    }

    if (inSection) {
      content.push(line);
    }
  }

  return inSection ? content.join("\n") : null;
}

/**
 * Replace content under a heading with new content.
 * Returns the modified markdown, or null if heading not found.
 */
export function replaceSectionContent(markdown: string, heading: string, newContent: string): string | null {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let inSection = false;
  let sectionLevel = 0;
  let found = false;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      if (inSection && level <= sectionLevel) {
        // Exiting the section — insert new content before this heading
        inSection = false;
      }

      if (title === heading && !found) {
        found = true;
        inSection = true;
        sectionLevel = level;
        result.push(line); // Keep the heading
        // Insert new content
        result.push(newContent);
        continue;
      }
    }

    if (!inSection) {
      result.push(line);
    }
    // If inSection, we're skipping old content (already replaced above)
  }

  return found ? result.join("\n") : null;
}

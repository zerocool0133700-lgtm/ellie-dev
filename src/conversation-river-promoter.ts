/**
 * Conversation River Promoter — ELLIE-610
 *
 * Builds markdown documents for writing conversation context to the River
 * (Obsidian vault) so QMD indexes them and future sessions can resume.
 *
 * Two use cases:
 *   1. Auto-write on conversation close — called after extractMemories()
 *   2. Manual promote — UI button pushes current conversation to River
 *
 * This module handles document building and path generation only.
 * Actual I/O (River write API calls) is done by the caller.
 *
 * Document format:
 *   - YAML frontmatter with conversation metadata
 *   - Markdown body with summary, facts, action items, context
 *
 * Path: conversations/{conversation-id}-{YYYY-MM-DD}.md
 *
 * Pure module — no I/O, no external dependencies.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Input data for building a River conversation document. */
export interface ConversationContext {
  conversationId: string;
  channel: string;
  summary?: string;
  facts?: string[];
  actionItems?: string[];
  workItemId?: string;
  agent?: string;
  messageCount?: number;
  startedAt?: string;
  endedAt?: string;
}

/** Result of building a River document. */
export interface RiverDocument {
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

/** Validation result for conversation context. */
export interface PromoteValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Path Generation ──────────────────────────────────────────────────────────

/**
 * Generate the River vault path for a conversation document.
 * Format: conversations/{conversationId}-{YYYY-MM-DD}.md
 */
export function generateConversationPath(conversationId: string, date?: Date): string {
  const d = date ?? new Date();
  const dateStr = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return `conversations/${conversationId}-${dateStr}.md`;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate conversation context before building a document.
 */
export function validateContext(ctx: ConversationContext): PromoteValidationResult {
  const errors: string[] = [];

  if (!ctx.conversationId || !ctx.conversationId.trim()) {
    errors.push("conversationId is required");
  }

  if (!ctx.channel || !ctx.channel.trim()) {
    errors.push("channel is required");
  }

  if (!ctx.summary && (!ctx.facts || ctx.facts.length === 0) && (!ctx.actionItems || ctx.actionItems.length === 0)) {
    errors.push("At least one of summary, facts, or actionItems is required");
  }

  return { valid: errors.length === 0, errors };
}

// ── Document Building ────────────────────────────────────────────────────────

/**
 * Build frontmatter for a conversation River document.
 */
export function buildFrontmatter(ctx: ConversationContext): Record<string, unknown> {
  const fm: Record<string, unknown> = {
    type: "conversation",
    conversation_id: ctx.conversationId,
    channel: ctx.channel,
  };

  if (ctx.workItemId) fm.work_item_id = ctx.workItemId;
  if (ctx.agent) fm.agent = ctx.agent;
  if (ctx.messageCount !== undefined) fm.message_count = ctx.messageCount;
  if (ctx.startedAt) fm.started_at = ctx.startedAt;
  if (ctx.endedAt) fm.ended_at = ctx.endedAt;

  fm.promoted_at = new Date().toISOString();

  return fm;
}

/**
 * Build the markdown body for a conversation River document.
 */
export function buildBody(ctx: ConversationContext): string {
  const lines: string[] = [];

  // Title
  const title = ctx.workItemId
    ? `# Conversation — ${ctx.workItemId} (${ctx.channel})`
    : `# Conversation — ${ctx.channel}`;
  lines.push(title);
  lines.push("");

  // Summary section
  if (ctx.summary) {
    lines.push("## Summary");
    lines.push("");
    lines.push(ctx.summary);
    lines.push("");
  }

  // Facts section
  if (ctx.facts && ctx.facts.length > 0) {
    lines.push("## Extracted Facts");
    lines.push("");
    for (const fact of ctx.facts) {
      lines.push(`- ${fact}`);
    }
    lines.push("");
  }

  // Action items section
  if (ctx.actionItems && ctx.actionItems.length > 0) {
    lines.push("## Action Items");
    lines.push("");
    for (const item of ctx.actionItems) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push("");
  }

  // Metadata footer
  lines.push("## Session Details");
  lines.push("");
  if (ctx.agent) lines.push(`- **Agent**: ${ctx.agent}`);
  lines.push(`- **Channel**: ${ctx.channel}`);
  if (ctx.messageCount !== undefined) lines.push(`- **Messages**: ${ctx.messageCount}`);
  if (ctx.startedAt) lines.push(`- **Started**: ${ctx.startedAt}`);
  if (ctx.endedAt) lines.push(`- **Ended**: ${ctx.endedAt}`);
  if (ctx.workItemId) lines.push(`- **Work Item**: ${ctx.workItemId}`);
  lines.push("");

  return lines.join("\n").trim();
}

/**
 * Build a complete River document from conversation context.
 * Returns path, content (with frontmatter), and frontmatter separately.
 */
export function buildRiverDocument(ctx: ConversationContext, date?: Date): RiverDocument | null {
  const validation = validateContext(ctx);
  if (!validation.valid) return null;

  const frontmatter = buildFrontmatter(ctx);
  const body = buildBody(ctx);
  const path = generateConversationPath(ctx.conversationId, date);

  // Serialize frontmatter + body
  const fmLines = Object.entries(frontmatter).map(([k, v]) => {
    if (v === null || v === undefined) return `${k}: null`;
    if (typeof v === "boolean" || typeof v === "number") return `${k}: ${v}`;
    const s = String(v);
    if (s.includes(":") || s.includes("#") || s.includes("\n")) return `${k}: "${s.replace(/"/g, '\\"')}"`;
    return `${k}: ${s}`;
  });
  const content = `---\n${fmLines.join("\n")}\n---\n${body}`;

  return { path, content, frontmatter };
}

/**
 * Build a River document for the "promote" (manual push) use case.
 * Same as buildRiverDocument but marks it as manually promoted.
 */
export function buildPromoteDocument(ctx: ConversationContext, date?: Date): RiverDocument | null {
  const doc = buildRiverDocument(ctx, date);
  if (!doc) return null;

  // Add promoted flag to frontmatter
  doc.frontmatter.manually_promoted = true;

  // Re-serialize with the extra field
  const fmLines = Object.entries(doc.frontmatter).map(([k, v]) => {
    if (v === null || v === undefined) return `${k}: null`;
    if (typeof v === "boolean" || typeof v === "number") return `${k}: ${v}`;
    const s = String(v);
    if (s.includes(":") || s.includes("#") || s.includes("\n")) return `${k}: "${s.replace(/"/g, '\\"')}"`;
    return `${k}: ${s}`;
  });
  const body = buildBody(ctx);
  doc.content = `---\n${fmLines.join("\n")}\n---\n${body}`;

  return doc;
}

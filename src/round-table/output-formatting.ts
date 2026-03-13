/**
 * Round Table Output Formatting — ELLIE-703
 *
 * Channel-aware rendering of round table results with:
 *   1. Markdown templates for phase outputs
 *   2. Channel-specific rendering (Telegram, Google Chat, dashboard, plain)
 *   3. Message length limits with pagination/splitting
 *   4. Collapsible detail sections for long outputs
 *   5. Formation transcript deep-dive links
 *
 * Builds on the basic channel formatters from deliver.ts (ELLIE-700),
 * adding length management, pagination, and richer templates.
 */

import { log } from "../logger.ts";
import type { ConvergeOutput } from "./converge.ts";
import type { FormationTranscript, DeliveryChannel, DeliverOutput } from "./deliver.ts";

const logger = log.child("round-table-output");

// ── Constants ──────────────────────────────────────────────────

/** Channel-specific message length limits (characters). */
export const CHANNEL_LIMITS: Record<DeliveryChannel, number> = {
  telegram: 4096,
  "google-chat": 4096,
  dashboard: 50_000,
  plain: 50_000,
};

/** Truncation suffix when content exceeds limit. */
const TRUNCATION_MARKER = "\n\n…(truncated — use /roundtable status {sessionId} for full output)";

/** Maximum characters for a single transcript in a collapsible section. */
const MAX_TRANSCRIPT_LENGTH = 1500;

// ── Types ───────────────────────────────────────────────────────

/** A paginated message chunk for channels with length limits. */
export interface MessageChunk {
  /** 1-indexed page number. */
  page: number;
  /** Total number of pages. */
  totalPages: number;
  /** The content for this chunk. */
  content: string;
}

/** Options for formatting round table output. */
export interface FormatOptions {
  /** The delivery channel. */
  channel: DeliveryChannel;
  /** Round table session ID (used for deep-dive links). */
  sessionId: string;
  /** Whether to include formation transcripts. Default: true. */
  includeTranscripts?: boolean;
  /** Whether to paginate if output exceeds channel limit. Default: true. */
  paginate?: boolean;
  /** Base URL for transcript deep-dive links (dashboard only). */
  transcriptBaseUrl?: string;
}

/** Complete formatted output with pagination support. */
export interface FormattedResult {
  /** The primary message (first page if paginated). */
  primary: string;
  /** All message chunks if paginated, otherwise just the primary. */
  chunks: MessageChunk[];
  /** Whether the output was truncated or paginated. */
  wasPaginated: boolean;
  /** The channel used. */
  channel: DeliveryChannel;
}

// ── Markdown Templates ──────────────────────────────────────────

/**
 * Telegram-formatted round table result.
 * Uses Telegram's MarkdownV2-compatible subset (bold, italic, monospace).
 */
export function renderTelegram(
  deliverOutput: DeliverOutput,
  options: FormatOptions,
): string {
  const { executiveSummary, transcripts } = deliverOutput;
  const converge = extractConvergeFromOutcome(deliverOutput);
  const lines: string[] = [];

  // Header
  lines.push("🔵 *Round Table Complete*");
  lines.push(`📋 Session: \`${options.sessionId}\``);
  lines.push("");

  // Executive summary
  lines.push(executiveSummary);

  // Agreements (top 3)
  if (converge.agreements.length > 0) {
    lines.push("");
    lines.push("✅ *Key Agreements:*");
    for (const a of converge.agreements.slice(0, 3)) {
      lines.push(`  • ${a.point} _(${a.confidence})_`);
    }
    if (converge.agreements.length > 3) {
      lines.push(`  _…and ${converge.agreements.length - 3} more_`);
    }
  }

  // Conflicts
  if (converge.conflicts.length > 0) {
    lines.push("");
    lines.push("⚡ *Conflicts:*");
    for (const c of converge.conflicts.slice(0, 3)) {
      const res = c.resolution ? ` → _${c.resolution}_` : "";
      lines.push(`  • ${c.point}${res}`);
    }
  }

  // Escalations
  if (converge.escalations.length > 0) {
    lines.push("");
    lines.push("⚠️ *Escalations:*");
    for (const e of converge.escalations) {
      lines.push(`  • ${e}`);
    }
  }

  // Formation details (compact)
  if (options.includeTranscripts !== false && transcripts.length > 0) {
    lines.push("");
    lines.push("📋 *Formations:*");
    for (const t of transcripts) {
      const status = t.success ? "✅" : "❌";
      const duration = formatDuration(t.durationMs);
      lines.push(`${status} \`${t.slug}\` (${duration})`);
    }
  }

  // Criteria status
  const criteriaLine = converge.criteriaStatus.allMet
    ? "✅ All criteria met"
    : "⚠️ Some criteria not met";
  lines.push("");
  lines.push(criteriaLine);

  return lines.join("\n");
}

/**
 * Google Chat formatted round table result.
 * Google Chat supports a subset of Markdown different from Telegram:
 * bold (**), italic (*), strikethrough (~), monospace (` and ```),
 * but NOT Telegram's *bold* syntax. Uses proper GChat formatting.
 */
export function renderGoogleChat(
  deliverOutput: DeliverOutput,
  options: FormatOptions,
): string {
  const { executiveSummary, transcripts } = deliverOutput;
  const converge = extractConvergeFromOutcome(deliverOutput);
  const lines: string[] = [];

  // Header
  lines.push("🔵 **Round Table Complete**");
  lines.push(`📋 Session: \`${options.sessionId}\``);
  lines.push("");

  // Executive summary
  lines.push(executiveSummary);

  // Agreements
  if (converge.agreements.length > 0) {
    lines.push("");
    lines.push("✅ **Key Agreements:**");
    for (const a of converge.agreements.slice(0, 3)) {
      lines.push(`  • ${a.point} *(${a.confidence})*`);
    }
    if (converge.agreements.length > 3) {
      lines.push(`  *…and ${converge.agreements.length - 3} more*`);
    }
  }

  // Conflicts
  if (converge.conflicts.length > 0) {
    lines.push("");
    lines.push("⚡ **Conflicts:**");
    for (const c of converge.conflicts.slice(0, 3)) {
      const res = c.resolution ? ` → *${c.resolution}*` : "";
      lines.push(`  • ${c.point}${res}`);
    }
  }

  // Escalations
  if (converge.escalations.length > 0) {
    lines.push("");
    lines.push("⚠️ **Escalations:**");
    for (const e of converge.escalations) {
      lines.push(`  • ${e}`);
    }
  }

  // Formation details
  if (options.includeTranscripts !== false && transcripts.length > 0) {
    lines.push("");
    lines.push("📋 **Formations:**");
    for (const t of transcripts) {
      const status = t.success ? "✅" : "❌";
      const duration = formatDuration(t.durationMs);
      lines.push(`${status} \`${t.slug}\` (${duration})`);
    }
  }

  // Criteria
  const criteriaLine = converge.criteriaStatus.allMet
    ? "✅ All criteria met"
    : "⚠️ Some criteria not met";
  lines.push("");
  lines.push(criteriaLine);

  return lines.join("\n");
}

/**
 * Dashboard (HTML) formatted round table result.
 * Uses collapsible <details> sections for long content and transcript deep-dive links.
 */
export function renderDashboard(
  deliverOutput: DeliverOutput,
  options: FormatOptions,
): string {
  const { executiveSummary, transcripts } = deliverOutput;
  const converge = extractConvergeFromOutcome(deliverOutput);
  const lines: string[] = [];
  const baseUrl = options.transcriptBaseUrl ?? "/round-table";

  lines.push(`<div class="rt-result" data-session="${escapeHtml(options.sessionId)}">`);

  // Header
  lines.push(`<div class="rt-header">`);
  lines.push(`<h2>Round Table Result</h2>`);
  lines.push(`<span class="rt-session-id">${escapeHtml(options.sessionId)}</span>`);
  lines.push(`</div>`);

  // Executive summary
  lines.push(`<div class="rt-summary">${escapeHtml(executiveSummary)}</div>`);

  // Agreements
  if (converge.agreements.length > 0) {
    lines.push(`<div class="rt-section rt-agreements">`);
    lines.push(`<h3>Agreements</h3>`);
    lines.push(`<ul>`);
    for (const a of converge.agreements) {
      lines.push(`<li><strong>[${escapeHtml(a.confidence)}]</strong> ${escapeHtml(a.point)}</li>`);
    }
    lines.push(`</ul>`);
    lines.push(`</div>`);
  }

  // Conflicts — collapsible if more than 2
  if (converge.conflicts.length > 0) {
    lines.push(`<div class="rt-section rt-conflicts">`);
    if (converge.conflicts.length > 2) {
      lines.push(`<details>`);
      lines.push(`<summary><h3>Conflicts (${converge.conflicts.length})</h3></summary>`);
    } else {
      lines.push(`<h3>Conflicts</h3>`);
    }
    lines.push(`<ul>`);
    for (const c of converge.conflicts) {
      lines.push(`<li>${escapeHtml(c.point)}`);
      if (c.resolution) {
        lines.push(`<br><em>Resolution: ${escapeHtml(c.resolution)}</em>`);
      }
      lines.push(`</li>`);
    }
    lines.push(`</ul>`);
    if (converge.conflicts.length > 2) {
      lines.push(`</details>`);
    }
    lines.push(`</div>`);
  }

  // Escalations
  if (converge.escalations.length > 0) {
    lines.push(`<div class="rt-section rt-escalations">`);
    lines.push(`<h3>Escalations</h3>`);
    lines.push(`<ul>`);
    for (const e of converge.escalations) {
      lines.push(`<li>${escapeHtml(e)}</li>`);
    }
    lines.push(`</ul>`);
    lines.push(`</div>`);
  }

  // Gaps — collapsible
  if (converge.gaps.length > 0) {
    lines.push(`<div class="rt-section rt-gaps">`);
    lines.push(`<details>`);
    lines.push(`<summary><h3>Gaps (${converge.gaps.length})</h3></summary>`);
    lines.push(`<ul>`);
    for (const g of converge.gaps) {
      lines.push(`<li><span class="severity severity-${escapeHtml(g.severity)}">[${escapeHtml(g.severity)}]</span> ${escapeHtml(g.description)}</li>`);
    }
    lines.push(`</ul>`);
    lines.push(`</details>`);
    lines.push(`</div>`);
  }

  // Formation transcripts — collapsible with deep-dive links
  if (options.includeTranscripts !== false && transcripts.length > 0) {
    lines.push(`<div class="rt-section rt-transcripts">`);
    lines.push(`<h3>Formation Transcripts</h3>`);
    for (const t of transcripts) {
      const statusClass = t.success ? "success" : "failed";
      const duration = formatDuration(t.durationMs);
      const transcriptLink = `${baseUrl}/sessions/${encodeURIComponent(options.sessionId)}/transcripts/${encodeURIComponent(t.slug)}`;

      lines.push(`<details class="rt-transcript ${statusClass}">`);
      lines.push(`<summary>`);
      lines.push(`<span class="rt-status-icon">${t.success ? "✅" : "❌"}</span>`);
      lines.push(`<strong>${escapeHtml(t.slug)}</strong>`);
      lines.push(`<span class="rt-duration">(${duration})</span>`);
      lines.push(`<a href="${escapeHtml(transcriptLink)}" class="rt-deepdive-link">View full transcript</a>`);
      lines.push(`</summary>`);
      if (t.success) {
        const truncatedOutput = truncateText(t.output, MAX_TRANSCRIPT_LENGTH);
        lines.push(`<pre class="rt-output">${escapeHtml(truncatedOutput)}</pre>`);
      } else {
        lines.push(`<p class="rt-error">${escapeHtml(t.error ?? "Unknown error")}</p>`);
      }
      lines.push(`</details>`);
    }
    lines.push(`</div>`);
  }

  // Criteria status
  const criteriaClass = converge.criteriaStatus.allMet ? "met" : "not-met";
  lines.push(`<div class="rt-criteria rt-criteria-${criteriaClass}">`);
  lines.push(converge.criteriaStatus.allMet
    ? "✅ All criteria met"
    : "⚠️ Some criteria not met");
  lines.push(`</div>`);

  lines.push(`</div>`);

  return lines.join("\n");
}

/**
 * Plain text formatted round table result.
 */
export function renderPlain(
  deliverOutput: DeliverOutput,
  options: FormatOptions,
): string {
  const { executiveSummary, transcripts } = deliverOutput;
  const converge = extractConvergeFromOutcome(deliverOutput);
  const lines: string[] = [];

  lines.push("=== Round Table Result ===");
  lines.push(`Session: ${options.sessionId}`);
  lines.push("");
  lines.push(executiveSummary);

  if (converge.agreements.length > 0) {
    lines.push("");
    lines.push("AGREEMENTS:");
    for (const a of converge.agreements) {
      lines.push(`  [${a.confidence}] ${a.point}`);
    }
  }

  if (converge.conflicts.length > 0) {
    lines.push("");
    lines.push("CONFLICTS:");
    for (const c of converge.conflicts) {
      const res = c.resolution ? ` -> ${c.resolution}` : "";
      lines.push(`  - ${c.point}${res}`);
    }
  }

  if (converge.escalations.length > 0) {
    lines.push("");
    lines.push("ESCALATIONS:");
    for (const e of converge.escalations) {
      lines.push(`  - ${e}`);
    }
  }

  if (options.includeTranscripts !== false && transcripts.length > 0) {
    lines.push("");
    lines.push("FORMATION DETAILS:");
    for (const t of transcripts) {
      const status = t.success ? "OK" : "FAIL";
      const duration = formatDuration(t.durationMs);
      lines.push(`  [${status}] ${t.slug} (${duration})`);
    }
  }

  lines.push("");
  lines.push(converge.criteriaStatus.allMet
    ? "STATUS: All criteria met"
    : "STATUS: Some criteria not met");

  return lines.join("\n");
}

// ── Rendering Dispatcher ────────────────────────────────────────

/**
 * Render round table output for the specified channel.
 * Returns the raw rendered string (before pagination).
 */
export function renderForChannel(
  deliverOutput: DeliverOutput,
  options: FormatOptions,
): string {
  switch (options.channel) {
    case "telegram":
      return renderTelegram(deliverOutput, options);
    case "google-chat":
      return renderGoogleChat(deliverOutput, options);
    case "dashboard":
      return renderDashboard(deliverOutput, options);
    case "plain":
    default:
      return renderPlain(deliverOutput, options);
  }
}

// ── Pagination / Length Management ──────────────────────────────

/**
 * Split a rendered message into chunks that fit within the channel's
 * message length limit. Splits at paragraph boundaries where possible.
 */
export function paginateMessage(
  content: string,
  channel: DeliveryChannel,
): MessageChunk[] {
  const limit = CHANNEL_LIMITS[channel];

  if (content.length <= limit) {
    return [{ page: 1, totalPages: 1, content }];
  }

  const chunks: MessageChunk[] = [];
  let remaining = content;
  const headerReserve = 30; // space for page header like "(2/3)\n"
  const effectiveLimit = limit - headerReserve;

  while (remaining.length > 0) {
    if (remaining.length <= effectiveLimit) {
      chunks.push({ page: chunks.length + 1, totalPages: 0, content: remaining });
      break;
    }

    // Find best split point: paragraph break (\n\n), line break (\n), or space
    let splitAt = findSplitPoint(remaining, effectiveLimit);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    remaining = remaining.slice(splitAt).trimStart();

    chunks.push({ page: chunks.length + 1, totalPages: 0, content: chunk });
  }

  // Set totalPages
  const totalPages = chunks.length;
  for (const chunk of chunks) {
    chunk.totalPages = totalPages;
    if (totalPages > 1) {
      chunk.content = `(${chunk.page}/${totalPages})\n${chunk.content}`;
    }
  }

  return chunks;
}

/**
 * Find the best split point in a string at or before the given limit.
 * Prefers paragraph breaks > line breaks > spaces > hard cut.
 */
function findSplitPoint(text: string, limit: number): number {
  // Look for paragraph break (\n\n) in the last 20% of the limit
  const searchStart = Math.floor(limit * 0.8);
  const searchRegion = text.slice(searchStart, limit);

  const paraBreak = searchRegion.lastIndexOf("\n\n");
  if (paraBreak !== -1) {
    return searchStart + paraBreak + 2;
  }

  // Look for line break
  const lineBreak = searchRegion.lastIndexOf("\n");
  if (lineBreak !== -1) {
    return searchStart + lineBreak + 1;
  }

  // Look for space
  const space = text.lastIndexOf(" ", limit);
  if (space > searchStart) {
    return space + 1;
  }

  // Hard cut
  return limit;
}

/**
 * Format round table output with full pagination support.
 * This is the main entry point for output formatting.
 */
export function formatRoundTableOutput(
  deliverOutput: DeliverOutput,
  options: FormatOptions,
): FormattedResult {
  const rendered = renderForChannel(deliverOutput, options);
  const shouldPaginate = options.paginate !== false;

  if (!shouldPaginate) {
    // Truncate if over limit
    const limit = CHANNEL_LIMITS[options.channel];
    const content = rendered.length > limit
      ? truncateToLimit(rendered, limit, options.sessionId)
      : rendered;

    return {
      primary: content,
      chunks: [{ page: 1, totalPages: 1, content }],
      wasPaginated: false,
      channel: options.channel,
    };
  }

  const chunks = paginateMessage(rendered, options.channel);

  return {
    primary: chunks[0]?.content ?? "",
    chunks,
    wasPaginated: chunks.length > 1,
    channel: options.channel,
  };
}

// ── Phase Output Templates ──────────────────────────────────────

/**
 * Render a phase status update for a channel.
 * Used to show progress during an active round table session.
 */
export function renderPhaseUpdate(
  channel: DeliveryChannel,
  sessionId: string,
  phase: string,
  status: "started" | "completed" | "failed",
  detail?: string,
): string {
  const statusEmoji = status === "completed" ? "✅" : status === "failed" ? "❌" : "🔄";
  const phaseLabel = phase.charAt(0).toUpperCase() + phase.slice(1);

  switch (channel) {
    case "telegram":
      return [
        `${statusEmoji} *Round Table — ${phaseLabel}*`,
        `Session: \`${sessionId}\``,
        detail ? `\n${detail}` : "",
      ].filter(Boolean).join("\n");

    case "google-chat":
      return [
        `${statusEmoji} **Round Table — ${phaseLabel}**`,
        `Session: \`${sessionId}\``,
        detail ? `\n${detail}` : "",
      ].filter(Boolean).join("\n");

    case "dashboard":
      return [
        `<div class="rt-phase-update rt-phase-${escapeHtml(status)}">`,
        `<span class="rt-phase-status">${statusEmoji}</span>`,
        `<strong>${escapeHtml(phaseLabel)}</strong>`,
        `<span class="rt-session-ref">${escapeHtml(sessionId)}</span>`,
        detail ? `<p>${escapeHtml(detail)}</p>` : "",
        `</div>`,
      ].filter(Boolean).join("\n");

    case "plain":
    default:
      return [
        `[${status.toUpperCase()}] Round Table — ${phaseLabel}`,
        `Session: ${sessionId}`,
        detail ?? "",
      ].filter(Boolean).join("\n");
  }
}

/**
 * Render a formation transcript for deep-dive viewing.
 * Returns a detailed, single-formation view suitable for the channel.
 */
export function renderTranscriptDetail(
  channel: DeliveryChannel,
  sessionId: string,
  transcript: FormationTranscript,
): string {
  const duration = formatDuration(transcript.durationMs);
  const status = transcript.success ? "Completed" : "Failed";

  switch (channel) {
    case "telegram":
      return [
        `📋 *Formation: ${transcript.slug}*`,
        `Session: \`${sessionId}\``,
        `Status: ${transcript.success ? "✅" : "❌"} ${status}`,
        `Duration: ${duration}`,
        "",
        transcript.success
          ? `\`\`\`\n${truncateText(transcript.output, 3500)}\n\`\`\``
          : `❌ Error: ${transcript.error ?? "Unknown"}`,
      ].join("\n");

    case "google-chat":
      return [
        `📋 **Formation: ${transcript.slug}**`,
        `Session: \`${sessionId}\``,
        `Status: ${transcript.success ? "✅" : "❌"} ${status}`,
        `Duration: ${duration}`,
        "",
        transcript.success
          ? `\`\`\`\n${truncateText(transcript.output, 3500)}\n\`\`\``
          : `❌ Error: ${transcript.error ?? "Unknown"}`,
      ].join("\n");

    case "dashboard":
      return [
        `<div class="rt-transcript-detail" data-session="${escapeHtml(sessionId)}" data-formation="${escapeHtml(transcript.slug)}">`,
        `<h2>Formation: ${escapeHtml(transcript.slug)}</h2>`,
        `<div class="rt-meta">`,
        `<span class="rt-status ${transcript.success ? "success" : "failed"}">${status}</span>`,
        `<span class="rt-duration">${duration}</span>`,
        `</div>`,
        transcript.success
          ? `<pre class="rt-output">${escapeHtml(transcript.output)}</pre>`
          : `<p class="rt-error">${escapeHtml(transcript.error ?? "Unknown error")}</p>`,
        `</div>`,
      ].join("\n");

    case "plain":
    default:
      return [
        `=== Formation: ${transcript.slug} ===`,
        `Session: ${sessionId}`,
        `Status: ${status}`,
        `Duration: ${duration}`,
        "",
        transcript.success ? transcript.output : `Error: ${transcript.error ?? "Unknown"}`,
      ].join("\n");
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/** Escape HTML special characters. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format milliseconds as a human-readable duration. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

/** Truncate text to a maximum length, adding ellipsis. */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/** Truncate rendered content to fit channel limit, with session reference. */
function truncateToLimit(content: string, limit: number, sessionId: string): string {
  const marker = TRUNCATION_MARKER.replace("{sessionId}", sessionId);
  return content.slice(0, limit - marker.length) + marker;
}

/**
 * Extract converge-like data from a DeliverOutput for rendering.
 * The DeliverOutput has the outcome (counts) but we need the structured
 * converge data. This uses a type-safe approach — if a full ConvergeOutput
 * is attached, use it. Otherwise, build minimal data from the outcome.
 */
function extractConvergeFromOutcome(deliverOutput: DeliverOutput): ConvergeOutput {
  // If _convergeOutput is attached (set by formatRoundTableFull), use it
  if ((deliverOutput as DeliverOutputWithConverge)._convergeOutput) {
    return (deliverOutput as DeliverOutputWithConverge)._convergeOutput;
  }

  // Minimal fallback from outcome data
  return {
    agreements: [],
    conflicts: [],
    gaps: [],
    escalations: [],
    criteriaStatus: {
      allMet: deliverOutput.outcome.criteriaAllMet,
      results: [],
    },
    synthesis: deliverOutput.executiveSummary,
    summary: deliverOutput.executiveSummary,
    success: deliverOutput.success,
  };
}

/** Extended DeliverOutput with optional ConvergeOutput attached. */
export interface DeliverOutputWithConverge extends DeliverOutput {
  _convergeOutput: ConvergeOutput;
}

/**
 * Attach converge output to a DeliverOutput for rich rendering.
 * Call this before formatting to get full agreements/conflicts/gaps in the output.
 */
export function attachConvergeOutput(
  deliverOutput: DeliverOutput,
  convergeOutput: ConvergeOutput,
): DeliverOutputWithConverge {
  return { ...deliverOutput, _convergeOutput: convergeOutput };
}

// ── Testing Helpers ─────────────────────────────────────────────

/**
 * Create a mock DeliverOutput with converge data attached for testing.
 */
export function _makeMockFormattingInput(
  overrides?: Partial<DeliverOutput>,
): DeliverOutputWithConverge {
  const base: DeliverOutput = {
    executiveSummary: "The round table recommends a phased expansion into APAC markets, starting with Singapore in Q3.",
    formattedOutput: "",
    transcripts: [
      { slug: "boardroom", success: true, output: "Strategic analysis: APAC expansion is viable with phased approach. Singapore offers the best regulatory environment.", durationMs: 2500 },
      { slug: "think-tank", success: true, output: "Creative approaches identified: partner-led entry, digital-first launch, localized pricing strategy.", durationMs: 1800 },
      { slug: "vrbo-ops", success: false, output: "", error: "Formation timeout", durationMs: 30000 },
    ],
    outcome: {
      sessionId: "rt-test-001",
      query: "Should we expand into APAC markets?",
      success: true,
      formationsUsed: ["boardroom", "think-tank", "vrbo-ops"],
      formationsSucceeded: ["boardroom", "think-tank"],
      formationsFailed: ["vrbo-ops"],
      totalDurationMs: 34300,
      criteriaAllMet: false,
      escalationCount: 1,
      gapCount: 2,
      channel: "telegram",
    },
    channel: "telegram",
    success: true,
    ...overrides,
  };

  const converge: ConvergeOutput = {
    agreements: [
      { point: "APAC expansion is strategically sound", confidence: "high" },
      { point: "Singapore is the optimal entry market", confidence: "high" },
      { point: "Phased approach reduces risk", confidence: "medium" },
    ],
    conflicts: [
      { point: "Timeline disagreement: Q2 vs Q3 launch", resolution: "Q3 selected — allows proper regulatory preparation" },
      { point: "Budget allocation between marketing and operations", resolution: null },
    ],
    gaps: [
      { description: "Local competitor analysis incomplete", severity: "medium" },
      { description: "Regulatory timeline for Singapore not verified", severity: "high" },
    ],
    escalations: ["Budget approval needed from finance team before proceeding"],
    criteriaStatus: {
      allMet: false,
      results: [
        { criterion: "Strategic alignment", met: true, evidence: "All formations agree" },
        { criterion: "Financial viability", met: false, evidence: "Budget gap identified" },
      ],
    },
    synthesis: "The round table broadly agrees on APAC expansion via Singapore with a phased approach.",
    summary: "APAC expansion recommended, Singapore first, Q3 timeline.",
    success: true,
  };

  return { ...base, _convergeOutput: converge };
}

/**
 * Create default format options for testing.
 */
export function _makeMockFormatOptions(
  overrides?: Partial<FormatOptions>,
): FormatOptions {
  return {
    channel: "telegram",
    sessionId: "rt-test-001",
    includeTranscripts: true,
    paginate: true,
    ...overrides,
  };
}

/**
 * CoordinatorContext — Coordinator Loop Context Manager
 *
 * Manages the coordinator's Messages API conversation history.
 * Tracks context pressure and compacts the conversation when approaching
 * the token limit using a three-tier strategy:
 *   - hot:  in-conversation (this class)
 *   - warm: working memory
 *   - cold: Forest
 */

import type Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.ts";

const logger = log.child("coordinator-context");

// ── Types ────────────────────────────────────────────────────────────────────

export type ContextPressureLevel = "normal" | "warm" | "hot" | "critical";

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;

// ── Class ────────────────────────────────────────────────────────────────────

export class CoordinatorContext {
  private readonly systemPrompt: string;
  private readonly maxTokens: number;
  private messages: MessageParam[] = [];
  private lastTokenCount = 0;

  constructor(opts: { systemPrompt: string; maxTokens: number }) {
    this.systemPrompt = opts.systemPrompt;
    this.maxTokens = opts.maxTokens;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getMessages(): MessageParam[] {
    return this.messages;
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  addAssistantMessage(content: ContentBlockParam[]): void {
    this.messages.push({ role: "assistant", content });
  }

  addToolResult(toolUseId: string, result: string): void {
    this.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: result ?? "No output.",
        },
      ],
    });
  }

  // ── Token Tracking ────────────────────────────────────────────────────────

  recordTokenUsage(inputTokens: number): void {
    this.lastTokenCount = inputTokens;
  }

  getTokenCount(): number {
    return this.lastTokenCount;
  }

  // ── Pressure ──────────────────────────────────────────────────────────────

  getPressure(): ContextPressureLevel {
    const ratio = this.lastTokenCount / this.maxTokens;
    if (ratio >= 0.85) return "critical";
    if (ratio >= 0.70) return "hot";
    if (ratio >= 0.50) return "warm";
    return "normal";
  }

  // ── Compaction ────────────────────────────────────────────────────────────

  /**
   * Compact the conversation based on pressure level.
   * Keeps the last N messages, summarizes what was removed, and prepends
   * a summary user message before the kept messages.
   */
  compact(level: ContextPressureLevel): void {
    if (level === "normal") return;

    const keepCount = level === "critical" ? 2 : level === "hot" ? 4 : 6;

    if (this.messages.length <= keepCount) {
      logger.info("compact: nothing to remove", { level, messageCount: this.messages.length });
      return;
    }

    const removed = this.messages.slice(0, this.messages.length - keepCount);
    const kept = this.messages.slice(this.messages.length - keepCount);

    const summaryText = this._summarizeRemoved(removed);
    const summaryMessage: MessageParam = {
      role: "user",
      content: `[Context compacted — ${level} pressure]\n\n${summaryText}`,
    };

    this.messages = [summaryMessage, ...kept];

    this.fixMessageOrdering();

    logger.info("compact complete", {
      level,
      removedCount: removed.length,
      keptCount: kept.length,
      totalAfter: this.messages.length,
    });
  }

  /**
   * Nuclear option: replace entire conversation with a summary + last 2 messages.
   */
  rebuildFromSummary(workingMemorySummary: string): void {
    const kept = this.messages.slice(-2);

    const summaryMessage: MessageParam = {
      role: "user",
      content: `[Context rebuilt from working memory]\n\n${workingMemorySummary}`,
    };

    this.messages = [summaryMessage, ...kept];
    this.fixMessageOrdering();

    logger.info("rebuildFromSummary complete", { keptCount: kept.length });
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  /**
   * Return a text summary of dispatch_agent calls and results found in the
   * current conversation (used before compaction so callers can preserve context).
   */
  getCompactionSummary(): string {
    const dispatches: string[] = [];

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role !== "assistant") continue;

      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "tool_use" &&
          "name" in block &&
          block.name === "dispatch_agent"
        ) {
          const toolId = "id" in block ? (block.id as string) : "";
          const input = "input" in block ? (block.input as Record<string, unknown>) : {};
          const task = input.task ?? "(no task)";
          const agent = input.agent ?? "(unknown agent)";

          // Find matching tool result in subsequent messages
          let resultText = "(no result recorded)";
          for (let j = i + 1; j < this.messages.length; j++) {
            const next = this.messages[j];
            if (next.role !== "user") break;
            const nextContent = Array.isArray(next.content) ? next.content : [];
            for (const rb of nextContent) {
              if (
                typeof rb === "object" &&
                rb !== null &&
                "type" in rb &&
                rb.type === "tool_result" &&
                "tool_use_id" in rb &&
                rb.tool_use_id === toolId
              ) {
                resultText =
                  "content" in rb && typeof rb.content === "string"
                    ? rb.content
                    : JSON.stringify(rb.content);
                break;
              }
            }
          }

          dispatches.push(
            `dispatch_agent → agent: ${agent}, task: ${task}\nresult: ${resultText}`
          );
        }
      }
    }

    if (dispatches.length === 0) {
      return "No dispatch_agent calls found in current conversation.";
    }

    return `dispatch_agent calls (${dispatches.length}):\n\n${dispatches.join("\n\n")}`;
  }

  // ── Internal Helpers ──────────────────────────────────────────────────────

  /**
   * Merge consecutive same-role messages after compaction to maintain
   * the strict user/assistant alternation required by the Messages API.
   */
  private fixMessageOrdering(): void {
    if (this.messages.length === 0) return;

    const merged: MessageParam[] = [this.messages[0]];

    for (let i = 1; i < this.messages.length; i++) {
      const current = this.messages[i];
      const last = merged[merged.length - 1];

      if (current.role === last.role) {
        // Merge content into the previous message
        const prevContent = Array.isArray(last.content)
          ? last.content
          : [{ type: "text" as const, text: last.content as string }];
        const currContent = Array.isArray(current.content)
          ? current.content
          : [{ type: "text" as const, text: current.content as string }];

        merged[merged.length - 1] = {
          role: last.role,
          content: [...prevContent, ...currContent],
        } as MessageParam;
      } else {
        merged.push(current);
      }
    }

    this.messages = merged;
  }

  /**
   * Build a human-readable summary of removed messages for the compaction note.
   */
  private _summarizeRemoved(removed: MessageParam[]): string {
    const parts: string[] = [`The following ${removed.length} messages were removed:`];

    for (const msg of removed) {
      if (msg.role === "user") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        parts.push(`- user: ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`);
      } else if (msg.role === "assistant") {
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (typeof block === "object" && block !== null && "type" in block) {
            if (block.type === "text" && "text" in block) {
              const t = block.text as string;
              parts.push(`- assistant: ${t.slice(0, 120)}${t.length > 120 ? "..." : ""}`);
            } else if (block.type === "tool_use" && "name" in block) {
              parts.push(`- assistant called tool: ${block.name}`);
            }
          }
        }
      }
    }

    return parts.join("\n");
  }
}

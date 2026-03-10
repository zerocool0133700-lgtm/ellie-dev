/**
 * MCPConnectorSource — ELLIE-659
 *
 * Base class that wraps an MCP tool caller into a MountainSource.
 * Provides rate limiting, retry with exponential backoff, and
 * a common harvest flow. Subclasses implement `fetchItems()`.
 */

import { log } from "../logger.ts";
import type {
  MountainSource,
  SourceStatus,
  HarvestJob,
  HarvestResult,
  HarvestItem,
  HarvestError,
} from "./types.ts";

const logger = log.child("mountain-mcp");

// ── Types ────────────────────────────────────────────────────

/**
 * Function signature for calling an MCP tool.
 * Accepts a tool name and arguments, returns the tool result.
 */
export type MCPToolCaller = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface MCPConnectorConfig {
  /** Unique source ID */
  id: string;

  /** Human-readable name */
  name: string;

  /** Max requests per rate limit window */
  rateLimitMax: number;

  /** Rate limit window in ms */
  rateLimitWindowMs: number;

  /** Max retries on transient errors */
  maxRetries: number;

  /** Base delay for exponential backoff in ms */
  baseRetryDelayMs: number;
}

const DEFAULT_CONFIG: Partial<MCPConnectorConfig> = {
  rateLimitMax: 30,
  rateLimitWindowMs: 60_000,
  maxRetries: 3,
  baseRetryDelayMs: 1000,
};

// ── Rate Limiter (simple sliding window) ─────────────────────

class SimpleRateLimiter {
  private timestamps: number[] = [];
  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => t > now - this.windowMs);
    if (this.timestamps.length >= this.max) {
      const waitMs = this.timestamps[0] + this.windowMs - now;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.acquire();
    }
    this.timestamps.push(now);
  }
}

// ── Base Class ───────────────────────────────────────────────

export abstract class MCPConnectorSource implements MountainSource {
  readonly id: string;
  readonly name: string;
  status: SourceStatus = "idle";

  protected callTool: MCPToolCaller;
  protected config: Required<MCPConnectorConfig>;
  private rateLimiter: SimpleRateLimiter;

  constructor(callTool: MCPToolCaller, config: MCPConnectorConfig) {
    this.callTool = callTool;
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<MCPConnectorConfig>;
    this.id = this.config.id;
    this.name = this.config.name;
    this.rateLimiter = new SimpleRateLimiter(
      this.config.rateLimitMax,
      this.config.rateLimitWindowMs,
    );
  }

  /**
   * Subclasses implement this to fetch items from their MCP tools.
   * Called within the rate-limited, retried context.
   */
  protected abstract fetchItems(job: HarvestJob): Promise<{
    items: HarvestItem[];
    errors: HarvestError[];
    truncated: boolean;
  }>;

  /**
   * Optional health check — subclasses can override.
   */
  async healthCheck(): Promise<boolean> {
    return true;
  }

  /**
   * Call an MCP tool with rate limiting and retry.
   */
  protected async callWithRetry<T>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      await this.rateLimiter.acquire();

      try {
        const result = await this.callTool(tool, args);
        return result as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const isTransient = this.isTransientError(lastError);

        if (!isTransient || attempt === this.config.maxRetries) {
          throw lastError;
        }

        const delay = this.config.baseRetryDelayMs * Math.pow(2, attempt);
        logger.warn(`Retrying ${tool} (attempt ${attempt + 1}/${this.config.maxRetries})`, {
          sourceId: this.id,
          error: lastError.message,
          delayMs: delay,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError ?? new Error("Unexpected retry exhaustion");
  }

  /**
   * Determine if an error is transient (retryable).
   * Override in subclasses for source-specific logic.
   */
  protected isTransientError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("rate limit") ||
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("502")
    );
  }

  /**
   * Run a harvest job using the subclass's fetchItems().
   */
  async harvest(job: HarvestJob): Promise<HarvestResult> {
    const startedAt = new Date();
    try {
      const { items, errors, truncated } = await this.fetchItems(job);
      return {
        jobId: job.id,
        sourceId: this.id,
        items,
        errors,
        startedAt,
        completedAt: new Date(),
        truncated,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jobId: job.id,
        sourceId: this.id,
        items: [],
        errors: [{ message, retryable: false }],
        startedAt,
        completedAt: new Date(),
        truncated: false,
      };
    }
  }
}

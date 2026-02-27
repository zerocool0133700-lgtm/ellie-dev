/**
 * UMS — Provider Connector Interface + Registry
 *
 * ELLIE-294: Each provider (Telegram, Gmail, etc.) implements a connector
 * that normalizes raw payloads into UnifiedMessageInsert. Connectors are
 * pure functions — they transform data, they don't fetch it.
 *
 * The registry maps provider names to connectors so the ingestion layer
 * can look up the right normalizer for any incoming payload.
 */

import type { UnifiedMessageInsert } from "./types.ts";

/**
 * A UMS connector normalizes a raw provider payload into a UnifiedMessageInsert.
 *
 * Connectors are stateless and pure:
 *   - They receive the raw payload from the ingestion layer (webhook, poll, etc.)
 *   - They extract content, sender, channel, content_type, and provider_id
 *   - They preserve the original payload in the `raw` field
 *   - They never fetch data or call external APIs
 */
export interface UMSConnector {
  /** Provider name — must match the `provider` field in UnifiedMessage. */
  readonly provider: string;

  /**
   * Normalize a raw payload into a UnifiedMessageInsert.
   * Returns null if the payload should be skipped (e.g., duplicate, ping, irrelevant).
   */
  normalize(rawPayload: unknown): UnifiedMessageInsert | null;
}

// ── Connector Registry ─────────────────────────────────────────

const registry = new Map<string, UMSConnector>();

/** Register a connector for a provider. Overwrites any existing registration. */
export function registerConnector(connector: UMSConnector): void {
  registry.set(connector.provider, connector);
}

/** Look up the connector for a given provider name. */
export function getConnector(provider: string): UMSConnector | undefined {
  return registry.get(provider);
}

/** List all registered provider names. */
export function listProviders(): string[] {
  return [...registry.keys()];
}

/**
 * Normalize a raw payload using the registered connector for the given provider.
 * Returns null if no connector is registered or the connector skips the payload.
 */
export function normalizePayload(provider: string, rawPayload: unknown): UnifiedMessageInsert | null {
  const connector = registry.get(provider);
  if (!connector) return null;
  return connector.normalize(rawPayload);
}

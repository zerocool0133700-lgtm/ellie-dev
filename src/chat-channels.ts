/**
 * Chat Channels — ELLIE-334
 *
 * Hierarchical channel tree for Ellie Chat sub-channels.
 * Each channel has an optional context profile (mode, token budget,
 * critical sources, suppressed sections) that inherits from its parent.
 *
 * Replaces mode detection as the primary context mechanism when a
 * channel_id is provided — the channel IS the mode.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContextMode } from "./context-mode.ts";
import { getModeTokenBudget } from "./context-mode.ts";
import { getModeTiers } from "./context-freshness.ts";
import { log } from "./logger.ts";

const logger = log.child("chat-channels");

// ── Types ────────────────────────────────────────────────────

export interface ChatChannel {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
  context_mode: ContextMode | null;
  token_budget: number | null;
  critical_sources: string[] | null;
  suppressed_sections: string[] | null;
  is_ephemeral: boolean;
  work_item_id: string | null;
  archived_at: string | null;
  description: string | null;
  icon: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatChannelTreeNode extends ChatChannel {
  children: ChatChannelTreeNode[];
}

export interface ChannelContextProfile {
  channelName: string;
  channelSlug: string;
  contextMode: ContextMode;
  tokenBudget: number;
  criticalSources: string[];
  suppressedSections: string[];
  workItemId: string | null;
}

// ── In-memory cache ──────────────────────────────────────────

let cachedTree: ChatChannelTreeNode[] | null = null;
let cachedChannels: Map<string, ChatChannel> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 1 minute

function isCacheValid(): boolean {
  return cachedTree !== null && (Date.now() - cacheTimestamp) < CACHE_TTL_MS;
}

export function invalidateChannelCache(): void {
  cachedTree = null;
  cachedChannels = null;
  cacheTimestamp = 0;
}

// ── Channel Tree ─────────────────────────────────────────────

/**
 * Fetch the full channel tree from the database.
 * Returns a flat list and builds the tree structure.
 */
export async function getChannelTree(supabase: SupabaseClient): Promise<ChatChannelTreeNode[]> {
  if (isCacheValid()) return cachedTree!;

  const { data, error } = await supabase
    .from("chat_channels")
    .select("*")
    .is("archived_at", null)
    .order("sort_order", { ascending: true });

  if (error) {
    logger.error("Failed to fetch channels", error);
    return cachedTree || [];
  }

  const channels = (data || []) as ChatChannel[];

  // Build lookup map
  const map = new Map<string, ChatChannel>();
  for (const ch of channels) {
    map.set(ch.id, ch);
  }

  // Build tree
  const tree = buildTree(channels);

  // Cache
  cachedTree = tree;
  cachedChannels = map;
  cacheTimestamp = Date.now();

  return tree;
}

/**
 * Build a tree from flat channel list.
 */
function buildTree(channels: ChatChannel[]): ChatChannelTreeNode[] {
  const nodeMap = new Map<string, ChatChannelTreeNode>();
  const roots: ChatChannelTreeNode[] = [];

  // Create nodes
  for (const ch of channels) {
    nodeMap.set(ch.id, { ...ch, children: [] });
  }

  // Link parents
  for (const node of nodeMap.values()) {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      nodeMap.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children by sort_order
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => a.sort_order - b.sort_order);
  }

  return roots.sort((a, b) => a.sort_order - b.sort_order);
}

// ── Single Channel Lookup ────────────────────────────────────

/**
 * Get a single channel by ID.
 */
export async function getChannel(
  supabase: SupabaseClient,
  channelId: string,
): Promise<ChatChannel | null> {
  // Check cache first
  if (isCacheValid() && cachedChannels?.has(channelId)) {
    return cachedChannels.get(channelId)!;
  }

  const { data, error } = await supabase
    .from("chat_channels")
    .select("*")
    .eq("id", channelId)
    .single();

  if (error || !data) {
    logger.warn(`Channel not found: ${channelId}`);
    return null;
  }

  return data as ChatChannel;
}

/**
 * Get a channel by slug (e.g. "general", "strategy/architecture").
 */
export async function getChannelBySlug(
  supabase: SupabaseClient,
  slug: string,
): Promise<ChatChannel | null> {
  // Check cache
  if (isCacheValid() && cachedChannels) {
    for (const ch of cachedChannels.values()) {
      if (ch.slug === slug) return ch;
    }
  }

  const { data, error } = await supabase
    .from("chat_channels")
    .select("*")
    .eq("slug", slug)
    .is("archived_at", null)
    .single();

  if (error || !data) return null;
  return data as ChatChannel;
}

// ── Context Profile Resolution ───────────────────────────────

/**
 * Resolve the effective context profile for a channel.
 * Walks up the parent chain, applying CSS-specificity-style inheritance:
 * child overrides parent, parent overrides grandparent, etc.
 * Falls back to mode defaults for unset fields.
 */
export async function resolveContextProfile(
  supabase: SupabaseClient,
  channelId: string,
): Promise<ChannelContextProfile> {
  // Gather ancestor chain (child first)
  const chain: ChatChannel[] = [];
  let current = await getChannel(supabase, channelId);

  while (current) {
    chain.push(current);
    if (current.parent_id) {
      current = await getChannel(supabase, current.parent_id);
    } else {
      current = null;
    }
  }

  // Resolve each field: first non-null in the chain wins
  const contextMode: ContextMode = findInChain(chain, c => c.context_mode) || "conversation";
  const modeDefaults = getModeTiers(contextMode);

  // chain[0] is the channel itself (child-first order)
  const channel = chain[0];

  return {
    channelName: channel?.name || "General",
    channelSlug: channel?.slug || "general",
    contextMode,
    tokenBudget: findInChain(chain, c => c.token_budget) || getModeTokenBudget(contextMode),
    criticalSources: findInChain(chain, c => c.critical_sources) || modeDefaults.critical,
    suppressedSections: findInChain(chain, c => c.suppressed_sections) || [],
    workItemId: channel?.work_item_id || null,
  };
}

/**
 * Helper: find the first non-null value for a field in the ancestor chain.
 */
function findInChain<T>(chain: ChatChannel[], getter: (ch: ChatChannel) => T | null): T | null {
  for (const ch of chain) {
    const val = getter(ch);
    if (val !== null && val !== undefined) return val;
  }
  return null;
}

// ── Channel CRUD ─────────────────────────────────────────────

/**
 * Create a new channel.
 */
export async function createChannel(
  supabase: SupabaseClient,
  channel: {
    name: string;
    slug: string;
    parent_id?: string;
    context_mode?: ContextMode;
    description?: string;
    icon?: string;
    is_ephemeral?: boolean;
    work_item_id?: string;
    sort_order?: number;
  },
): Promise<ChatChannel | null> {
  const { data, error } = await supabase
    .from("chat_channels")
    .insert({
      name: channel.name,
      slug: channel.slug,
      parent_id: channel.parent_id || null,
      context_mode: channel.context_mode || null,
      description: channel.description || null,
      icon: channel.icon || null,
      is_ephemeral: channel.is_ephemeral || false,
      work_item_id: channel.work_item_id || null,
      sort_order: channel.sort_order ?? 99,
    })
    .select()
    .single();

  if (error) {
    logger.error("Failed to create channel", error);
    return null;
  }

  invalidateChannelCache();
  logger.info(`Channel created: ${channel.name} (${channel.slug})`);
  return data as ChatChannel;
}

/**
 * Update a channel's properties.
 */
export async function updateChannel(
  supabase: SupabaseClient,
  channelId: string,
  updates: Partial<Pick<ChatChannel, "name" | "description" | "icon" | "context_mode" | "token_budget" | "critical_sources" | "suppressed_sections" | "sort_order">>,
): Promise<ChatChannel | null> {
  const { data, error } = await supabase
    .from("chat_channels")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", channelId)
    .select()
    .single();

  if (error) {
    logger.error("Failed to update channel", error);
    return null;
  }

  invalidateChannelCache();
  return data as ChatChannel;
}

/**
 * Archive a channel (soft delete).
 */
export async function archiveChannel(
  supabase: SupabaseClient,
  channelId: string,
): Promise<boolean> {
  const { error } = await supabase
    .from("chat_channels")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", channelId);

  if (error) {
    logger.error("Failed to archive channel", error);
    return false;
  }

  invalidateChannelCache();
  logger.info(`Channel archived: ${channelId}`);
  return true;
}

// ── Ephemeral Channels ───────────────────────────────────────

/** Well-known ID for the Deep Work top-level channel. */
const DEEP_WORK_CHANNEL_ID = "a0000000-0000-0000-0000-000000000003";

/**
 * Create an ephemeral channel for a work item (ticket).
 * Placed under Deep Work. Returns existing channel if one already exists.
 */
export async function getOrCreateEphemeralChannel(
  supabase: SupabaseClient,
  workItemId: string,
): Promise<ChatChannel | null> {
  // Check if one already exists
  const { data: existing } = await supabase
    .from("chat_channels")
    .select("*")
    .eq("work_item_id", workItemId)
    .eq("is_ephemeral", true)
    .is("archived_at", null)
    .single();

  if (existing) return existing as ChatChannel;

  // Create new ephemeral channel
  const slug = `deep-work/${workItemId.toLowerCase()}`;
  return createChannel(supabase, {
    name: workItemId,
    slug,
    parent_id: DEEP_WORK_CHANNEL_ID,
    context_mode: "deep-work",
    is_ephemeral: true,
    work_item_id: workItemId,
    description: `Focused work on ${workItemId}`,
  });
}

/**
 * Archive ephemeral channels whose work items are Done.
 * Called periodically (reuses expireIdleConversations pattern).
 */
export async function archiveCompletedEphemeralChannels(
  supabase: SupabaseClient,
  isTicketDone: (workItemId: string) => Promise<boolean>,
): Promise<string[]> {
  const { data } = await supabase
    .from("chat_channels")
    .select("id, work_item_id")
    .eq("is_ephemeral", true)
    .not("work_item_id", "is", null)
    .is("archived_at", null);

  const archived: string[] = [];

  for (const ch of data || []) {
    if (ch.work_item_id && await isTicketDone(ch.work_item_id)) {
      await archiveChannel(supabase, ch.id);
      archived.push(ch.work_item_id);
    }
  }

  if (archived.length) {
    logger.info(`Auto-archived ${archived.length} ephemeral channels: ${archived.join(", ")}`);
  }

  return archived;
}

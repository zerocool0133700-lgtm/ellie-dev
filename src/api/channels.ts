/**
 * Channel API — ELLIE-842
 *
 * GET    /api/channels              — list all active channels with member counts
 * GET    /api/channels/:id          — single channel with members
 * POST   /api/channels              — create channel
 * PATCH  /api/channels/:id          — update channel
 * POST   /api/channels/:id/archive  — archive channel
 * GET    /api/channels/:id/members  — list members
 * POST   /api/channels/:id/members  — add member
 * DELETE /api/channels/:id/members/:memberId — remove member
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiRequest, ApiResponse } from "./types.ts";
import { log } from "../logger.ts";

const logger = log.child("channels-api");

export interface Channel {
  id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  sort_order: number;
  context_mode: string | null;
  is_ephemeral: boolean;
  work_item_id: string | null;
  description: string | null;
  icon: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  member_count?: number;
  children?: Channel[];
}

export interface ChannelMember {
  channel_id: string;
  member_type: "user" | "agent";
  member_id: string;
  display_name: string | null;
  joined_at: string;
}

/**
 * GET /api/channels
 */
export async function listChannels(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  try {
    const { data: channels, error } = await supabase
      .from("chat_channels")
      .select("*")
      .is("archived_at", null)
      .order("sort_order", { ascending: true });

    if (error) throw error;

    // Get member counts per channel
    const { data: memberCounts } = await supabase
      .from("channel_members")
      .select("channel_id");

    const countMap: Record<string, number> = {};
    for (const m of memberCounts ?? []) {
      countMap[m.channel_id] = (countMap[m.channel_id] || 0) + 1;
    }

    // Build tree structure
    const tree = buildChannelTree(channels ?? [], countMap);

    return res.json({ success: true, channels: tree });
  } catch (error) {
    logger.error("List channels failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

function buildChannelTree(channels: Channel[], countMap: Record<string, number>): Channel[] {
  const topLevel = channels.filter(c => !c.parent_id);
  const childMap: Record<string, Channel[]> = {};

  for (const c of channels) {
    if (c.parent_id) {
      if (!childMap[c.parent_id]) childMap[c.parent_id] = [];
      childMap[c.parent_id].push({ ...c, member_count: countMap[c.id] || 0 });
    }
  }

  return topLevel.map(c => ({
    ...c,
    member_count: countMap[c.id] || 0,
    children: (childMap[c.id] || []).sort((a, b) => a.sort_order - b.sort_order),
  }));
}

/**
 * GET /api/channels/:id
 */
export async function getChannel(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  const id = req.params?.id;
  if (!id) return res.status(400).json({ error: "Missing channel ID" });

  try {
    const { data: channel, error } = await supabase
      .from("chat_channels")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !channel) return res.status(404).json({ error: "Channel not found" });

    const { data: members } = await supabase
      .from("channel_members")
      .select("*")
      .eq("channel_id", id)
      .order("joined_at", { ascending: true });

    return res.json({ success: true, channel, members: members ?? [] });
  } catch (error) {
    logger.error("Get channel failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * POST /api/channels
 */
export async function createChannel(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  const { name, slug, parent_id, context_mode, description, icon, is_ephemeral, work_item_id } = req.body ?? {};

  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }

  const channelSlug = (slug as string) || (name as string).toLowerCase().replace(/[^a-z0-9]+/g, "-");

  try {
    // Get next sort_order
    const { data: existing } = await supabase
      .from("chat_channels")
      .select("sort_order")
      .eq("parent_id", parent_id ?? null)
      .order("sort_order", { ascending: false })
      .limit(1);

    const nextOrder = ((existing?.[0]?.sort_order as number) ?? 0) + 1;

    const { data: channel, error } = await supabase
      .from("chat_channels")
      .insert({
        name,
        slug: channelSlug,
        parent_id: parent_id ?? null,
        sort_order: nextOrder,
        context_mode: context_mode ?? "conversation",
        description: description ?? null,
        icon: icon ?? null,
        is_ephemeral: is_ephemeral ?? false,
        work_item_id: work_item_id ?? null,
      })
      .select()
      .single();

    if (error) throw error;

    // Auto-add Dave and Ellie (general) as members
    await supabase.from("channel_members").insert([
      { channel_id: channel.id, member_type: "user", member_id: "dave", display_name: "Dave" },
      { channel_id: channel.id, member_type: "agent", member_id: "general", display_name: "Ellie" },
    ]);

    logger.info("Channel created", { id: channel.id, name, slug: channelSlug });
    return res.json({ success: true, channel });
  } catch (error) {
    logger.error("Create channel failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * PATCH /api/channels/:id
 */
export async function updateChannel(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  const id = req.params?.id;
  if (!id) return res.status(400).json({ error: "Missing channel ID" });

  const updates: Record<string, unknown> = {};
  const allowed = ["name", "description", "icon", "context_mode", "sort_order"];
  for (const key of allowed) {
    if (req.body?.[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No valid fields to update" });
  }

  updates.updated_at = new Date().toISOString();

  try {
    const { data: channel, error } = await supabase
      .from("chat_channels")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return res.json({ success: true, channel });
  } catch (error) {
    logger.error("Update channel failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * POST /api/channels/:id/archive
 */
export async function archiveChannel(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  const id = req.params?.id;
  if (!id) return res.status(400).json({ error: "Missing channel ID" });

  try {
    const { data: channel, error } = await supabase
      .from("chat_channels")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    logger.info("Channel archived", { id });
    return res.json({ success: true, channel });
  } catch (error) {
    logger.error("Archive channel failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /api/channels/:id/members
 */
export async function listMembers(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  const id = req.params?.id;
  if (!id) return res.status(400).json({ error: "Missing channel ID" });

  try {
    const { data: members, error } = await supabase
      .from("channel_members")
      .select("*")
      .eq("channel_id", id)
      .order("joined_at", { ascending: true });

    if (error) throw error;
    return res.json({ success: true, members: members ?? [] });
  } catch (error) {
    logger.error("List members failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * POST /api/channels/:id/members
 */
export async function addMember(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  const id = req.params?.id;
  const { member_type, member_id, display_name } = req.body ?? {};

  if (!id || !member_type || !member_id) {
    return res.status(400).json({ error: "channel_id, member_type, and member_id required" });
  }

  try {
    const { error } = await supabase.from("channel_members").upsert({
      channel_id: id,
      member_type,
      member_id,
      display_name: display_name ?? null,
    });

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    logger.error("Add member failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * DELETE /api/channels/:id/members/:memberType/:memberId
 */
export async function removeMember(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  const { id, memberType, memberId } = req.params ?? {};
  if (!id || !memberType || !memberId) {
    return res.status(400).json({ error: "Missing params" });
  }

  try {
    const { error } = await supabase
      .from("channel_members")
      .delete()
      .eq("channel_id", id)
      .eq("member_type", memberType)
      .eq("member_id", memberId);

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    logger.error("Remove member failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * GET /api/agents/presence
 */
export async function getAgentPresence(req: ApiRequest, res: ApiResponse, supabase: SupabaseClient) {
  try {
    const { data, error } = await supabase
      .from("agent_presence")
      .select("*")
      .order("agent_name");

    if (error) throw error;
    return res.json({ success: true, presence: data ?? [] });
  } catch (error) {
    logger.error("Get presence failed", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

/**
 * Update agent presence (called internally by dispatch flow)
 */
export async function updateAgentPresence(
  supabase: SupabaseClient,
  agentName: string,
  status: "online" | "idle" | "busy" | "offline",
  channelId?: string,
  activity?: string,
) {
  try {
    await supabase
      .from("agent_presence")
      .upsert({
        agent_name: agentName,
        status,
        current_channel_id: channelId ?? null,
        current_activity: activity ?? null,
        last_seen: new Date().toISOString(),
      });
  } catch (error) {
    logger.error("Update presence failed", { agentName, status, error });
  }
}

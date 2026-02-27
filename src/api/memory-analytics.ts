/**
 * Memory Analytics API
 *
 * Endpoints:
 * - GET /api/memory/stats - Agent attribution stats
 * - GET /api/memory/timeline - Memory creation timeline by agent
 * - GET /api/memory/by-agent/:agent - Filter memories by agent
 */

import type { ApiRequest, ApiResponse } from './types.ts';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

interface MemoryStats {
  total: number;
  by_agent: Record<string, number>;
  by_type: Record<string, number>;
  by_visibility: Record<string, number>;
  attribution_rate: number; // % of memories with source_agent
}

interface TimelineEntry {
  date: string;
  agent: string;
  count: number;
}

interface AgentMemory {
  id: string;
  created_at: string;
  type: string;
  content: string;
  visibility: string;
}

/**
 * GET /api/memory/stats
 *
 * Returns memory attribution statistics
 */
export async function getMemoryStats(): Promise<MemoryStats> {
  const { data: memories, error } = await supabase
    .from('memory')
    .select('source_agent, type, visibility');

  if (error) {
    throw new Error(`Failed to fetch memories: ${error.message}`);
  }

  if (!memories) {
    throw new Error('No memories found');
  }

  const total = memories.length;

  const by_agent = memories.reduce((acc, m) => {
    const agent = m.source_agent || 'NULL';
    acc[agent] = (acc[agent] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const by_type = memories.reduce((acc, m) => {
    acc[m.type] = (acc[m.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const by_visibility = memories.reduce((acc, m) => {
    acc[m.visibility] = (acc[m.visibility] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const attributed = memories.filter(m => m.source_agent !== null).length;
  const attribution_rate = (attributed / total) * 100;

  return {
    total,
    by_agent,
    by_type,
    by_visibility,
    attribution_rate,
  };
}

/**
 * GET /api/memory/timeline
 *
 * Returns memory creation timeline grouped by agent and day
 */
export async function getMemoryTimeline(days: number = 30): Promise<TimelineEntry[]> {
  const { data: memories, error } = await supabase
    .from('memory')
    .select('created_at, source_agent')
    .gte('created_at', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch timeline: ${error.message}`);
  }

  if (!memories) {
    return [];
  }

  // Group by date and agent
  const timeline = memories.reduce((acc, m) => {
    const date = new Date(m.created_at).toISOString().split('T')[0];
    const agent = m.source_agent || 'NULL';
    const key = `${date}:${agent}`;

    if (!acc[key]) {
      acc[key] = { date, agent, count: 0 };
    }
    acc[key].count++;

    return acc;
  }, {} as Record<string, TimelineEntry>);

  return Object.values(timeline).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * GET /api/memory/by-agent/:agent
 *
 * Returns memories filtered by agent
 */
export async function getMemoriesByAgent(
  agent: string,
  limit: number = 50
): Promise<AgentMemory[]> {
  const query = supabase
    .from('memory')
    .select('id, created_at, type, content, visibility')
    .order('created_at', { ascending: false })
    .limit(limit);

  // Handle NULL case
  if (agent === 'NULL') {
    query.is('source_agent', null);
  } else {
    query.eq('source_agent', agent);
  }

  const { data: memories, error } = await query;

  if (error) {
    throw new Error(`Failed to fetch memories: ${error.message}`);
  }

  return memories || [];
}

/**
 * Route handlers
 */
export async function handleGetStats(req: ApiRequest, res: ApiResponse) {
  try {
    const stats = await getMemoryStats();
    res.json(stats);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGetTimeline(req: ApiRequest, res: ApiResponse) {
  try {
    const days = parseInt(req.query?.days || '30', 10);
    const timeline = await getMemoryTimeline(days);
    res.json(timeline);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGetByAgent(req: ApiRequest, res: ApiResponse) {
  try {
    const agent = req.params?.agent ?? '';
    const limit = parseInt(req.query?.limit || '50', 10);
    const memories = await getMemoriesByAgent(agent, limit);
    res.json(memories);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

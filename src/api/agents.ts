/**
 * Agent Registry API — ELLIE-91
 *
 * GET  /api/agents           — list all active agents
 * GET  /api/agents/:name     — full agent profile
 * GET  /api/agents/:name/skills — skills for this agent
 * GET  /api/capabilities?q=X — which agents handle capability X?
 */

import type { Bot } from "grammy";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAgent,
  listAgents,
  findAgentsForCapability,
} from '../../../ellie-forest/src/index';

/**
 * GET /api/agents
 */
export async function listAgentsEndpoint(req: any, res: any, _supabase: SupabaseClient, _bot: Bot) {
  try {
    const type = req.query?.type;
    const agents = await listAgents(type ? { type } : undefined);
    return res.json({
      success: true,
      count: agents.length,
      agents: agents.map(a => ({
        name: a.name,
        type: a.type,
        status: a.status,
        display_name: a.display_name,
        description: a.description,
        capabilities: a.capabilities,
        model: a.model,
        trust_level: a.trust_level,
        timeout_seconds: a.timeout_seconds,
      })),
    });
  } catch (error) {
    console.error('[agents:list] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/agents/:name
 */
export async function getAgentEndpoint(req: any, res: any, _supabase: SupabaseClient, _bot: Bot) {
  try {
    const name = req.params?.name || req.query?.name;
    if (!name) {
      return res.status(400).json({ error: 'Missing agent name' });
    }

    const agent = await getAgent(name);
    if (!agent) {
      return res.status(404).json({ error: `Agent "${name}" not found` });
    }

    return res.json({ success: true, agent });
  } catch (error) {
    console.error('[agents:get] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/agents/:name/skills
 */
export async function getAgentSkillsEndpoint(req: any, res: any, supabase: SupabaseClient, _bot: Bot) {
  try {
    const name = req.params?.name || req.query?.name;
    if (!name) {
      return res.status(400).json({ error: 'Missing agent name' });
    }

    // Skills are in Supabase, linked via agent name → agents.id → skills.agent_id
    const { data: skills, error } = await supabase
      .from('skills')
      .select('name, description, triggers, priority, enabled, examples')
      .eq('agents.name', name)
      .eq('enabled', true)
      .order('priority', { ascending: false });

    // If the join didn't work (Supabase quirk), try via subquery
    if (error || !skills) {
      const { data: agentRow } = await supabase
        .from('agents')
        .select('id')
        .eq('name', name)
        .single();

      if (!agentRow) {
        return res.json({ success: true, agent: name, skills: [] });
      }

      const { data: agentSkills } = await supabase
        .from('skills')
        .select('name, description, triggers, priority, enabled, examples')
        .eq('agent_id', agentRow.id)
        .eq('enabled', true)
        .order('priority', { ascending: false });

      return res.json({
        success: true,
        agent: name,
        count: agentSkills?.length ?? 0,
        skills: agentSkills ?? [],
      });
    }

    return res.json({
      success: true,
      agent: name,
      count: skills.length,
      skills,
    });
  } catch (error) {
    console.error('[agents:skills] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/capabilities?q=coding
 */
export async function findCapabilityEndpoint(req: any, res: any, _supabase: SupabaseClient, _bot: Bot) {
  try {
    const capability = req.query?.q;
    if (!capability) {
      return res.status(400).json({ error: 'Missing query parameter: q' });
    }

    const agents = await findAgentsForCapability(capability);
    return res.json({
      success: true,
      capability,
      count: agents.length,
      agents: agents.map(a => ({
        name: a.name,
        type: a.type,
        trust_level: a.trust_level,
        capabilities: a.capabilities,
      })),
    });
  } catch (error) {
    console.error('[agents:capabilities] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

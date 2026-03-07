/**
 * Agent Profile Builder — ELLIE-425
 *
 * Assembles a complete agent prompt by reading composable layers from the
 * "Agent Profiles" Forest tree (created by ELLIE-427).
 *
 * Assembly order:
 *   1. Soul       — soul/soul (core identity)
 *   2. Creature   — creatures/{creature} (behavioral DNA)
 *   3. Role       — roles/{role} (capabilities)
 *   4. Agent      — agents/{name} (wiring: tools, skills, budget)
 *   5. Relationship — relationship/{item} for each listed section
 *
 * Usage:
 *   const builder = await AgentProfileBuilder.load()
 *   const { prompt, tools, tokenBudget } = await builder.buildPrompt('dev-ant')
 *
 * The tree ID is read from config/agent-profiles-tree.json (written by bootstrap).
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { log as logger } from './logger.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Types ────────────────────────────────────────────────────

export interface AgentWiring {
  creature: string
  role: string
  token_budget: number
  context_mode: string
  soul: boolean
  relationship_sections: string[]
  skills: string[]
  section_priorities: Record<string, number>
}

export interface BuiltPrompt {
  prompt: string
  agentName: string
  creature: string
  role: string
  tokenBudget: number
  skills: string[]
  contextMode: string
  sectionPriorities: Record<string, number>
  layersLoaded: string[]
}

// ── Config ───────────────────────────────────────────────────

const CONFIG_PATH = resolve(__dirname, '../config/agent-profiles-tree.json')

let _treeId: string | null = null

function getTreeId(): string {
  if (_treeId) return _treeId
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    if (cfg.tree_id) {
      _treeId = cfg.tree_id
      return _treeId!
    }
  } catch {}
  throw new Error('Agent Profiles tree not found. Run: bun run scripts/bootstrap-agent-profiles.ts')
}

// ── Forest access ────────────────────────────────────────────

const FOREST_IMPORT = '../../ellie-forest/src/index'

async function readBranch(treeId: string, path: string): Promise<string | null> {
  try {
    const { getBranchByName, getLatestCommit } = await import(FOREST_IMPORT)
    const branch = await getBranchByName(treeId, path)
    if (!branch) return null
    const commit = await getLatestCommit(branch.id)
    return commit?.content_summary ?? null
  } catch (err) {
    logger.warn(`[agent-profile-builder] Failed to read branch ${path}: ${err}`)
    return null
  }
}

// ── YAML frontmatter parser ───────────────────────────────────────────────

function parseWiringFrontmatter(raw: string): { frontmatter: AgentWiring; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { frontmatter: defaultWiring(), body: raw }
  }

  const yaml = match[1]
  const body = match[2]
  const wiring = defaultWiring()

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim()

    if (key === 'creature') wiring.creature = val
    else if (key === 'role') wiring.role = val
    else if (key === 'token_budget') wiring.token_budget = parseInt(val, 10) || 100_000
    else if (key === 'context_mode') wiring.context_mode = val
    else if (key === 'soul') wiring.soul = val === 'true'
    else if (key === 'relationship_sections') {
      const listMatch = val.match(/\[([^\]]*)\]/)
      if (listMatch) {
        wiring.relationship_sections = listMatch[1].split(',').map(s => s.trim()).filter(Boolean)
      }
    } else if (key.startsWith('  ') || key.startsWith('\t')) {
      // Section priority line (indented key under section_priorities)
      const stripped = key.trim()
      const num = parseInt(val, 10)
      if (stripped && !isNaN(num)) wiring.section_priorities[stripped] = num
    }
  }

  // Parse skills block (multi-line list under skills:)
  const skillsMatch = yaml.match(/skills:\n((?:[ \t]+-[^\n]+\n?)*)/m)
  if (skillsMatch) {
    wiring.skills = skillsMatch[1]
      .split('\n')
      .map(l => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean)
  }

  return { frontmatter: wiring, body }
}

function defaultWiring(): AgentWiring {
  return {
    creature: 'squirrel',
    role: 'general',
    token_budget: 100_000,
    context_mode: 'conversation',
    soul: true,
    relationship_sections: ['psych', 'health'],
    skills: [],
    section_priorities: {},
  }
}

// ── Cache ─────────────────────────────────────────────────────

interface CacheEntry {
  content: string
  loadedAt: number
}

const _cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60_000  // 60s — same as existing prompt-builder

async function getCached(treeId: string, path: string): Promise<string | null> {
  const key = `${treeId}:${path}`
  const entry = _cache.get(key)
  if (entry && Date.now() - entry.loadedAt < CACHE_TTL_MS) {
    return entry.content
  }
  const content = await readBranch(treeId, path)
  if (content) {
    _cache.set(key, { content, loadedAt: Date.now() })
  }
  return content
}

export function invalidateProfileCache(): void {
  _cache.clear()
}

// ── Main builder ──────────────────────────────────────────────

/**
 * Build a complete agent prompt from the Forest tree layers.
 * Falls back gracefully if individual layers are missing.
 */
export async function buildAgentProfilePrompt(agentName: string): Promise<BuiltPrompt | null> {
  let treeId: string
  try {
    treeId = getTreeId()
  } catch (err) {
    logger.warn(`[agent-profile-builder] ${err}`)
    return null
  }

  // 1. Load wiring file
  const wiringRaw = await getCached(treeId, `agents/${agentName}`)
  if (!wiringRaw) {
    logger.warn(`[agent-profile-builder] No wiring file for agent: ${agentName}`)
    return null
  }
  const { frontmatter: wiring } = parseWiringFrontmatter(wiringRaw)

  const sections: { label: string; content: string }[] = []
  const layersLoaded: string[] = []

  // 2. Soul
  if (wiring.soul) {
    const soul = await getCached(treeId, 'soul/soul')
    if (soul) {
      sections.push({ label: 'soul', content: soul })
      layersLoaded.push('soul')
    }
  }

  // 3. Creature DNA
  const creature = await getCached(treeId, `creatures/${wiring.creature}`)
  if (creature) {
    sections.push({ label: 'creature', content: creature })
    layersLoaded.push(`creatures/${wiring.creature}`)
  }

  // 4. Role capabilities
  const role = await getCached(treeId, `roles/${wiring.role}`)
  if (role) {
    sections.push({ label: 'role', content: role })
    layersLoaded.push(`roles/${wiring.role}`)
  }

  // 5. Relationship sections
  for (const relSection of wiring.relationship_sections) {
    const rel = await getCached(treeId, `relationship/${relSection}`)
    if (rel) {
      sections.push({ label: `relationship/${relSection}`, content: rel })
      layersLoaded.push(`relationship/${relSection}`)
    }
  }

  if (sections.length === 0) {
    logger.warn(`[agent-profile-builder] No layers loaded for ${agentName}`)
    return null
  }

  // Assemble
  const prompt = sections
    .map(s => s.content.trim())
    .join('\n\n---\n\n')

  return {
    prompt,
    agentName,
    creature: wiring.creature,
    role: wiring.role,
    tokenBudget: wiring.token_budget,
    skills: wiring.skills,
    contextMode: wiring.context_mode,
    sectionPriorities: wiring.section_priorities,
    layersLoaded,
  }
}

// ── Creature+Role only (for prompt-builder archetype slot) ───────────────────

export interface CreatureRoleContent {
  content: string
  wiring: AgentWiring
  layersLoaded: string[]
}

/**
 * Build only the creature + role layers for an agent (no soul, no relationship).
 * Used by prompt-builder.ts as a Forest-backed replacement for the archetype file.
 * Soul and relationship sections are assembled separately by the prompt builder.
 */
export async function buildCreatureRoleContent(agentName: string): Promise<CreatureRoleContent | null> {
  let treeId: string
  try {
    treeId = getTreeId()
  } catch { return null }

  const wiringRaw = await getCached(treeId, `agents/${agentName}`)
  if (!wiringRaw) return null
  const { frontmatter: wiring } = parseWiringFrontmatter(wiringRaw)

  const sections: string[] = []
  const layersLoaded: string[] = []

  const creature = await getCached(treeId, `creatures/${wiring.creature}`)
  if (creature) {
    sections.push(creature.trim())
    layersLoaded.push(`creatures/${wiring.creature}`)
  }

  const role = await getCached(treeId, `roles/${wiring.role}`)
  if (role) {
    sections.push(role.trim())
    layersLoaded.push(`roles/${wiring.role}`)
  }

  if (sections.length === 0) return null

  return {
    content: sections.join('\n\n---\n\n'),
    wiring,
    layersLoaded,
  }
}

/**
 * Get just the wiring config for an agent (no content assembly).
 * Useful for routing decisions, token budget checks, tool list generation.
 */
export async function getAgentWiring(agentName: string): Promise<AgentWiring | null> {
  let treeId: string
  try {
    treeId = getTreeId()
  } catch { return null }

  const wiringRaw = await getCached(treeId, `agents/${agentName}`)
  if (!wiringRaw) return null
  return parseWiringFrontmatter(wiringRaw).frontmatter
}

/**
 * List all available agent names from the tree.
 */
export async function listAgentProfiles(): Promise<string[]> {
  let treeId: string
  try {
    treeId = getTreeId()
  } catch { return [] }

  try {
    const { listBranches } = await import(FOREST_IMPORT)
    const branches = await listBranches(treeId, 'agents/')
    return branches.map((b: { name: string }) => b.name.replace('agents/', ''))
  } catch {
    return []
  }
}

/**
 * Agent Identity Binding — ELLIE-607
 *
 * Binds agents to their archetype (behavioral style) and role
 * (functional capability). Each agent specifies which archetype
 * and role it uses; this module manages those bindings and validates
 * that referenced files exist.
 *
 * Example bindings:
 *   dev agent     → archetype: "ant", role: "dev"
 *   research agent → archetype: "owl", role: "researcher"
 *   teaching agent → archetype: "owl", role: "lecturer"
 *
 * Depends on:
 *   archetype-loader.ts (ELLIE-604) — archetype file loading
 *   role-loader.ts (ELLIE-606) — role file loading
 *
 * Pure module — in-memory store, zero external side effects.
 */

import { readFileSync, existsSync, watch, type FSWatcher } from "fs";
import { join } from "path";
import { hasArchetype, getArchetype, type ArchetypeConfig } from "./archetype-loader";
import { hasRole, getRole, type RoleConfig } from "./role-loader";

// ── Types ────────────────────────────────────────────────────────────────────

/** An agent's identity binding — which archetype and role it uses. */
export interface AgentBinding {
  agentName: string;
  archetype: string;
  role: string;
}

/** Validation warning (not fatal — agent still functions). */
export interface BindingWarning {
  agentName: string;
  field: "archetype" | "role";
  message: string;
}

/** Result of validating all bindings. */
export interface BindingValidationResult {
  valid: boolean;
  warnings: BindingWarning[];
}

/** Resolved binding with loaded archetype and role configs. */
export interface ResolvedBinding {
  agentName: string;
  archetype: ArchetypeConfig | null;
  role: RoleConfig | null;
  warnings: BindingWarning[];
}

// ── Default Bindings ─────────────────────────────────────────────────────────

/** Default archetype-role bindings for known agents. */
export const DEFAULT_BINDINGS: AgentBinding[] = [
  { agentName: "dev", archetype: "ant", role: "dev" },
  { agentName: "general", archetype: "ant", role: "general" },
  { agentName: "research", archetype: "owl", role: "researcher" },
  { agentName: "strategy", archetype: "owl", role: "strategy" },
  { agentName: "critic", archetype: "ant", role: "critic" },
  { agentName: "content", archetype: "bee", role: "content" },
  { agentName: "finance", archetype: "ant", role: "finance" },
  { agentName: "ops", archetype: "ant", role: "ops" },
];

// ── Constants ────────────────────────────────────────────────────────────────

/** Default path to the bindings config file. */
export const DEFAULT_BINDINGS_PATH = join("config", "bindings.json");

// ── Storage ──────────────────────────────────────────────────────────────────

const _bindings = new Map<string, AgentBinding>();
let _watcher: FSWatcher | null = null;

// ── Registration ─────────────────────────────────────────────────────────────

/**
 * Register a binding for an agent.
 * Overwrites any existing binding for the same agent.
 */
export function registerBinding(binding: AgentBinding): AgentBinding {
  const normalized: AgentBinding = {
    agentName: binding.agentName.toLowerCase(),
    archetype: binding.archetype.toLowerCase(),
    role: binding.role.toLowerCase(),
  };
  _bindings.set(normalized.agentName, normalized);
  return normalized;
}

/**
 * Register multiple bindings at once.
 */
export function registerBindings(bindings: AgentBinding[]): void {
  for (const binding of bindings) {
    registerBinding(binding);
  }
}

/**
 * Load default bindings for all known agents.
 * Only sets bindings that don't already exist (won't overwrite custom).
 */
export function loadDefaultBindings(): number {
  let count = 0;
  for (const binding of DEFAULT_BINDINGS) {
    const key = binding.agentName.toLowerCase();
    if (!_bindings.has(key)) {
      registerBinding(binding);
      count++;
    }
  }
  return count;
}

/**
 * Remove a binding for an agent.
 */
export function removeBinding(agentName: string): boolean {
  return _bindings.delete(agentName.toLowerCase());
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get the binding for an agent. Case-insensitive.
 */
export function getBinding(agentName: string): AgentBinding | null {
  return _bindings.get(agentName.toLowerCase()) ?? null;
}

/**
 * List all registered bindings.
 */
export function listBindings(): AgentBinding[] {
  return [..._bindings.values()];
}

/**
 * Get agents that use a specific archetype.
 */
export function getAgentsByArchetype(archetype: string): string[] {
  const normalized = archetype.toLowerCase();
  return [..._bindings.values()]
    .filter(b => b.archetype === normalized)
    .map(b => b.agentName);
}

/**
 * Get agents that use a specific role.
 */
export function getAgentsByRole(role: string): string[] {
  const normalized = role.toLowerCase();
  return [..._bindings.values()]
    .filter(b => b.role === normalized)
    .map(b => b.agentName);
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a single binding — check that referenced archetype and role exist.
 * Returns warnings (not errors — missing files are non-fatal).
 */
export function validateBinding(binding: AgentBinding): BindingWarning[] {
  const warnings: BindingWarning[] = [];

  if (!hasArchetype(binding.archetype)) {
    warnings.push({
      agentName: binding.agentName,
      field: "archetype",
      message: `Archetype "${binding.archetype}" not loaded for agent "${binding.agentName}"`,
    });
  }

  if (!hasRole(binding.role)) {
    warnings.push({
      agentName: binding.agentName,
      field: "role",
      message: `Role "${binding.role}" not loaded for agent "${binding.agentName}"`,
    });
  }

  return warnings;
}

/**
 * Validate all registered bindings.
 */
export function validateAllBindings(): BindingValidationResult {
  const warnings: BindingWarning[] = [];

  for (const binding of _bindings.values()) {
    warnings.push(...validateBinding(binding));
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolve a binding — look up the actual archetype and role configs.
 * Returns null configs for missing files (with warnings).
 */
export function resolveBinding(agentName: string): ResolvedBinding | null {
  const binding = getBinding(agentName);
  if (!binding) return null;

  const warnings: BindingWarning[] = [];
  const archetypeConfig = getArchetype(binding.archetype);
  const roleConfig = getRole(binding.role);

  if (!archetypeConfig) {
    warnings.push({
      agentName: binding.agentName,
      field: "archetype",
      message: `Archetype "${binding.archetype}" not loaded`,
    });
  }

  if (!roleConfig) {
    warnings.push({
      agentName: binding.agentName,
      field: "role",
      message: `Role "${binding.role}" not loaded`,
    });
  }

  return {
    agentName: binding.agentName,
    archetype: archetypeConfig,
    role: roleConfig,
    warnings,
  };
}

/**
 * Resolve all bindings at once.
 */
export function resolveAllBindings(): ResolvedBinding[] {
  return [..._bindings.keys()].map(name => resolveBinding(name)!);
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * Build a summary of all bindings for logging/display.
 */
export function buildBindingsSummary(): string {
  const bindings = listBindings();
  if (bindings.length === 0) return "No agent bindings registered.";

  const lines = [`Agent Identity Bindings (${bindings.length}):`];
  for (const b of bindings) {
    const archetypeStatus = hasArchetype(b.archetype) ? "ok" : "MISSING";
    const roleStatus = hasRole(b.role) ? "ok" : "MISSING";
    lines.push(
      `  ${b.agentName}: archetype=${b.archetype} [${archetypeStatus}], role=${b.role} [${roleStatus}]`,
    );
  }
  return lines.join("\n");
}

// ── File Loading (ELLIE-620) ─────────────────────────────────────────────────

/**
 * Load bindings from a JSON config file.
 * The file should contain an array of AgentBinding objects.
 * Returns the number of bindings loaded, or an error string.
 */
export function loadBindingsFromFile(filePath?: string): { loaded: number; error?: string } {
  const path = filePath ?? DEFAULT_BINDINGS_PATH;

  if (!existsSync(path)) {
    return { loaded: 0, error: `Bindings file not found: ${path}` };
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { loaded: 0, error: `Failed to read bindings file: ${err}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { loaded: 0, error: `Invalid JSON in bindings file: ${err}` };
  }

  if (!Array.isArray(parsed)) {
    return { loaded: 0, error: "Bindings file must contain a JSON array" };
  }

  let loaded = 0;
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.agentName === "string" &&
      typeof entry.archetype === "string" &&
      typeof entry.role === "string"
    ) {
      registerBinding(entry as AgentBinding);
      loaded++;
    }
  }

  return { loaded };
}

/**
 * Start watching a bindings JSON file for changes.
 * On change, clears all bindings and reloads from the file.
 * Returns true if the watcher was started.
 */
export function startBindingsWatcher(
  filePath?: string,
  onChange?: (loaded: number) => void,
): boolean {
  const path = filePath ?? DEFAULT_BINDINGS_PATH;

  if (_watcher) return false;
  if (!existsSync(path)) return false;

  try {
    _watcher = watch(path, (eventType) => {
      if (eventType === "change") {
        _bindings.clear();
        const result = loadBindingsFromFile(path);
        if (result.loaded === 0) {
          loadDefaultBindings();
        }
        onChange?.(result.loaded);
      }
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the bindings file watcher.
 */
export function stopBindingsWatcher(): void {
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
}

// ── Testing ──────────────────────────────────────────────────────────────────

/** Reset all state — for testing only. */
export function _resetBindingsForTesting(): void {
  _bindings.clear();
  stopBindingsWatcher();
}

/**
 * Identity System Startup — ELLIE-615
 *
 * Wires the ODS identity system (archetypes, roles, bindings) into
 * the relay startup sequence. The modules are already built and tested
 * (ELLIE-603 through ELLIE-609) — this module initializes them at runtime.
 *
 * Startup flow:
 *   1. Load archetypes from config/archetypes/
 *   2. Load roles from config/roles/
 *   3. Register default agent→archetype+role bindings
 *   4. Validate bindings (warn on missing files)
 *   5. Start file watchers for hot-reload
 *   6. Log summary
 *
 * Shutdown: stop file watchers.
 */

import { log } from "./logger.ts";
import {
  loadArchetypes,
  startWatcher as startArchetypeWatcher,
  stopWatcher as stopArchetypeWatcher,
  listArchetypes,
  listArchetypeConfigs,
  archetypeCount,
  DEFAULT_ARCHETYPES_DIR,
  type LoadResult,
} from "./archetype-loader.ts";
import {
  loadRoles,
  startWatcher as startRoleWatcher,
  stopWatcher as stopRoleWatcher,
  listRoles,
  roleCount,
  DEFAULT_ROLES_DIR,
  type RoleLoadResult,
} from "./role-loader.ts";
import {
  loadBindingsFromFile,
  loadDefaultBindings,
  validateAllBindings,
  listBindings,
  buildBindingsSummary,
  startBindingsWatcher,
  stopBindingsWatcher,
  DEFAULT_BINDINGS_PATH,
  type BindingValidationResult,
} from "./agent-identity-binding.ts";

const logger = log.child("identity");

// ── Types ────────────────────────────────────────────────────────────────────

/** Result of the full identity system initialization. */
export interface IdentityStartupResult {
  archetypes: LoadResult;
  roles: RoleLoadResult;
  bindingsLoaded: number;
  bindingValidation: BindingValidationResult;
  archetypeValidationWarnings: string[];
  watchersStarted: { archetypes: boolean; roles: boolean; bindings: boolean };
  bindingsSource: "file" | "defaults";
}

// ── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the full identity system.
 *
 * 1. Load archetypes and roles from config directories
 * 2. Register default bindings
 * 3. Validate bindings (log warnings for missing files)
 * 4. Start file watchers for hot-reload
 * 5. Log summary
 *
 * Non-fatal — failures are logged but don't abort startup.
 */
export function initIdentitySystem(opts?: {
  archetypesDir?: string;
  rolesDir?: string;
  bindingsPath?: string;
  skipWatchers?: boolean;
}): IdentityStartupResult {
  const archetypesDir = opts?.archetypesDir ?? DEFAULT_ARCHETYPES_DIR;
  const rolesDir = opts?.rolesDir ?? DEFAULT_ROLES_DIR;

  // 1. Load archetypes
  const archetypes = loadArchetypes(archetypesDir);
  if (archetypes.loaded > 0) {
    logger.info(`Loaded ${archetypes.loaded} archetypes`, {
      names: listArchetypes(),
      failed: archetypes.failed,
    });
  } else {
    logger.warn("No archetypes loaded", { dir: archetypesDir, errors: archetypes.errors });
  }
  if (archetypes.errors.length > 0) {
    for (const err of archetypes.errors) {
      logger.warn(`Archetype load error: ${err.file} — ${err.reason}`);
    }
  }
  // ELLIE-617: Validate loaded archetypes against schema requirements
  const archetypeValidationWarnings: string[] = [];
  for (const config of listArchetypeConfigs()) {
    if (!config.validation.valid) {
      for (const err of config.validation.errors) {
        const msg = `Archetype "${config.species}" validation: ${err.message}`;
        archetypeValidationWarnings.push(msg);
        logger.warn(msg);
      }
    }
  }

  // 2. Load roles
  const roles = loadRoles(rolesDir);
  if (roles.loaded > 0) {
    logger.info(`Loaded ${roles.loaded} roles`, {
      names: listRoles(),
      failed: roles.failed,
    });
  } else {
    logger.warn("No roles loaded", { dir: rolesDir, errors: roles.errors });
  }
  if (roles.errors.length > 0) {
    for (const err of roles.errors) {
      logger.warn(`Role load error: ${err.file} — ${err.reason}`);
    }
  }

  // 3. Load bindings — try config file first, fall back to hardcoded defaults (ELLIE-620)
  let bindingsLoaded: number;
  let bindingsSource: "file" | "defaults";
  const bindingsPath = opts?.bindingsPath ?? DEFAULT_BINDINGS_PATH;
  const fileResult = loadBindingsFromFile(bindingsPath);
  if (fileResult.loaded > 0) {
    bindingsLoaded = fileResult.loaded;
    bindingsSource = "file";
    logger.info(`Loaded ${bindingsLoaded} agent bindings from ${bindingsPath}`);
  } else {
    if (fileResult.error) {
      logger.warn(`Bindings file: ${fileResult.error} — falling back to defaults`);
    }
    bindingsLoaded = loadDefaultBindings();
    bindingsSource = "defaults";
    logger.info(`Registered ${bindingsLoaded} default agent bindings`);
  }

  // 4. Validate bindings
  const bindingValidation = validateAllBindings();
  if (!bindingValidation.valid) {
    for (const w of bindingValidation.warnings) {
      logger.warn(`Binding warning: ${w.message}`);
    }
  }

  // 5. Start file watchers (unless skipped)
  let watchersStarted = { archetypes: false, roles: false, bindings: false };
  if (!opts?.skipWatchers) {
    watchersStarted.archetypes = startArchetypeWatcher(archetypesDir, (event, species) => {
      logger.info(`Archetype ${event}: ${species}`);
    });
    watchersStarted.roles = startRoleWatcher(rolesDir, (event, role) => {
      logger.info(`Role ${event}: ${role}`);
    });
    watchersStarted.bindings = startBindingsWatcher(bindingsPath, (loaded) => {
      logger.info(`Bindings reloaded: ${loaded} agents`);
    });
    if (watchersStarted.archetypes || watchersStarted.roles || watchersStarted.bindings) {
      logger.info("Identity hot-reload watchers started", watchersStarted);
    }
  }

  // 6. Log summary
  logger.info(buildBindingsSummary());

  return {
    archetypes,
    roles,
    bindingsLoaded,
    bindingValidation,
    archetypeValidationWarnings,
    watchersStarted,
    bindingsSource,
  };
}

/**
 * Stop identity system watchers. Called during graceful shutdown.
 */
export function shutdownIdentitySystem(): void {
  stopArchetypeWatcher();
  stopRoleWatcher();
  stopBindingsWatcher();
  logger.info("Identity system watchers stopped");
}

/**
 * Get a quick status summary for health checks.
 */
export function getIdentityStatus(): {
  archetypes: number;
  roles: number;
  bindings: number;
} {
  return {
    archetypes: archetypeCount(),
    roles: roleCount(),
    bindings: listBindings().length,
  };
}

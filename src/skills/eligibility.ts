/**
 * Eligibility Filter — ELLIE-217 / ELLIE-253
 *
 * Determines which loaded skills are eligible to run on this system.
 * Checks: OS, required binaries, required env vars, credential domains.
 *
 * ELLIE-253: Credential lookup now uses The Hollow (Forest DB) instead of
 * the old Supabase Credential Vault.
 */

import type { SkillEntry } from "./types.ts";
import { log } from "../logger.ts";

const logger = log.child("skill-eligibility");

/**
 * Filter skills to only those eligible on this system.
 * Fetches credential domains once and checks each skill against them.
 */
export async function filterEligibleSkills(skills: SkillEntry[]): Promise<SkillEntry[]> {
  const credentialDomains = await getCredentialDomains();
  return skills.filter(s => isSkillEligible(s, credentialDomains));
}

/**
 * Check if a single skill is eligible to run.
 */
export function isSkillEligible(entry: SkillEntry, credentialDomains?: Set<string>): boolean {
  const { requires, os: osList, always } = entry.frontmatter;

  // Always-on skills bypass all checks
  if (always) return true;

  // OS check
  if (osList && osList.length > 0 && !osList.includes(process.platform)) {
    return false;
  }

  // Required binaries on PATH
  if (requires?.bins) {
    for (const bin of requires.bins) {
      if (!commandExists(bin)) return false;
    }
  }

  // Required env vars
  if (requires?.env) {
    for (const envKey of requires.env) {
      if (!process.env[envKey]) return false;
    }
  }

  // Required credentials (check by domain)
  if (requires?.credentials) {
    if (!credentialDomains) return false; // no hollow available — fail closed
    for (const domain of requires.credentials) {
      if (!credentialDomains.has(domain)) return false;
    }
  }

  return true;
}

/**
 * Fetch all domains that have credentials in the Hollow.
 * Cached for 60s to avoid hammering the DB on every snapshot rebuild.
 */
let domainCache: Set<string> | null = null;
let domainCacheTime = 0;
// ELLIE-235: Extended from 60s to 10min — credential domains rarely change
const CACHE_TTL = 10 * 60_000;

async function getCredentialDomains(): Promise<Set<string>> {
  const now = Date.now();
  if (domainCache && now - domainCacheTime < CACHE_TTL) {
    return domainCache;
  }

  try {
    const { listCredentialDomains } = await import("../../../ellie-forest/src/hollow");
    const domains = await listCredentialDomains();
    domainCache = new Set(domains);
    console.log(`[skills] Credential domains: ${domains.join(", ") || "(none)"}`);
  } catch (err: any) {
    logger.warn("Credential domain lookup error", { error: err?.message });
    domainCache = new Set();
  }

  domainCacheTime = now;
  return domainCache;
}

/**
 * Check if a command exists on PATH (synchronous, cached).
 */
const binCache = new Map<string, boolean>();

function commandExists(bin: string): boolean {
  if (binCache.has(bin)) return binCache.get(bin)!;

  try {
    const result = Bun.spawnSync(["which", bin], { stdout: "pipe", stderr: "pipe" });
    const exists = result.exitCode === 0;
    binCache.set(bin, exists);
    return exists;
  } catch {
    binCache.set(bin, false);
    return false;
  }
}

/**
 * Clear the binary cache (useful after hot-reload or install).
 */
export function clearBinCache(): void {
  binCache.clear();
  domainCache = null;
  domainCacheTime = 0;
}

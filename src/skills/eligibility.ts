/**
 * Eligibility Filter — ELLIE-217
 *
 * Determines which loaded skills are eligible to run on this system.
 * Checks: OS, required binaries, required env vars, vault credentials.
 */

import type { SkillEntry } from "./types.ts";

/**
 * Filter skills to only those eligible on this system.
 * Fetches vault domains once and checks each skill against them.
 */
export async function filterEligibleSkills(skills: SkillEntry[]): Promise<SkillEntry[]> {
  const vaultDomains = await getVaultDomains();
  return skills.filter(s => isSkillEligible(s, vaultDomains));
}

/**
 * Check if a single skill is eligible to run.
 */
export function isSkillEligible(entry: SkillEntry, vaultDomains?: Set<string>): boolean {
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

  // Required vault credentials (check by domain)
  if (requires?.credentials) {
    if (!vaultDomains) return false; // no vault available — fail closed
    for (const domain of requires.credentials) {
      if (!vaultDomains.has(domain)) return false;
    }
  }

  return true;
}

/**
 * Fetch all domains that have credentials in the vault.
 * Cached for 60s to avoid hammering the DB on every snapshot rebuild.
 */
let vaultDomainCache: Set<string> | null = null;
let vaultCacheTime = 0;
const VAULT_CACHE_TTL = 60_000;

async function getVaultDomains(): Promise<Set<string>> {
  const now = Date.now();
  if (vaultDomainCache && now - vaultCacheTime < VAULT_CACHE_TTL) {
    return vaultDomainCache;
  }

  try {
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      vaultDomainCache = new Set();
      vaultCacheTime = now;
      return vaultDomainCache;
    }

    const supabase = createClient(url, key);
    const { data, error } = await supabase
      .from("credentials")
      .select("domain");

    if (error || !data) {
      console.warn("[skills] Vault domain lookup failed:", error?.message);
      vaultDomainCache = new Set();
    } else {
      vaultDomainCache = new Set(data.map((r: { domain: string }) => r.domain));
      console.log(`[skills] Vault domains: ${[...vaultDomainCache].join(", ") || "(none)"}`);
    }
  } catch (err: any) {
    console.warn("[skills] Vault domain lookup error:", err?.message);
    vaultDomainCache = new Set();
  }

  vaultCacheTime = now;
  return vaultDomainCache;
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
  vaultDomainCache = null;
  vaultCacheTime = 0;
}

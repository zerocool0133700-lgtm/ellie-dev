/**
 * Company Scoping Types — ELLIE-724
 *
 * Types for multi-tenancy company isolation.
 * Pure types module — no side effects.
 */

// ── Core Types ──────────────────────────────────────────────

/** A company record (maps to companies table). */
export interface Company {
  id: string;
  created_at: Date;
  updated_at: Date;
  name: string;
  slug: string;
  status: CompanyStatus;
  metadata: Record<string, unknown>;
}

export type CompanyStatus = "active" | "paused" | "archived";

/** Valid company statuses. */
export const VALID_COMPANY_STATUSES = [
  "active",
  "paused",
  "archived",
] as const;

/** The default company ID for Dave's existing data. */
export const DEFAULT_COMPANY_ID = "00000000-0000-0000-0000-000000000001";

// ── Input Types ─────────────────────────────────────────────

/** Input for creating a company. */
export interface CreateCompanyInput {
  name: string;
  slug: string;
  status?: CompanyStatus;
  metadata?: Record<string, unknown>;
}

/** Input for updating a company. */
export interface UpdateCompanyInput {
  name?: string;
  slug?: string;
  status?: CompanyStatus;
  metadata?: Record<string, unknown>;
}

// ── Scoped Query Helper ─────────────────────────────────────

/** Mixin type for records that belong to a company. */
export interface CompanyScoped {
  company_id: string | null;
}

/**
 * Generate a slug from a company name.
 * Lowercase, replace spaces/special chars with hyphens, collapse multiples.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

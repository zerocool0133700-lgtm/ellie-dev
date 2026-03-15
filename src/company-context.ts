/**
 * Company Context & Switcher — ELLIE-729
 *
 * Backend support for company switcher UI. Provides:
 * - Company context state management (pure, testable)
 * - API route handlers for list/switch/current
 * - Scoped data summary for the selected company
 *
 * Used by the dashboard (ellie-home) and relay API.
 */

import { sql } from "../../ellie-forest/src/index";
import { DEFAULT_COMPANY_ID } from "./types/company";
import type { Company, CompanyStatus } from "./types/company";

// ── Types ────────────────────────────────────────────────────

/** Company list item for the switcher dropdown. */
export interface CompanySwitcherItem {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
}

/** Summary data for the currently selected company. */
export interface CompanyDashboardSummary {
  company_id: string;
  agent_count: number;
  active_formations: number;
  pending_approvals: number;
  monthly_spend_cents: number;
}

/** The persisted company context (what gets stored in session/localStorage). */
export interface CompanyContextState {
  selected_company_id: string;
  selected_at: string; // ISO timestamp
}

// ── Company Context Manager (Pure) ──────────────────────────

/**
 * Create a new company context, defaulting to the default company.
 */
export function createCompanyContext(
  companyId?: string,
): CompanyContextState {
  return {
    selected_company_id: companyId ?? DEFAULT_COMPANY_ID,
    selected_at: new Date().toISOString(),
  };
}

/**
 * Switch the selected company in a context.
 * Returns a new context object (immutable).
 */
export function switchCompany(
  current: CompanyContextState,
  newCompanyId: string,
): CompanyContextState {
  if (current.selected_company_id === newCompanyId) {
    return current; // No-op if same company
  }

  return {
    selected_company_id: newCompanyId,
    selected_at: new Date().toISOString(),
  };
}

/**
 * Validate a company context state object.
 * Returns errors array (empty = valid).
 */
export function validateCompanyContext(
  state: unknown,
): string[] {
  const errors: string[] = [];

  if (!state || typeof state !== "object") {
    errors.push("Context must be an object");
    return errors;
  }

  const s = state as Record<string, unknown>;

  if (typeof s.selected_company_id !== "string" || !s.selected_company_id) {
    errors.push("selected_company_id is required and must be a non-empty string");
  }

  if (typeof s.selected_at !== "string" || !s.selected_at) {
    errors.push("selected_at is required and must be an ISO timestamp string");
  } else {
    const d = new Date(s.selected_at as string);
    if (isNaN(d.getTime())) {
      errors.push("selected_at must be a valid ISO timestamp");
    }
  }

  return errors;
}

/**
 * Serialize context for localStorage/cookie storage.
 */
export function serializeContext(state: CompanyContextState): string {
  return JSON.stringify(state);
}

/**
 * Deserialize context from localStorage/cookie.
 * Returns null if invalid.
 */
export function deserializeContext(raw: string): CompanyContextState | null {
  try {
    const parsed = JSON.parse(raw);
    const errors = validateCompanyContext(parsed);
    if (errors.length > 0) return null;
    return parsed as CompanyContextState;
  } catch {
    return null;
  }
}

// ── Database Queries ────────────────────────────────────────

/**
 * List companies for the switcher dropdown.
 * Only active and paused companies (not archived).
 */
export async function listSwitcherCompanies(): Promise<CompanySwitcherItem[]> {
  return sql<CompanySwitcherItem[]>`
    SELECT id, name, slug, status
    FROM companies
    WHERE status IN ('active', 'paused')
    ORDER BY name ASC
  `;
}

/**
 * Get the dashboard summary for a company.
 * Aggregates key metrics for the company switcher header.
 */
export async function getCompanyDashboardSummary(
  companyId: string,
): Promise<CompanyDashboardSummary> {
  const [agentCount] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM agents
    WHERE company_id = ${companyId}::uuid AND status = 'active'
  `;

  const [activeFormations] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM formation_sessions
    WHERE company_id = ${companyId}::uuid AND state = 'active'
  `;

  const [pendingApprovals] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM formation_approvals fa
    JOIN formation_sessions fs ON fa.formation_session_id = fs.id
    WHERE fs.company_id = ${companyId}::uuid AND fa.status = 'pending'
  `;

  const [monthlySpend] = await sql<{ total: number }[]>`
    SELECT COALESCE(SUM(spent_this_month_cents), 0)::int AS total
    FROM agent_budgets
    WHERE company_id = ${companyId}::uuid
  `;

  return {
    company_id: companyId,
    agent_count: agentCount?.count ?? 0,
    active_formations: activeFormations?.count ?? 0,
    pending_approvals: pendingApprovals?.count ?? 0,
    monthly_spend_cents: monthlySpend?.total ?? 0,
  };
}

/**
 * Validate that a company exists and is accessible (not archived).
 */
export async function validateCompanyAccess(
  companyId: string,
): Promise<{ valid: boolean; reason?: string }> {
  const [company] = await sql<Company[]>`
    SELECT * FROM companies WHERE id = ${companyId}::uuid
  `;

  if (!company) {
    return { valid: false, reason: "Company not found" };
  }

  if (company.status === "archived") {
    return { valid: false, reason: "Company is archived" };
  }

  return { valid: true };
}

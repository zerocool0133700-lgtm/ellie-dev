/**
 * Company Data Isolation — ELLIE-730
 *
 * Query middleware and helpers for enforcing per-company data isolation.
 * Sets PostgreSQL session variable for RLS, validates company context,
 * and provides scoped query wrappers.
 */

import { sql } from "../../ellie-forest/src/index";
import type { Company } from "./types/company";

// ── Types ────────────────────────────────────────────────────

/** Tables that are scoped to a company. */
export const COMPANY_SCOPED_TABLES = [
  "agents",
  "formation_sessions",
  "work_sessions",
  "agent_budgets",
  "agent_audit_log",
  "agent_delegations",
] as const;

export type CompanyScopedTable = typeof COMPANY_SCOPED_TABLES[number];

/** Result of an isolation check. */
export interface IsolationCheckResult {
  isolated: boolean;
  company_id: string | null;
  errors: string[];
}

/** Request context containing company info, extracted from header/JWT. */
export interface CompanyRequestContext {
  company_id: string;
  source: "header" | "jwt" | "session" | "default";
}

// ── Set Company Context (PostgreSQL Session) ────────────────

/**
 * Set the active company for the current database session.
 * All subsequent queries on RLS-enabled tables will be scoped.
 *
 * Uses SET LOCAL so it only applies within the current transaction.
 */
export async function setCompanyContext(companyId: string): Promise<void> {
  await sql`SELECT set_config('app.current_company_id', ${companyId}, true)`;
}

/**
 * Clear the company context (reverts to service-role access).
 */
export async function clearCompanyContext(): Promise<void> {
  await sql`SELECT set_config('app.current_company_id', '', true)`;
}

/**
 * Get the currently active company context from the database session.
 */
export async function getCompanyContext(): Promise<string | null> {
  const [row] = await sql<{ value: string }[]>`
    SELECT NULLIF(current_setting('app.current_company_id', true), '') AS value
  `;
  return row?.value ?? null;
}

// ── Request Middleware ───────────────────────────────────────

/**
 * Extract company context from an HTTP request.
 * Checks (in order): X-Company-Id header, JWT claim, session, default.
 *
 * Pure function — no DB calls. Returns the context to be set.
 */
export function extractCompanyFromRequest(
  headers: Record<string, string | undefined>,
  jwtClaims?: Record<string, unknown>,
  sessionCompanyId?: string,
  defaultCompanyId?: string,
): CompanyRequestContext | null {
  // 1. Explicit header
  const headerValue = headers["x-company-id"];
  if (headerValue && typeof headerValue === "string" && headerValue.trim()) {
    return { company_id: headerValue.trim(), source: "header" };
  }

  // 2. JWT claim
  if (jwtClaims?.company_id && typeof jwtClaims.company_id === "string") {
    return { company_id: jwtClaims.company_id, source: "jwt" };
  }

  // 3. Session (e.g., from company switcher)
  if (sessionCompanyId) {
    return { company_id: sessionCompanyId, source: "session" };
  }

  // 4. Default fallback
  if (defaultCompanyId) {
    return { company_id: defaultCompanyId, source: "default" };
  }

  return null;
}

/**
 * Validate that a company ID is a valid UUID format.
 * Does NOT check DB — use validateCompanyAccess for that.
 */
export function isValidCompanyId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ── Isolation Verification ──────────────────────────────────

/**
 * Verify that a table is properly isolated for a company.
 * Checks that the table has a company_id column and RLS is enabled.
 *
 * Returns check result with any errors found.
 */
export async function verifyTableIsolation(
  table: CompanyScopedTable,
): Promise<IsolationCheckResult> {
  const errors: string[] = [];

  // Check for company_id column
  const [column] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = ${table} AND column_name = 'company_id'
    ) AS exists
  `;

  if (!column?.exists) {
    errors.push(`Table ${table} missing company_id column`);
  }

  // Check RLS is enabled
  const [rls] = await sql<{ rowsecurity: boolean }[]>`
    SELECT relrowsecurity AS rowsecurity
    FROM pg_class
    WHERE relname = ${table}
  `;

  if (!rls?.rowsecurity) {
    errors.push(`Table ${table} does not have RLS enabled`);
  }

  return {
    isolated: errors.length === 0,
    company_id: null,
    errors,
  };
}

/**
 * Run a full isolation audit across all company-scoped tables.
 * Returns a summary of which tables are properly isolated.
 */
export async function auditIsolation(): Promise<{
  all_isolated: boolean;
  tables: Record<string, IsolationCheckResult>;
}> {
  const results: Record<string, IsolationCheckResult> = {};
  let allIsolated = true;

  for (const table of COMPANY_SCOPED_TABLES) {
    const result = await verifyTableIsolation(table);
    results[table] = result;
    if (!result.isolated) allIsolated = false;
  }

  return { all_isolated: allIsolated, tables: results };
}

/**
 * Verify cross-company isolation: query a table with one company
 * context and confirm records from another company are not visible.
 *
 * This is a test helper — not for production use.
 */
export async function _testCrossCompanyIsolation(
  table: CompanyScopedTable,
  companyA: string,
  companyB: string,
): Promise<{ isolated: boolean; leaked_count: number }> {
  // Set context to company A
  await setCompanyContext(companyA);

  // Count records from company B visible under company A's context.
  // Use switch/case to avoid sql(table) dynamic identifier call.
  let countResult: { count: number }[];
  switch (table) {
    case "agents":
      countResult = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM agents WHERE company_id = ${companyB}::uuid`;
      break;
    case "formation_sessions":
      countResult = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM formation_sessions WHERE company_id = ${companyB}::uuid`;
      break;
    case "work_sessions":
      countResult = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM work_sessions WHERE company_id = ${companyB}::uuid`;
      break;
    case "agent_budgets":
      countResult = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM agent_budgets WHERE company_id = ${companyB}::uuid`;
      break;
    case "agent_audit_log":
      countResult = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM agent_audit_log WHERE company_id = ${companyB}::uuid`;
      break;
    case "agent_delegations":
      countResult = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM agent_delegations WHERE company_id = ${companyB}::uuid`;
      break;
    default:
      countResult = [{ count: 0 }];
  }

  // Clear context
  await clearCompanyContext();

  const leakedCount = countResult[0]?.count ?? 0;
  return {
    isolated: leakedCount === 0,
    leaked_count: leakedCount,
  };
}

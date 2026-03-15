/**
 * Company Scoping — ELLIE-724
 *
 * CRUD operations for companies and company-scoped queries.
 * Foundation for multi-tenancy data isolation.
 *
 * Database functions module — uses postgres.js via ellie-forest.
 */

import { sql } from "../../ellie-forest/src/index";
import type {
  Company,
  CompanyStatus,
  CreateCompanyInput,
  UpdateCompanyInput,
} from "./types/company";
import { DEFAULT_COMPANY_ID } from "./types/company";

// ── CRUD ────────────────────────────────────────────────────

/**
 * Create a new company.
 */
export async function createCompany(input: CreateCompanyInput): Promise<Company> {
  const [company] = await sql<Company[]>`
    INSERT INTO companies (name, slug, status, metadata)
    VALUES (
      ${input.name},
      ${input.slug},
      ${input.status ?? "active"},
      ${sql.json(input.metadata ?? {})}
    )
    RETURNING *
  `;

  return company;
}

/**
 * Get a company by ID.
 */
export async function getCompany(companyId: string): Promise<Company | null> {
  const [company] = await sql<Company[]>`
    SELECT * FROM companies WHERE id = ${companyId}::uuid
  `;
  return company ?? null;
}

/**
 * Get a company by slug.
 */
export async function getCompanyBySlug(slug: string): Promise<Company | null> {
  const [company] = await sql<Company[]>`
    SELECT * FROM companies WHERE slug = ${slug}
  `;
  return company ?? null;
}

/**
 * List all companies, optionally filtering by status.
 */
export async function listCompanies(
  opts: { status?: CompanyStatus } = {},
): Promise<Company[]> {
  if (opts.status) {
    return sql<Company[]>`
      SELECT * FROM companies
      WHERE status = ${opts.status}
      ORDER BY name ASC
    `;
  }
  return sql<Company[]>`
    SELECT * FROM companies
    ORDER BY name ASC
  `;
}

/**
 * Update a company.
 */
export async function updateCompany(
  companyId: string,
  input: UpdateCompanyInput,
): Promise<Company | null> {
  const sets: string[] = [];
  const current = await getCompany(companyId);
  if (!current) return null;

  const [company] = await sql<Company[]>`
    UPDATE companies
    SET
      name = ${input.name ?? current.name},
      slug = ${input.slug ?? current.slug},
      status = ${input.status ?? current.status},
      metadata = ${sql.json(input.metadata ?? current.metadata)},
      updated_at = NOW()
    WHERE id = ${companyId}::uuid
    RETURNING *
  `;

  return company ?? null;
}

/**
 * Archive a company (soft delete).
 */
export async function archiveCompany(companyId: string): Promise<Company | null> {
  const [company] = await sql<Company[]>`
    UPDATE companies
    SET status = 'archived', updated_at = NOW()
    WHERE id = ${companyId}::uuid
    RETURNING *
  `;
  return company ?? null;
}

// ── Company-Scoped Queries ──────────────────────────────────

/**
 * Get agents belonging to a company.
 */
export async function getAgentsByCompany(companyId: string): Promise<{ id: string; name: string; type: string; status: string }[]> {
  return sql<{ id: string; name: string; type: string; status: string }[]>`
    SELECT id, name, type, status FROM agents
    WHERE company_id = ${companyId}::uuid
    ORDER BY name ASC
  `;
}

/**
 * Get formation sessions belonging to a company.
 */
export async function getFormationSessionsByCompany(
  companyId: string,
  opts: { state?: string; limit?: number } = {},
): Promise<{ id: string; formation_name: string; state: string; created_at: Date }[]> {
  const limit = opts.limit ?? 50;

  if (opts.state) {
    return sql<{ id: string; formation_name: string; state: string; created_at: Date }[]>`
      SELECT id, formation_name, state, created_at FROM formation_sessions
      WHERE company_id = ${companyId}::uuid AND state = ${opts.state}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  }

  return sql<{ id: string; formation_name: string; state: string; created_at: Date }[]>`
    SELECT id, formation_name, state, created_at FROM formation_sessions
    WHERE company_id = ${companyId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

/**
 * Get the default company (Dave's existing data).
 */
export async function getDefaultCompany(): Promise<Company | null> {
  return getCompany(DEFAULT_COMPANY_ID);
}

/**
 * Assign an entity to a company. Works on any table with a company_id column.
 * Used for backfilling or transferring ownership.
 */
export async function assignToCompany(
  table: "agents" | "formation_sessions" | "work_sessions" | "agent_budgets",
  entityId: string,
  companyId: string,
): Promise<boolean> {
  // Validate table name to prevent SQL injection (only allow known tables)
  const validTables = ["agents", "formation_sessions", "work_sessions", "agent_budgets"];
  if (!validTables.includes(table)) {
    throw new Error(`Invalid table for company assignment: ${table}`);
  }

  // Use separate queries per table since postgres.js doesn't support
  // dynamic table names in tagged templates
  let rows: { id?: string; agent_id?: string }[];

  switch (table) {
    case "agents":
      rows = await sql`
        UPDATE agents SET company_id = ${companyId}::uuid WHERE id = ${entityId}::uuid RETURNING id
      `;
      break;
    case "formation_sessions":
      rows = await sql`
        UPDATE formation_sessions SET company_id = ${companyId}::uuid WHERE id = ${entityId}::uuid RETURNING id
      `;
      break;
    case "work_sessions":
      rows = await sql`
        UPDATE work_sessions SET company_id = ${companyId}::uuid WHERE id = ${entityId}::uuid RETURNING id
      `;
      break;
    case "agent_budgets":
      rows = await sql`
        UPDATE agent_budgets SET company_id = ${companyId}::uuid WHERE agent_id = ${entityId}::uuid RETURNING agent_id
      `;
      break;
    default:
      return false;
  }

  return rows.length > 0;
}

/**
 * OS Auth — Product Memberships
 *
 * Read/write helpers for os_product_memberships.
 * Products call these to manage roles and entitlements.
 */

import type { Sql } from "postgres"
import type { OsProductMembership } from "./schema"

/** Get all active memberships for an account. */
export async function getAccountMemberships(
  sql: Sql,
  accountId: string,
): Promise<OsProductMembership[]> {
  return sql<OsProductMembership[]>`
    SELECT * FROM os_product_memberships
    WHERE account_id = ${accountId} AND status = 'active'
    ORDER BY product
  `
}

/** Get membership for a specific account + product (+ optional org). */
export async function getMembership(
  sql: Sql,
  accountId: string,
  product: string,
  orgId?: string | null,
): Promise<OsProductMembership | null> {
  const [row] = orgId
    ? await sql<OsProductMembership[]>`
        SELECT * FROM os_product_memberships
        WHERE account_id = ${accountId} AND product = ${product} AND org_id = ${orgId}
      `
    : await sql<OsProductMembership[]>`
        SELECT * FROM os_product_memberships
        WHERE account_id = ${accountId} AND product = ${product} AND org_id IS NULL
      `
  return row ?? null
}

/** Create or update a product membership. */
export async function upsertMembership(
  sql: Sql,
  input: {
    accountId: string
    product: string
    roles: string[]
    entitlements?: Record<string, unknown>
    orgId?: string | null
  },
): Promise<OsProductMembership> {
  const nullableOrgId = input.orgId ?? null

  const [row] = await sql<OsProductMembership[]>`
    INSERT INTO os_product_memberships (account_id, product, roles, entitlements, org_id)
    VALUES (${input.accountId}, ${input.product}, ${sql.array(input.roles)},
            ${JSON.stringify(input.entitlements ?? {})}, ${nullableOrgId})
    ON CONFLICT (account_id, product, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'))
    DO UPDATE SET
      roles = EXCLUDED.roles,
      entitlements = EXCLUDED.entitlements,
      status = 'active',
      updated_at = now()
    RETURNING *
  `
  return row
}

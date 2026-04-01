/**
 * OS Auth — Type Definitions
 *
 * Mirrors the os_* tables in Forest DB.
 * Used by all os-auth modules for type safety.
 */

export interface OsAccount {
  id: string
  email: string
  email_verified: boolean
  entity_type: 'user' | 'minor' | 'org_service_account'
  display_name: string | null
  password_hash: string | null
  mfa_enabled: boolean
  mfa_secret: string | null
  status: 'active' | 'suspended' | 'pending_verification' | 'deleted'
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export interface OsAuthMethod {
  id: string
  account_id: string
  method: 'email_password' | 'magic_link' | 'oauth_google' | 'oauth_apple' | 'oauth_microsoft'
  provider_uid: string | null
  metadata: Record<string, unknown>
  created_at: Date
}

export interface OsSession {
  id: string
  account_id: string
  refresh_token: string
  token_family: string
  audience: string[]
  ip_address: string | null
  user_agent: string | null
  expires_at: Date
  revoked_at: Date | null
  created_at: Date
}

export interface OsProductMembership {
  id: string
  account_id: string
  product: string
  roles: string[]
  entitlements: Record<string, unknown>
  org_id: string | null
  status: 'active' | 'suspended' | 'revoked'
  created_at: Date
  updated_at: Date
}

export interface OsAuditEntry {
  id: string
  account_id: string | null
  event_type: string
  product: string | null
  ip_address: string | null
  user_agent: string | null
  metadata: Record<string, unknown>
  created_at: Date
}

/** JWT access token payload — what products decode from the token */
export interface OsAccessTokenPayload {
  sub: string          // account ID
  aud: string          // target product ('life', 'learn')
  iss: 'ellie-os'
  iat: number
  exp: number
  email: string
  entity_type: OsAccount['entity_type']
  memberships: Record<string, {
    roles: string[]
    entitlements: Record<string, unknown>
    org_id?: string
  }>
}

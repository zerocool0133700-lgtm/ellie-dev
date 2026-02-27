/**
 * Credential Vault — AES-256-GCM encrypted credential storage
 *
 * ELLIE-32: Secure credential vault for authenticated site access.
 * Master key from VAULT_MASTER_KEY env var (64 hex chars = 32 bytes).
 * Credentials are encrypted before storage and decrypted on retrieval.
 * Plaintext credentials must NEVER appear in logs.
 */

import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// TYPES
// ============================================================

export type CredentialType =
  | "password"
  | "api_key"
  | "bearer_token"
  | "cookie"
  | "oauth";

export interface PasswordPayload {
  username: string;
  password: string;
}
export interface ApiKeyPayload {
  key: string;
}
export interface BearerTokenPayload {
  token: string;
}
export interface CookiePayload {
  cookie: string;
}
export interface OAuthPayload {
  client_id: string;
  client_secret: string;
  refresh_token?: string;
  access_token?: string;
}

export type CredentialPayload =
  | PasswordPayload
  | ApiKeyPayload
  | BearerTokenPayload
  | CookiePayload
  | OAuthPayload;

export interface CredentialRecord {
  id: string;
  label: string;
  domain: string;
  credential_type: CredentialType;
  notes: string | null;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// Columns returned in list/get queries (never includes encrypted_data)
const SAFE_COLUMNS =
  "id, label, domain, credential_type, notes, last_used_at, expires_at, created_at, updated_at";

// ============================================================
// KEY MANAGEMENT
// ============================================================

function getMasterKey(): Buffer {
  const hex = process.env.VAULT_MASTER_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "VAULT_MASTER_KEY must be set as a 64-character hex string (32 bytes)",
    );
  }
  return Buffer.from(hex, "hex");
}

// ============================================================
// ENCRYPT / DECRYPT
// ============================================================

export function encrypt(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 128-bit integrity tag
  // Pack: iv(12) + ciphertext(N) + authTag(16)
  const combined = Buffer.concat([iv, encrypted, authTag]);
  return combined.toString("base64");
}

export function decrypt(packed: string): string {
  const key = getMasterKey();
  const combined = Buffer.from(packed, "base64");
  const iv = combined.subarray(0, 12);
  const authTag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

// ============================================================
// CRUD OPERATIONS
// ============================================================

export async function createCredential(
  supabase: SupabaseClient,
  params: {
    label: string;
    domain: string;
    credential_type: CredentialType;
    payload: CredentialPayload;
    notes?: string;
    expires_at?: string;
  },
): Promise<CredentialRecord> {
  const encrypted_data = encrypt(JSON.stringify(params.payload));

  const { data, error } = await supabase
    .from("credentials")
    .insert({
      label: params.label,
      domain: params.domain,
      credential_type: params.credential_type,
      encrypted_data,
      notes: params.notes || null,
      expires_at: params.expires_at || null,
    })
    .select(SAFE_COLUMNS)
    .single();

  if (error) throw new Error(`Failed to create credential: ${error.message}`);
  return data as CredentialRecord;
}

export async function listCredentials(
  supabase: SupabaseClient,
  filters?: { domain?: string; credential_type?: CredentialType },
): Promise<CredentialRecord[]> {
  let query = supabase
    .from("credentials")
    .select(SAFE_COLUMNS)
    .order("created_at", { ascending: false });

  if (filters?.domain) query = query.eq("domain", filters.domain);
  if (filters?.credential_type)
    query = query.eq("credential_type", filters.credential_type);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list credentials: ${error.message}`);
  return (data ?? []) as CredentialRecord[];
}

export async function getCredential(
  supabase: SupabaseClient,
  id: string,
): Promise<CredentialRecord> {
  const { data, error } = await supabase
    .from("credentials")
    .select(SAFE_COLUMNS)
    .eq("id", id)
    .single();

  if (error) throw new Error(`Failed to get credential: ${error.message}`);
  return data as CredentialRecord;
}

export async function getDecryptedPayload(
  supabase: SupabaseClient,
  id: string,
): Promise<{ record: CredentialRecord; payload: CredentialPayload }> {
  const { data, error } = await supabase
    .from("credentials")
    .select("*, encrypted_data")
    .eq("id", id)
    .single();

  if (error) throw new Error(`Failed to get credential: ${error.message}`);

  const payload = JSON.parse(decrypt(data.encrypted_data)) as CredentialPayload;

  // Update last_used_at (fire-and-forget)
  supabase
    .from("credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id)
    .then(() => {});

  const { encrypted_data: _, ...record } = data;
  return { record: record as CredentialRecord, payload };
}

export async function getCredentialForDomain(
  supabase: SupabaseClient,
  domain: string,
  type?: CredentialType,
): Promise<{ record: CredentialRecord; payload: CredentialPayload } | null> {
  let query = supabase
    .from("credentials")
    .select("*, encrypted_data")
    .eq("domain", domain)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (type) query = query.eq("credential_type", type);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to find credential: ${error.message}`);
  if (!data?.length) return null;

  const row = data[0];
  const payload = JSON.parse(decrypt(row.encrypted_data)) as CredentialPayload;

  // Update last_used_at (fire-and-forget)
  supabase
    .from("credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(() => {});

  const { encrypted_data: _, ...record } = row;
  return { record: record as CredentialRecord, payload };
}

export async function updateCredential(
  supabase: SupabaseClient,
  id: string,
  updates: {
    label?: string;
    domain?: string;
    credential_type?: CredentialType;
    payload?: CredentialPayload;
    notes?: string;
    expires_at?: string | null;
  },
): Promise<CredentialRecord> {
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (updates.label !== undefined) updateData.label = updates.label;
  if (updates.domain !== undefined) updateData.domain = updates.domain;
  if (updates.credential_type !== undefined)
    updateData.credential_type = updates.credential_type;
  if (updates.notes !== undefined) updateData.notes = updates.notes;
  if (updates.expires_at !== undefined) updateData.expires_at = updates.expires_at;
  if (updates.payload !== undefined) {
    updateData.encrypted_data = encrypt(JSON.stringify(updates.payload));
  }

  const { data, error } = await supabase
    .from("credentials")
    .update(updateData)
    .eq("id", id)
    .select(SAFE_COLUMNS)
    .single();

  if (error) throw new Error(`Failed to update credential: ${error.message}`);
  return data as CredentialRecord;
}

export async function deleteCredential(
  supabase: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await supabase.from("credentials").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete credential: ${error.message}`);
}

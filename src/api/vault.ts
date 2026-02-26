/**
 * Vault API Endpoints — ELLIE-253 Unified via The Hollow
 *
 * All credential operations now go through The Hollow (Forest DB).
 * API shape preserved for backward compatibility with dashboard.
 *
 * ELLIE-32: Original implementation.
 * ELLIE-253: Rewritten to use Hollow instead of Supabase credentials table.
 */

import { log } from "../logger.ts";
import {
  storeCredential, getCredentialByDomain, getCredentialById,
  listCredentials, updateCredential, deleteCredential,
  listAllEntries,
  type CredentialType, type HollowEntry,
} from "../../../ellie-forest/src/hollow";

const logger = log.child("vault");

// Dave's keychain — single user system
const KEYCHAIN_ID = '568c0a6a-0c98-4784-87f3-d909139d8c35';

// Map HollowEntry to the old Credential shape for API compatibility
function toCredentialRecord(entry: HollowEntry) {
  return {
    id: entry.id,
    label: entry.label,
    domain: entry.domain || '',
    credential_type: entry.credential_type || 'api_key',
    notes: entry.notes,
    last_used_at: entry.last_used_at,
    expires_at: entry.expires_at,
    created_at: entry.created_at,
    updated_at: entry.created_at,  // Hollow doesn't have updated_at separately
  };
}

// ============================================================
// CRUD ENDPOINTS
// ============================================================

/**
 * POST /api/vault/credentials
 * Body: { label, domain, credential_type, payload, notes?, expires_at? }
 */
export async function createVaultCredential(req: any, res: any, _supabase: any) {
  try {
    const { label, domain, credential_type, payload, notes, expires_at } = req.body;

    if (!label || !domain || !credential_type || !payload) {
      return res.status(400).json({ error: "Missing required fields: label, domain, credential_type, payload" });
    }

    const entry = await storeCredential(KEYCHAIN_ID, {
      label: normalizeLabel(label),
      domain,
      credential_type: credential_type as CredentialType,
      value: JSON.stringify(payload),
      notes,
      expires_at: expires_at ? new Date(expires_at) : undefined,
    });

    console.log(`[vault] Created credential "${label}" for ${domain}`);
    return res.json(toCredentialRecord(entry));
  } catch (err: any) {
    logger.error("Create failed", err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/vault/credentials
 * Query: ?domain=x&type=y
 */
export async function listVaultCredentials(req: any, res: any, _supabase: any) {
  try {
    const entries = await listCredentials({
      domain: req.query?.domain,
      credential_type: req.query?.type as CredentialType | undefined,
    });
    return res.json(entries.map(toCredentialRecord));
  } catch (err: any) {
    logger.error("List failed", err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/vault/credentials/:id
 */
export async function getVaultCredential(req: any, res: any, _supabase: any) {
  try {
    const result = await getCredentialById(req.params.id);
    if (!result) return res.status(404).json({ error: "Credential not found" });
    return res.json(toCredentialRecord(result.entry));
  } catch (err: any) {
    logger.error("Get failed", err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * PATCH /api/vault/credentials/:id
 */
export async function updateVaultCredential(req: any, res: any, _supabase: any) {
  try {
    const updates: any = {};
    if (req.body.label !== undefined) updates.label = req.body.label;
    if (req.body.domain !== undefined) updates.domain = req.body.domain;
    if (req.body.credential_type !== undefined) updates.credential_type = req.body.credential_type;
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.expires_at !== undefined) updates.expires_at = req.body.expires_at ? new Date(req.body.expires_at) : null;
    if (req.body.payload !== undefined) updates.value = JSON.stringify(req.body.payload);

    const entry = await updateCredential(req.params.id, updates);
    console.log(`[vault] Updated credential ${req.params.id}`);
    return res.json(toCredentialRecord(entry));
  } catch (err: any) {
    logger.error("Update failed", err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * DELETE /api/vault/credentials/:id
 */
export async function deleteVaultCredential(req: any, res: any, _supabase: any) {
  try {
    await deleteCredential(req.params.id);
    console.log(`[vault] Deleted credential ${req.params.id}`);
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("Delete failed", err);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
// INTERNAL ENDPOINTS (localhost only)
// ============================================================

/**
 * POST /api/vault/resolve
 * Body: { domain: "github.com", type?: "api_key" } or { id: "uuid" }
 * Returns decrypted credential payload. Internal use only.
 */
export async function resolveVaultCredential(req: any, res: any, _supabase: any) {
  try {
    const { domain, type, id } = req.body;

    if (!domain && !id) {
      return res.status(400).json({ error: "Provide domain or id" });
    }

    let result;
    if (id) {
      result = await getCredentialById(id);
    } else {
      result = await getCredentialByDomain(domain, type as CredentialType | undefined);
    }

    if (!result) {
      return res.status(404).json({ error: `No credential found for ${domain || id}` });
    }

    return res.json({
      record: toCredentialRecord(result.entry),
      payload: result.payload,
    });
  } catch (err: any) {
    logger.error("Resolve failed", err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/vault/fetch
 * Authenticated fetch with credential injection.
 */
export async function authenticatedFetch(req: any, res: any, _supabase: any) {
  try {
    const { url, method = "GET", headers = {}, body } = req.body;

    if (!url) {
      return res.status(400).json({ error: "url is required" });
    }

    let targetUrl: URL;
    try {
      targetUrl = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    const domain = targetUrl.hostname;
    const fetchHeaders: Record<string, string> = { ...headers };

    const cred = await getCredentialByDomain(domain);
    if (!cred) {
      return res.status(404).json({ error: `No credentials found for domain: ${domain}` });
    }

    switch (cred.entry.credential_type) {
      case "bearer_token":
        fetchHeaders["Authorization"] = `Bearer ${(cred.payload as any).token}`;
        break;
      case "api_key":
        fetchHeaders["Authorization"] = `Bearer ${(cred.payload as any).key}`;
        break;
      case "cookie":
        fetchHeaders["Cookie"] = (cred.payload as any).cookie;
        break;
      case "oauth":
        if ((cred.payload as any).access_token) {
          fetchHeaders["Authorization"] = `Bearer ${(cred.payload as any).access_token}`;
        }
        break;
      case "password": {
        try {
          const { getAuthenticatedSession } = await import("../browser-auth.ts");
          const session = await getAuthenticatedSession(null, domain);
          if (session) {
            fetchHeaders["Cookie"] = session.cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
          }
        } catch (err) {
          logger.error("Browser auth failed", err);
        }
        break;
      }
    }

    console.log(`[vault] Authenticated fetch: ${method} ${domain}${targetUrl.pathname}`);

    const response = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body || undefined,
    });

    const contentType = response.headers.get("content-type") || "";
    let responseBody;
    if (contentType.includes("application/json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    return res.json({
      status: response.status,
      statusText: response.statusText,
      contentType,
      body: responseBody,
    });
  } catch (err: any) {
    logger.error("Fetch failed", err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Normalize a label to hollow convention (snake_case).
 */
function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

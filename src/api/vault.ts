/**
 * Vault API Endpoints
 *
 * ELLIE-32: Credential CRUD + domain lookup + authenticated fetch.
 * All responses strip encrypted_data except /resolve (internal only).
 * Credentials are NEVER logged in plaintext.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createCredential,
  listCredentials,
  getCredential,
  getDecryptedPayload,
  getCredentialForDomain,
  updateCredential,
  deleteCredential,
  type CredentialType,
  type CredentialPayload,
} from "../vault.ts";

// ============================================================
// CRUD ENDPOINTS
// ============================================================

/**
 * POST /api/vault/credentials
 * Body: { label, domain, credential_type, payload, notes?, expires_at? }
 */
export async function createVaultCredential(
  req: any,
  res: any,
  supabase: SupabaseClient,
) {
  try {
    const { label, domain, credential_type, payload, notes, expires_at } =
      req.body;

    if (!label || !domain || !credential_type || !payload) {
      return res
        .status(400)
        .json({ error: "Missing required fields: label, domain, credential_type, payload" });
    }

    const validTypes = ["password", "api_key", "bearer_token", "cookie", "oauth"];
    if (!validTypes.includes(credential_type)) {
      return res
        .status(400)
        .json({ error: `Invalid credential_type. Must be one of: ${validTypes.join(", ")}` });
    }

    const record = await createCredential(supabase, {
      label,
      domain,
      credential_type: credential_type as CredentialType,
      payload: payload as CredentialPayload,
      notes,
      expires_at,
    });

    console.log(`[vault] Created credential "${label}" for ${domain}`);
    return res.json(record);
  } catch (err: any) {
    console.error("[vault] Create error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/vault/credentials
 * Query: ?domain=x&type=y
 */
export async function listVaultCredentials(
  req: any,
  res: any,
  supabase: SupabaseClient,
) {
  try {
    const records = await listCredentials(supabase, {
      domain: req.query?.domain,
      credential_type: req.query?.type as CredentialType | undefined,
    });
    return res.json(records);
  } catch (err: any) {
    console.error("[vault] List error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/vault/credentials/:id
 */
export async function getVaultCredential(
  req: any,
  res: any,
  supabase: SupabaseClient,
) {
  try {
    const record = await getCredential(supabase, req.params.id);
    return res.json(record);
  } catch (err: any) {
    console.error("[vault] Get error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * PATCH /api/vault/credentials/:id
 * Body: { label?, domain?, credential_type?, payload?, notes?, expires_at? }
 */
export async function updateVaultCredential(
  req: any,
  res: any,
  supabase: SupabaseClient,
) {
  try {
    const record = await updateCredential(supabase, req.params.id, req.body);
    console.log(`[vault] Updated credential ${req.params.id}`);
    return res.json(record);
  } catch (err: any) {
    console.error("[vault] Update error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * DELETE /api/vault/credentials/:id
 */
export async function deleteVaultCredential(
  req: any,
  res: any,
  supabase: SupabaseClient,
) {
  try {
    await deleteCredential(supabase, req.params.id);
    console.log(`[vault] Deleted credential ${req.params.id}`);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[vault] Delete error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ============================================================
// INTERNAL ENDPOINTS (localhost only)
// ============================================================

/**
 * POST /api/vault/resolve
 * Body: { domain: "github.com", type?: "api_key" }
 * Returns decrypted credential payload. Internal use only.
 */
export async function resolveVaultCredential(
  req: any,
  res: any,
  supabase: SupabaseClient,
) {
  try {
    const { domain, type, id } = req.body;

    if (!domain && !id) {
      return res.status(400).json({ error: "Provide domain or id" });
    }

    let result;
    if (id) {
      result = await getDecryptedPayload(supabase, id);
    } else {
      result = await getCredentialForDomain(
        supabase,
        domain,
        type as CredentialType | undefined,
      );
    }

    if (!result) {
      return res
        .status(404)
        .json({ error: `No credential found for domain: ${domain}` });
    }

    return res.json({
      record: result.record,
      payload: result.payload,
    });
  } catch (err: any) {
    console.error("[vault] Resolve error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/vault/fetch
 * Body: { url, method?, headers?, body? }
 * Looks up credentials for the URL's domain, injects auth, returns response.
 * Credentials never appear in the response — only the fetched content.
 */
export async function authenticatedFetch(
  req: any,
  res: any,
  supabase: SupabaseClient,
) {
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

    // Try API-based auth (bearer_token, api_key, cookie types)
    const cred = await getCredentialForDomain(supabase, domain);
    if (cred) {
      switch (cred.record.credential_type) {
        case "bearer_token":
          fetchHeaders["Authorization"] =
            `Bearer ${(cred.payload as any).token}`;
          break;
        case "api_key":
          fetchHeaders["Authorization"] =
            `Bearer ${(cred.payload as any).key}`;
          break;
        case "cookie":
          fetchHeaders["Cookie"] = (cred.payload as any).cookie;
          break;
        case "oauth":
          if ((cred.payload as any).access_token) {
            fetchHeaders["Authorization"] =
              `Bearer ${(cred.payload as any).access_token}`;
          }
          break;
        case "password": {
          // For password credentials, try browser auth
          try {
            const { getAuthenticatedSession } = await import(
              "../browser-auth.ts"
            );
            const session = await getAuthenticatedSession(supabase, domain);
            if (session) {
              fetchHeaders["Cookie"] = session.cookies
                .map((c: any) => `${c.name}=${c.value}`)
                .join("; ");
            }
          } catch (err) {
            console.error("[vault] Browser auth failed:", (err as Error).message);
          }
          break;
        }
      }
    }

    if (!cred) {
      return res
        .status(404)
        .json({ error: `No credentials found for domain: ${domain}` });
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
    console.error("[vault] Fetch error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Browser Authentication Helper
 *
 * Uses stored vault credentials to authenticate via Playwright headless browser,
 * then returns the resulting cookies for authenticated requests.
 *
 * ELLIE-32: Credentials are fetched from vault, never logged.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getCredentialForDomain,
  type PasswordPayload,
} from "./vault.ts";

export interface AuthResult {
  cookies: any[];
  source: "cache" | "fresh_login";
}

/**
 * Get authenticated browser cookies for a domain.
 *
 * 1. Fetch password credential from vault
 * 2. Launch headless Playwright browser
 * 3. Navigate to login page, fill credentials, submit
 * 4. Extract and return cookies
 */
export async function getAuthenticatedSession(
  supabase: SupabaseClient,
  domain: string,
  options?: {
    loginUrl?: string;
    usernameSelector?: string;
    passwordSelector?: string;
    submitSelector?: string;
    successIndicator?: string;
    timeout?: number;
  },
): Promise<AuthResult | null> {
  // Get credential from vault
  const cred = await getCredentialForDomain(supabase, domain, "password");
  if (!cred) return null;

  const payload = cred.payload as PasswordPayload;

  // Dynamic import — Playwright only loaded when needed
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const timeoutMs = options?.timeout ?? 15000;

  try {
    const loginUrl =
      options?.loginUrl || `https://${domain}/login`;
    await page.goto(loginUrl, { timeout: timeoutMs });

    // Fill credentials
    const usernameSelector =
      options?.usernameSelector ||
      'input[name="username"], input[name="email"], input[type="email"]';
    const passwordSelector =
      options?.passwordSelector || 'input[name="password"], input[type="password"]';
    const submitSelector =
      options?.submitSelector ||
      'button[type="submit"], input[type="submit"]';

    await page.fill(usernameSelector, payload.username);
    await page.fill(passwordSelector, payload.password);
    await page.click(submitSelector);

    // Wait for login to complete
    if (options?.successIndicator) {
      await page.waitForSelector(options.successIndicator, {
        timeout: timeoutMs,
      });
    } else {
      await page.waitForLoadState("networkidle", { timeout: timeoutMs });
    }

    // Extract cookies
    const cookies = await context.cookies();
    console.log(
      `[browser-auth] Login successful for ${domain}, got ${cookies.length} cookies`,
    );

    return { cookies, source: "fresh_login" };
  } catch (err) {
    console.error(
      `[browser-auth] Login failed for ${domain}:`,
      (err as Error).message,
    );
    return null;
  } finally {
    await browser.close();
  }
}

/**
 * Get HTTP authorization headers for API-based credentials.
 * Returns appropriate headers based on credential type.
 */
export async function getAuthHeaders(
  supabase: SupabaseClient,
  domain: string,
  type?: "api_key" | "bearer_token",
): Promise<Record<string, string> | null> {
  const cred = await getCredentialForDomain(supabase, domain, type);
  if (!cred) return null;

  switch (cred.record.credential_type) {
    case "bearer_token":
      return { Authorization: `Bearer ${(cred.payload as any).token}` };
    case "api_key":
      return { Authorization: `Bearer ${(cred.payload as any).key}` };
    case "cookie":
      return { Cookie: (cred.payload as any).cookie };
    default:
      return null;
  }
}

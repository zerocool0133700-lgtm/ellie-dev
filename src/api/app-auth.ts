/**
 * App Auth API — ELLIE-176
 *
 * Conversational onboarding auth for the Ellie phone app.
 * Opaque session tokens, email verification codes, no signup forms.
 *
 * Endpoints:
 *   POST /api/app-auth/send-code    — generate + email a 6-digit code
 *   POST /api/app-auth/verify-code  — verify code, create/upgrade user, return session token
 *   GET  /api/app-auth/me           — return current user by session token
 *   POST /api/app-auth/update-profile — update name, timezone, preferences
 */

import type { ApiRequest, ApiResponse } from "./types.ts"
import { randomBytes } from 'crypto'
import { sql } from '../../../ellie-forest/src/index'
import { createPerson } from '../../../ellie-forest/src/people'
import { sendVerificationCode } from '../email'
import { log } from "../logger.ts";

const logger = log.child("app-auth");

// ── Types ────────────────────────────────────────────────────

interface AppUser {
  id: string
  email: string | null
  name: string | null
  timezone: string | null
  preferences: Record<string, unknown>
  onboarding_state: string
  person_id: string | null
  anonymous_id: string | null
  session_token: string | null
  created_at: Date
  verified_at: Date | null
  last_seen_at: Date | null
}

// ── Helpers ──────────────────────────────────────────────────

function generateCode(): string {
  // 6-digit numeric code
  return String(Math.floor(100000 + Math.random() * 900000))
}

function generateToken(): string {
  return 'ess_' + randomBytes(32).toString('hex')
}

function extractToken(req: ApiRequest & { headers?: Record<string, string> }): string | null {
  const auth = req.headers?.authorization || req.headers?.Authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7)
  return null
}

async function getUserByToken(token: string): Promise<AppUser | null> {
  if (!token) return null
  const [user] = await sql<AppUser[]>`
    SELECT * FROM app_users WHERE session_token = ${token}
  `
  return user || null
}

// ── POST /api/app-auth/send-code ─────────────────────────────

export async function sendCodeEndpoint(req: ApiRequest, res: ApiResponse) {
  try {
    const { email } = req.body
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' })
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Rate limit: max 3 active (unused, unexpired) codes per email
    const [activeCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*) as count FROM verification_codes
      WHERE email = ${normalizedEmail} AND used = FALSE AND expires_at > NOW()
    `
    if (parseInt(activeCount.count) >= 3) {
      return res.status(429).json({ error: 'Too many active codes. Please wait a few minutes.' })
    }

    const code = generateCode()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes

    await sql`
      INSERT INTO verification_codes (email, code, expires_at)
      VALUES (${normalizedEmail}, ${code}, ${expiresAt})
    `

    const sent = await sendVerificationCode(normalizedEmail, code)
    if (!sent) {
      // Email not configured yet — code is in DB, log it for manual testing
      console.log(`[app-auth] Email delivery unavailable — code for ${normalizedEmail}: ${code}`)
    }

    console.log(`[app-auth] Code sent to ${normalizedEmail}`)
    return res.json({ ok: true })
  } catch (error) {
    logger.error("Send code failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── POST /api/app-auth/verify-code ───────────────────────────

export async function verifyCodeEndpoint(req: ApiRequest, res: ApiResponse) {
  try {
    const { email, code, name, anonymous_id } = req.body
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' })
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Find matching code
    const [codeRow] = await sql<{ id: string; attempts: number }[]>`
      SELECT id, attempts FROM verification_codes
      WHERE email = ${normalizedEmail} AND code = ${code}
        AND used = FALSE AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1
    `

    if (!codeRow) {
      // Increment attempts on the most recent code for this email
      await sql`
        UPDATE verification_codes SET attempts = attempts + 1
        WHERE email = ${normalizedEmail} AND used = FALSE AND expires_at > NOW()
      `
      return res.status(401).json({ error: 'Invalid or expired code' })
    }

    if (codeRow.attempts >= 5) {
      return res.status(429).json({ error: 'Too many attempts. Request a new code.' })
    }

    // Mark code as used
    await sql`UPDATE verification_codes SET used = TRUE WHERE id = ${codeRow.id}`

    // Check if user already exists
    let [user] = await sql<AppUser[]>`
      SELECT * FROM app_users WHERE email = ${normalizedEmail}
    `

    const token = generateToken()

    if (user) {
      // Existing user — update session token + merge anonymous data
      await sql`
        UPDATE app_users SET
          session_token = ${token},
          name = COALESCE(${name || null}, name),
          onboarding_state = CASE
            WHEN onboarding_state IN ('anonymous', 'named', 'email_sent') THEN 'verified'
            ELSE onboarding_state
          END,
          verified_at = COALESCE(verified_at, NOW()),
          last_seen_at = NOW()
          ${anonymous_id ? sql`, anonymous_id = COALESCE(anonymous_id, ${anonymous_id})` : sql``}
        WHERE id = ${user.id}
      `
    } else {
      // New user — create account + person record
      let personId: string | null = null
      if (name) {
        try {
          const person = await createPerson({
            name,
            relationship_type: 'app-user',
            contact_methods: { email: normalizedEmail },
          })
          personId = person.id
        } catch (err) {
          logger.error("Failed to create person", err)
        }
      }

      const [newUser] = await sql<AppUser[]>`
        INSERT INTO app_users (email, name, session_token, onboarding_state, verified_at, person_id, anonymous_id)
        VALUES (${normalizedEmail}, ${name || null}, ${token}, 'verified', NOW(), ${personId}, ${anonymous_id || null})
        RETURNING *
      `
      user = newUser
    }

    // Refetch user with updated token
    const [updatedUser] = await sql<AppUser[]>`
      SELECT * FROM app_users WHERE session_token = ${token}
    `

    console.log(`[app-auth] User verified: ${normalizedEmail} (${updatedUser.id})`)
    return res.json({
      ok: true,
      token,
      user: {
        id: updatedUser.id,
        name: updatedUser.name,
        email: updatedUser.email,
        onboarding_state: updatedUser.onboarding_state,
        timezone: updatedUser.timezone,
        preferences: updatedUser.preferences,
      },
    })
  } catch (error) {
    logger.error("Verify code failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── GET /api/app-auth/me ─────────────────────────────────────

export async function meEndpoint(req: ApiRequest, res: ApiResponse) {
  try {
    const token = extractToken(req)
    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization header' })
    }

    const user = await getUserByToken(token)
    if (!user) {
      return res.status(401).json({ error: 'Invalid session' })
    }

    // Update last_seen
    sql`UPDATE app_users SET last_seen_at = NOW() WHERE id = ${user.id}`.catch(() => {})

    return res.json({
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        onboarding_state: user.onboarding_state,
        timezone: user.timezone,
        preferences: user.preferences,
      },
    })
  } catch (error) {
    logger.error("Me endpoint failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── POST /api/app-auth/update-profile ────────────────────────

export async function updateProfileEndpoint(req: ApiRequest, res: ApiResponse) {
  try {
    const token = extractToken(req)
    if (!token) {
      return res.status(401).json({ error: 'Missing Authorization header' })
    }

    const user = await getUserByToken(token)
    if (!user) {
      return res.status(401).json({ error: 'Invalid session' })
    }

    const { name, timezone, preferences } = req.body

    const updates: string[] = []
    if (name !== undefined) updates.push('name')
    if (timezone !== undefined) updates.push('timezone')
    if (preferences !== undefined) updates.push('preferences')

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    await sql`
      UPDATE app_users SET
        name = COALESCE(${name || null}, name),
        timezone = COALESCE(${timezone || null}, timezone),
        preferences = CASE
          WHEN ${preferences !== undefined} THEN ${sql.json(preferences || {})}
          ELSE preferences
        END,
        last_seen_at = NOW()
      WHERE id = ${user.id}
    `

    const [updated] = await sql<AppUser[]>`SELECT * FROM app_users WHERE id = ${user.id}`

    console.log(`[app-auth] Profile updated: ${user.id} (${updates.join(', ')})`)
    return res.json({
      ok: true,
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        onboarding_state: updated.onboarding_state,
        timezone: updated.timezone,
        preferences: updated.preferences,
      },
    })
  } catch (error) {
    logger.error("Update profile failed", error)
    return res.status(500).json({ error: 'Internal server error' })
  }
}

// ── Exported helpers for relay WS integration ────────────────

export { getUserByToken, generateToken, generateCode, AppUser }

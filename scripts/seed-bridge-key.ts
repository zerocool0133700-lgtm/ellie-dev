#!/usr/bin/env bun
/**
 * Seed Bridge API Key (ELLIE-177)
 *
 * Creates a bridge API key for an external collaborator.
 *
 * Usage:
 *   bun run scripts/seed-bridge-key.ts --name james-claude-code \
 *     --collaborator james --scopes "2" --permissions "read,write"
 *
 * The raw API key is printed once to stdout. It cannot be retrieved later.
 */

import { randomBytes, createHash } from 'crypto'
import sql from '../../ellie-forest/src/db'

const args = process.argv.slice(2)

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx >= 0 ? args[idx + 1] : undefined
}

const name = getArg('--name')
const collaborator = getArg('--collaborator')
const scopesRaw = getArg('--scopes') || ''
const permsRaw = getArg('--permissions') || 'read'

if (!name || !collaborator) {
  console.error('Usage: bun run scripts/seed-bridge-key.ts --name <label> --collaborator <person> --scopes <paths> [--permissions read,write]')
  process.exit(1)
}

const allowedScopes = scopesRaw.split(',').map(s => s.trim()).filter(Boolean)
const permissions = permsRaw.split(',').map(s => s.trim()).filter(Boolean)

if (allowedScopes.length === 0) {
  console.error('Error: --scopes is required (comma-separated scope paths)')
  process.exit(1)
}

// Generate raw key: bk_ prefix + 32 random bytes as hex
const rawKey = 'bk_' + randomBytes(32).toString('hex')
const keyHash = createHash('sha256').update(rawKey).digest('hex')
const keyPrefix = rawKey.slice(0, 11)

const [row] = await sql<{ id: string; name: string; collaborator: string; allowed_scopes: string[]; permissions: string[] }[]>`
  INSERT INTO bridge_keys (name, collaborator, key_hash, key_prefix, allowed_scopes, permissions)
  VALUES (${name}, ${collaborator}, ${keyHash}, ${keyPrefix}, ${allowedScopes}, ${permissions})
  RETURNING id, name, collaborator, allowed_scopes, permissions
`

console.log('')
console.log('Bridge API key created:')
console.log(`  ID:            ${row.id}`)
console.log(`  Name:          ${row.name}`)
console.log(`  Collaborator:  ${row.collaborator}`)
console.log(`  Scopes:        ${row.allowed_scopes.join(', ')}`)
console.log(`  Permissions:   ${row.permissions.join(', ')}`)
console.log('')
console.log('  API Key (save this — it will not be shown again):')
console.log(`  ${rawKey}`)
console.log('')
console.log('  Test:')
console.log(`  curl -s -H "x-bridge-key: ${rawKey}" http://localhost:3001/api/bridge/whoami | jq .`)
console.log('')

await sql.end()

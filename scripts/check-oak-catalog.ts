#!/usr/bin/env bun
/**
 * Check if Oak Catalog exists in R/1
 */

import sql from '../../ellie-forest/src/db.ts'

async function main() {
  const rows = await sql<Array<{
    id: string
    content: string
    type: string
    scope_path: string
    tags: string[]
    metadata: any
    created_at: Date
  }>>`
    SELECT id, LEFT(content, 200) as content, type, scope_path, tags, metadata, created_at
    FROM shared_memories
    WHERE scope_path = 'R/1'
    AND tags @> ARRAY['oak-catalog']
    ORDER BY created_at DESC
    LIMIT 1
  `

  if (rows.length === 0) {
    console.log('❌ No Oak Catalog found in R/1')
  } else {
    const oak = rows[0]
    console.log('✓ Oak Catalog found in R/1:\n')
    console.log(`ID: ${oak.id}`)
    console.log(`Type: ${oak.type}`)
    console.log(`Scope: ${oak.scope_path}`)
    console.log(`Tags: ${oak.tags.join(', ')}`)
    console.log(`Metadata:`, JSON.stringify(oak.metadata, null, 2))
    console.log(`Created: ${oak.created_at.toISOString()}`)
    console.log(`\nContent preview:\n${oak.content}...`)
  }

  await sql.end()
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})

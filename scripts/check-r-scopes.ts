#!/usr/bin/env bun
/**
 * Check if R scopes exist and create them if needed
 */

import sql from '../../ellie-forest/src/db.ts'

async function main() {
  const rows = await sql<Array<{ path: string; name: string }>>`
    SELECT path, name FROM knowledge_scopes WHERE path ~ '^R' ORDER BY path
  `

  console.log(`Found ${rows.length} R scopes:`)
  rows.forEach(r => console.log(`  ${r.path} — ${r.name}`))

  if (rows.length === 0) {
    console.log('\nNo R scopes found. Creating them now...\n')

    // Insert R scope (River root)
    const [r] = await sql<Array<{ id: string }>>`
      INSERT INTO knowledge_scopes (path, name, level, description)
      VALUES ('R', 'River', 'world', 'River knowledge vault root')
      ON CONFLICT (path) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `

    // Insert R/R (River docs)
    const [rr] = await sql<Array<{ id: string }>>`
      INSERT INTO knowledge_scopes (path, name, level, parent_id, description)
      VALUES ('R/R', 'River Docs', 'forest', ${r.id}, 'River document collection')
      ON CONFLICT (path) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `

    // Insert R/A (River agents)
    const [ra] = await sql<Array<{ id: string }>>`
      INSERT INTO knowledge_scopes (path, name, level, parent_id, description)
      VALUES ('R/A', 'River Agents', 'forest', ${r.id}, 'River agent knowledge')
      ON CONFLICT (path) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `

    // Insert R/1 (Oak Catalog)
    await sql`
      INSERT INTO knowledge_scopes (path, name, level, parent_id, description)
      VALUES ('R/1', 'Oak Catalog', 'tree', ${r.id}, 'Oak tree — River document manifest')
      ON CONFLICT (path) DO UPDATE SET name = EXCLUDED.name
    `

    console.log('✓ Created R scopes:')
    console.log('  R — River (root)')
    console.log('  R/R — River Docs')
    console.log('  R/A — River Agents')
    console.log('  R/1 — Oak Catalog')
  }

  await sql.end()
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})

#!/usr/bin/env bun
/**
 * Manually trigger Oak Catalog sync
 */

import { syncOakCatalog } from '../src/api/bridge-river.ts'

async function main() {
  console.log('Starting Oak Catalog sync...\n')

  await syncOakCatalog()

  console.log('\n✓ Oak Catalog sync complete')
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})

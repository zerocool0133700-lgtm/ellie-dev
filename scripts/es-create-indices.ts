/**
 * ES Forest — Create Indices
 *
 * Creates the 4 forest Elasticsearch indices from mapping files.
 * Idempotent: skips indices that already exist unless --force is passed.
 *
 * Usage:
 *   bun run scripts/es-create-indices.ts           # create missing indices
 *   bun run scripts/es-create-indices.ts --force    # delete and recreate all
 *   bun run scripts/es-create-indices.ts --dry-run  # show what would happen
 */

import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";

const ES_URL = process.env.ELASTICSEARCH_URL || "http://localhost:9200";
const MAPPINGS_DIR = join(import.meta.dir, "..", "elasticsearch", "mappings");

const INDICES = [
  { name: "ellie-forest-events", file: "forest-events.json" },
  { name: "ellie-forest-commits", file: "forest-commits.json" },
  { name: "ellie-forest-creatures", file: "forest-creatures.json" },
  { name: "ellie-forest-trees", file: "forest-trees.json" },
];

const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

async function indexExists(name: string): Promise<boolean> {
  const res = await fetch(`${ES_URL}/${name}`, {
    method: "HEAD",
    signal: AbortSignal.timeout(5000),
  });
  return res.ok;
}

async function deleteIndex(name: string): Promise<void> {
  const res = await fetch(`${ES_URL}/${name}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Failed to delete ${name}: ${res.status} ${text}`);
  }
}

async function createIndex(name: string, body: object): Promise<void> {
  const res = await fetch(`${ES_URL}/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create ${name}: ${res.status} ${text}`);
  }
}

async function run() {
  // Verify ES is reachable
  try {
    const res = await fetch(`${ES_URL}/_cluster/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const health = await res.json();
    console.log(`[es] Connected to cluster: ${health.cluster_name} (${health.status})\n`);
  } catch (err) {
    console.error(`[es] Cannot reach Elasticsearch at ${ES_URL}`);
    console.error("[es] Set ELASTICSEARCH_URL in .env or start ES");
    process.exit(1);
  }

  let created = 0;
  let skipped = 0;
  let recreated = 0;

  for (const { name, file } of INDICES) {
    const mappingPath = join(MAPPINGS_DIR, file);
    const mapping = JSON.parse(readFileSync(mappingPath, "utf-8"));
    const exists = await indexExists(name);

    if (exists && !force) {
      console.log(`  [skip] ${name} — already exists`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`  [dry-run] would ${exists ? "recreate" : "create"} ${name}`);
      continue;
    }

    if (exists && force) {
      console.log(`  [delete] ${name}`);
      await deleteIndex(name);
    }

    console.log(`  [create] ${name}`);
    await createIndex(name, mapping);

    if (exists) recreated++;
    else created++;
  }

  if (dryRun) {
    console.log("\n[es] Dry run complete — no changes made.");
    return;
  }

  console.log(`\n[es] Done: ${created} created, ${recreated} recreated, ${skipped} skipped`);

  // Verify all indices exist
  console.log("\n[es] Verification:");
  for (const { name } of INDICES) {
    const exists = await indexExists(name);
    const res = await fetch(`${ES_URL}/${name}/_count`, {
      signal: AbortSignal.timeout(5000),
    });
    const count = res.ok ? (await res.json()).count : "?";
    console.log(`  ${exists ? "OK" : "MISSING"} ${name} (${count} docs)`);
  }
}

run().catch((err) => {
  console.error("[es] Fatal:", err);
  process.exit(1);
});

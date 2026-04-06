/**
 * Seed Runner — Apply seed data to databases
 *
 * Usage:
 *   bun run seed                          # apply all seeds to both DBs
 *   bun run seed --db supabase            # apply to Supabase only
 *   bun run seed --db forest              # apply to Forest only
 *   bun run seed --file 001_agents.sql    # apply specific seed file
 */

import "dotenv/config";
import { getSeedFiles, getConnection, type DatabaseTarget } from "../src/migrate.ts";

const args = process.argv.slice(2);
const dbArg = args.includes("--db")
  ? (args[args.indexOf("--db") + 1] as DatabaseTarget)
  : null;
const fileArg = args.includes("--file") ? args[args.indexOf("--file") + 1] : null;

const databases: DatabaseTarget[] = dbArg ? [dbArg] : ["forest", "supabase"];

async function applySeed(db: DatabaseTarget, filename?: string) {
  console.log(`\n📦 Applying seeds to ${db}...`);

  const sql = getConnection(db);
  if (!sql) {
    console.error(`  ✗ Cannot connect to ${db} database`);
    if (db === "supabase") {
      console.error(`    DATABASE_URL environment variable not set`);
    }
    process.exit(1);
  }

  const seedFiles = await getSeedFiles(db);
  const filesToApply = filename
    ? seedFiles.filter((f) => f.filename === filename)
    : seedFiles;

  if (filesToApply.length === 0) {
    console.log(`  ⚠ No seed files found${filename ? ` matching "${filename}"` : ""}`);
    await sql.end();
    return;
  }

  try {
    for (const file of filesToApply) {
      try {
        console.log(`  ▶ ${file.filename}...`);
        await sql.unsafe(file.content);
        console.log(`  ✓ ${file.filename} applied`);
      } catch (error) {
        console.error(`  ✗ ${file.filename} failed:`, error instanceof Error ? error.message : error);
        await sql.end();
        process.exit(1);
      }
    }

    console.log(`  ✓ All seeds applied to ${db}`);
  } finally {
    await sql.end();
  }
}

for (const db of databases) {
  await applySeed(db, fileArg);
}

console.log("\n✓ Seed operation complete\n");

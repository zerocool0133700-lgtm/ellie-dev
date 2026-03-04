/**
 * SQL Migration Runner — CLI
 *
 * Usage:
 *   bun run migrate                       # apply pending to both DBs
 *   bun run migrate --db supabase         # apply to Supabase only
 *   bun run migrate --db forest           # apply to Forest only
 *   bun run migrate --dry-run             # preview without applying
 *   bun run migrate:status                # show applied vs pending
 *   bun run migrate:validate              # seed + drift checks
 */

import "dotenv/config";
import {
  migrate,
  getStatus,
  validate,
  formatMigrateResult,
  formatStatusResult,
  formatValidateResult,
  type DatabaseTarget,
} from "../src/migrate.ts";

const args = process.argv.slice(2);
const command = args[0] === "status" ? "status" : args[0] === "validate" ? "validate" : "migrate";
const dryRun = args.includes("--dry-run");
const dbArg = args.includes("--db")
  ? (args[args.indexOf("--db") + 1] as DatabaseTarget)
  : null;

const databases: DatabaseTarget[] = dbArg ? [dbArg] : ["forest", "supabase"];

let hasFailures = false;

if (command === "status") {
  for (const db of databases) {
    const result = await getStatus(db);
    console.log(formatStatusResult(result));
    if (result.totals.modified > 0) hasFailures = true;
  }
} else if (command === "validate") {
  for (const db of databases) {
    const result = await validate(db);
    console.log(formatValidateResult(result));
    if (!result.clean) hasFailures = true;
  }
} else {
  // migrate
  for (const db of databases) {
    const result = await migrate(db, { dryRun });
    console.log(formatMigrateResult(result));
    if (result.failed.length > 0) hasFailures = true;
  }
}

process.exit(hasFailures ? 1 : 0);

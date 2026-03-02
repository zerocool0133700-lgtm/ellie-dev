/**
 * Data Integrity Audit — CLI runner
 *
 * Usage:
 *   bun run audit:data-integrity
 *   bun run audit:data-integrity --days 14
 *   bun run audit:data-integrity --days 30 --verbose
 */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { runDataIntegrityAudit, formatAuditReport } from "../src/api/data-integrity-audit.ts";

const args = process.argv.slice(2);
const daysArg = args.includes("--days") ? parseInt(args[args.indexOf("--days") + 1]) : 7;
const days = isNaN(daysArg) ? 7 : Math.min(daysArg, 90);

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
);

console.log(`\nRunning data integrity audit (last ${days} days)...\n`);

const result = await runDataIntegrityAudit(supabase, { lookbackDays: days });

console.log(formatAuditReport(result));

if (!result.clean) {
  console.log("\n⚠️  Issues found. See above for details.");
  process.exit(1);
} else {
  console.log("\n✅ All clear.");
  process.exit(0);
}

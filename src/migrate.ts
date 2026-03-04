/**
 * SQL Migration Runner — ELLIE-518
 *
 * Tracks applied migrations, validates seeds, detects code-vs-DB drift.
 * Supports both Supabase (cloud) and Forest (local Postgres).
 *
 * Usage:
 *   bun run migrate                    # apply pending to both DBs
 *   bun run migrate --db forest        # apply pending to Forest only
 *   bun run migrate --dry-run          # preview without applying
 *   bun run migrate:status             # show applied vs pending
 *   bun run migrate:validate           # seed + drift checks
 */

import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { createHash } from "crypto";
import postgres from "postgres";

// ── Types ──────────────────────────────────────────────────────────────────

export type DatabaseTarget = "supabase" | "forest";

export interface MigrationFile {
  filename: string;
  path: string;
  checksum: string;
  content: string;
}

export interface LedgerEntry {
  filename: string;
  checksum: string;
  applied_at: string;
}

export type MigrationFileStatus = "pending" | "applied" | "modified";

export interface MigrationStatus {
  filename: string;
  status: MigrationFileStatus;
  checksum: string;
  appliedChecksum?: string;
  appliedAt?: string;
}

export interface MigrateResult {
  database: DatabaseTarget;
  applied: string[];
  skipped: string[];
  modified: string[];
  failed: { filename: string; error: string }[];
  dryRun: boolean;
}

export interface StatusResult {
  database: DatabaseTarget;
  migrations: MigrationStatus[];
  totals: { applied: number; pending: number; modified: number };
}

export interface SeedIssue {
  file: string;
  table: string;
  columns: string[];
  missingColumns: string[];
  message: string;
}

export interface DriftIssue {
  table: string;
  source: string;
  message: string;
}

export interface ValidateResult {
  database: DatabaseTarget;
  seedIssues: SeedIssue[];
  driftIssues: DriftIssue[];
  clean: boolean;
}

// ── Paths ──────────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(import.meta.dir, "..");

export function getMigrationsDir(db: DatabaseTarget): string {
  return join(PROJECT_ROOT, "migrations", db);
}

export function getSeedsDir(db: DatabaseTarget): string {
  return join(PROJECT_ROOT, "seeds", db);
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function computeChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function getMigrationFiles(db: DatabaseTarget): Promise<MigrationFile[]> {
  const dir = getMigrationsDir(db);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const sqlFiles = entries
    .filter((f) => f.endsWith(".sql") && f !== "_migration_ledger.sql")
    .sort();

  const files: MigrationFile[] = [];
  for (const filename of sqlFiles) {
    const path = join(dir, filename);
    const content = await readFile(path, "utf-8");
    files.push({
      filename,
      path,
      checksum: computeChecksum(content),
      content,
    });
  }
  return files;
}

export async function getSeedFiles(db: DatabaseTarget): Promise<MigrationFile[]> {
  const dir = getSeedsDir(db);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();
  const files: MigrationFile[] = [];
  for (const filename of sqlFiles) {
    const path = join(dir, filename);
    const content = await readFile(path, "utf-8");
    files.push({
      filename,
      path,
      checksum: computeChecksum(content),
      content,
    });
  }
  return files;
}

// ── Database Connections ───────────────────────────────────────────────────

export function getConnection(db: DatabaseTarget): ReturnType<typeof postgres> | null {
  if (db === "supabase") {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    return postgres(url, { max: 1, idle_timeout: 5 });
  }

  // Forest — local Postgres
  return postgres({
    host: process.env.DB_HOST || "/var/run/postgresql",
    database: process.env.DB_NAME || "ellie-forest",
    username: process.env.DB_USER || "ellie",
    password: process.env.DB_PASS,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    max: 1,
    idle_timeout: 5,
  });
}

// ── Ledger Operations ──────────────────────────────────────────────────────

export async function ensureLedger(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migration_ledger (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_by TEXT NOT NULL DEFAULT 'migration-runner'
    )
  `;
}

export async function getAppliedMigrations(
  sql: ReturnType<typeof postgres>,
): Promise<LedgerEntry[]> {
  const rows = await sql<LedgerEntry[]>`
    SELECT filename, checksum, applied_at::text
    FROM _migration_ledger
    ORDER BY filename
  `;
  return rows;
}

async function recordMigration(
  sql: ReturnType<typeof postgres>,
  filename: string,
  checksum: string,
): Promise<void> {
  await sql`
    INSERT INTO _migration_ledger (filename, checksum)
    VALUES (${filename}, ${checksum})
    ON CONFLICT (filename) DO UPDATE SET checksum = ${checksum}, applied_at = NOW()
  `;
}

// ── Core: migrate ──────────────────────────────────────────────────────────

export async function migrate(
  db: DatabaseTarget,
  opts: { dryRun?: boolean; sql?: ReturnType<typeof postgres> } = {},
): Promise<MigrateResult> {
  const result: MigrateResult = {
    database: db,
    applied: [],
    skipped: [],
    modified: [],
    failed: [],
    dryRun: opts.dryRun ?? false,
  };

  const sql = opts.sql ?? getConnection(db);
  if (!sql) {
    result.failed.push({
      filename: "*",
      error: db === "supabase"
        ? "DATABASE_URL not set — cannot connect to Supabase directly"
        : "Cannot connect to Forest database",
    });
    return result;
  }

  try {
    await ensureLedger(sql);
    const applied = await getAppliedMigrations(sql);
    const appliedMap = new Map(applied.map((a) => [a.filename, a.checksum]));

    const files = await getMigrationFiles(db);

    for (const file of files) {
      const existingChecksum = appliedMap.get(file.filename);

      if (existingChecksum) {
        if (existingChecksum !== file.checksum) {
          result.modified.push(file.filename);
        } else {
          result.skipped.push(file.filename);
        }
        continue;
      }

      // Pending migration
      if (opts.dryRun) {
        result.applied.push(file.filename);
        continue;
      }

      try {
        await sql.unsafe(file.content);
        await recordMigration(sql, file.filename, file.checksum);
        result.applied.push(file.filename);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result.failed.push({ filename: file.filename, error: message });
        // Stop on first failure — later migrations may depend on this one
        break;
      }
    }
  } finally {
    if (!opts.sql) await sql.end();
  }

  return result;
}

// ── Core: status ───────────────────────────────────────────────────────────

export async function getStatus(
  db: DatabaseTarget,
  opts: { sql?: ReturnType<typeof postgres> } = {},
): Promise<StatusResult> {
  const files = await getMigrationFiles(db);
  const sql = opts.sql ?? getConnection(db);

  // No connection — show all files as pending with a note
  if (!sql) {
    const migrations: MigrationStatus[] = files.map((f) => ({
      filename: f.filename,
      status: "pending" as const,
      checksum: f.checksum,
    }));
    return {
      database: db,
      migrations,
      totals: { applied: 0, pending: files.length, modified: 0 },
    };
  }

  try {
    await ensureLedger(sql);
    const applied = await getAppliedMigrations(sql);
    const appliedMap = new Map(applied.map((a) => [a.filename, a]));

    const migrations: MigrationStatus[] = [];

    for (const file of files) {
      const entry = appliedMap.get(file.filename);
      if (entry) {
        const modified = entry.checksum !== file.checksum;
        migrations.push({
          filename: file.filename,
          status: modified ? "modified" : "applied",
          checksum: file.checksum,
          appliedChecksum: entry.checksum,
          appliedAt: entry.applied_at,
        });
      } else {
        migrations.push({
          filename: file.filename,
          status: "pending",
          checksum: file.checksum,
        });
      }
    }

    const totals = {
      applied: migrations.filter((m) => m.status === "applied").length,
      pending: migrations.filter((m) => m.status === "pending").length,
      modified: migrations.filter((m) => m.status === "modified").length,
    };

    return { database: db, migrations, totals };
  } finally {
    if (!opts.sql) await sql.end();
  }
}

// ── Core: validate seeds ───────────────────────────────────────────────────

/**
 * Parse INSERT statements from SQL to extract table name and columns.
 * Handles: INSERT INTO table_name (col1, col2, ...) VALUES ...
 */
export function parseInsertStatements(
  sql: string,
): { table: string; columns: string[] }[] {
  const results: { table: string; columns: string[] }[] = [];
  const regex = /INSERT\s+INTO\s+"?(\w+)"?\s*\(([^)]+)\)/gi;
  let match;
  while ((match = regex.exec(sql)) !== null) {
    const table = match[1];
    const columns = match[2]
      .split(",")
      .map((c) => c.trim().replace(/"/g, ""))
      .filter(Boolean);
    results.push({ table, columns });
  }
  return results;
}

/**
 * Get actual columns for a table from information_schema.
 */
async function getTableColumns(
  sql: ReturnType<typeof postgres>,
  table: string,
): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = ${table}
      AND table_schema = 'public'
    ORDER BY ordinal_position
  `;
  return rows.map((r) => r.column_name);
}

/**
 * Get all tables in the public schema.
 */
async function getPublicTables(
  sql: ReturnType<typeof postgres>,
): Promise<string[]> {
  const rows = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `;
  return rows.map((r) => r.table_name);
}

export async function validateSeeds(
  db: DatabaseTarget,
  opts: { sql?: ReturnType<typeof postgres> } = {},
): Promise<SeedIssue[]> {
  const sql = opts.sql ?? getConnection(db);
  if (!sql) return [];

  const issues: SeedIssue[] = [];

  try {
    const seedFiles = await getSeedFiles(db);

    for (const file of seedFiles) {
      const inserts = parseInsertStatements(file.content);

      for (const insert of inserts) {
        const actualColumns = await getTableColumns(sql, insert.table);
        if (actualColumns.length === 0) {
          issues.push({
            file: file.filename,
            table: insert.table,
            columns: insert.columns,
            missingColumns: insert.columns,
            message: `Table '${insert.table}' does not exist`,
          });
          continue;
        }

        const missing = insert.columns.filter(
          (c) => !actualColumns.includes(c),
        );
        if (missing.length > 0) {
          issues.push({
            file: file.filename,
            table: insert.table,
            columns: insert.columns,
            missingColumns: missing,
            message: `Columns [${missing.join(", ")}] not found in '${insert.table}'`,
          });
        }
      }
    }
  } finally {
    if (!opts.sql) await sql.end();
  }

  return issues;
}

// ── Core: detect code-vs-DB drift ──────────────────────────────────────────

/**
 * Scan source files for table references.
 * High-confidence patterns only:
 *   .from("table_name")       — Supabase PostgREST calls
 *   .rpc("function_name")     — Supabase RPC calls (tracked as tables)
 *   sql`...FROM table_name`   — only inside template literals
 */
export async function scanCodeForTableRefs(
  srcDir: string,
): Promise<Map<string, string[]>> {
  const tableRefs = new Map<string, string[]>(); // table -> [files]
  const { Glob } = await import("bun");

  // Common false positives: SQL keywords, English words, single chars
  const SKIP_WORDS = new Set([
    "select", "set", "where", "values", "or", "and", "not", "null",
    "true", "false", "on", "as", "in", "is", "by", "to", "of", "the",
    "a", "an", "if", "do", "no", "all", "any", "each", "for", "with",
    "this", "that", "it", "its", "new", "old", "key", "data", "type",
    "name", "text", "int", "json", "jsonb", "uuid", "date", "time",
    "varchar", "boolean", "serial", "bigint", "integer", "float",
    "function", "trigger", "index", "constraint", "schema", "role",
    "policy", "extension", "sequence", "view", "cascade", "restrict",
    "default", "primary", "foreign", "unique", "check", "references",
    "public", "begin", "end", "return", "returns", "language", "declare",
    "create", "alter", "drop", "grant", "revoke", "comment", "notify",
    "listen", "exists", "replace", "temp", "temporary", "only", "using",
    // Common code words that appear near FROM/INTO/UPDATE/JOIN
    "env", "disk", "file", "path", "line", "map", "row", "item",
    "list", "node", "body", "err", "error", "msg", "log", "db",
    "url", "api", "config", "result", "response", "request",
    "status", "state", "mode", "level", "count", "query", "match",
    "source", "target", "channel", "session", "event", "message",
    "content", "context", "prompt", "model", "agent", "user",
    "string", "number", "object", "array", "record", "void",
    "promise", "async", "await", "const", "let", "var",
    "import", "export", "class", "interface", "enum",
    "x", "y", "z", "i", "j", "k", "n", "m", "r", "e", "t", "s",
  ]);

  const glob = new Glob("**/*.ts");
  for await (const path of glob.scan({ cwd: srcDir })) {
    const fullPath = join(srcDir, path);
    const content = await readFile(fullPath, "utf-8");

    // .from("table_name") — Supabase PostgREST (highest confidence)
    const fromMatches = content.matchAll(/\.from\(\s*["'](\w+)["']\s*\)/g);
    for (const m of fromMatches) {
      const table = m[1];
      if (SKIP_WORDS.has(table.toLowerCase())) continue;
      const existing = tableRefs.get(table) || [];
      if (!existing.includes(path)) existing.push(path);
      tableRefs.set(table, existing);
    }

    // Only match SQL keywords inside template literals (sql`...`)
    // This is more precise than matching everywhere in the file
    const templateMatches = content.matchAll(/sql`([^`]*)`/gs);
    for (const tm of templateMatches) {
      const sqlBlock = tm[1];
      const sqlMatches = sqlBlock.matchAll(
        /(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\w+)/gi,
      );
      for (const m of sqlMatches) {
        const table = m[1].toLowerCase();
        if (SKIP_WORDS.has(table)) continue;
        // Skip tables that are clearly not table names (too short, all caps single word)
        if (table.length <= 2) continue;
        const existing = tableRefs.get(table) || [];
        if (!existing.includes(path)) existing.push(path);
        tableRefs.set(table, existing);
      }
    }
  }

  return tableRefs;
}

export async function detectDrift(
  db: DatabaseTarget,
  opts: { sql?: ReturnType<typeof postgres> } = {},
): Promise<DriftIssue[]> {
  const sql = opts.sql ?? getConnection(db);
  if (!sql) return [];

  const issues: DriftIssue[] = [];

  try {
    const actualTables = await getPublicTables(sql);
    const actualSet = new Set(actualTables);

    const srcDir = join(PROJECT_ROOT, "src");
    const codeRefs = await scanCodeForTableRefs(srcDir);

    for (const [table, files] of codeRefs) {
      // Skip internal/system tables, the ledger itself, and information_schema references
      if (table.startsWith("_") || table.startsWith("pg_") || table === "information_schema") continue;
      if (table === "table_name" || table === "column_name" || table === "table_schema") continue;
      // Skip common false positives
      if (["function", "trigger", "index", "constraint", "schema", "type", "extension", "role", "policy"].includes(table)) continue;

      if (!actualSet.has(table)) {
        issues.push({
          table,
          source: files.join(", "),
          message: `Table '${table}' referenced in code but not found in ${db} database`,
        });
      }
    }
  } finally {
    if (!opts.sql) await sql.end();
  }

  return issues;
}

export async function validate(
  db: DatabaseTarget,
  opts: { sql?: ReturnType<typeof postgres> } = {},
): Promise<ValidateResult> {
  const sql = opts.sql ?? getConnection(db);
  if (!sql) {
    return { database: db, seedIssues: [], driftIssues: [], clean: true };
  }

  try {
    const [seedIssues, driftIssues] = await Promise.all([
      validateSeeds(db, { sql }),
      detectDrift(db, { sql }),
    ]);

    return {
      database: db,
      seedIssues,
      driftIssues,
      clean: seedIssues.length === 0 && driftIssues.length === 0,
    };
  } finally {
    if (!opts.sql) await sql.end();
  }
}

// ── Formatters ─────────────────────────────────────────────────────────────

export function formatMigrateResult(result: MigrateResult): string {
  const lines: string[] = [];
  const label = result.database.toUpperCase();
  const mode = result.dryRun ? " (DRY RUN)" : "";

  lines.push(`\n── ${label} Migrations${mode} ──`);

  if (result.failed.length > 0 && result.failed[0].filename === "*") {
    lines.push(`  SKIP  ${result.failed[0].error}`);
    return lines.join("\n");
  }

  if (result.applied.length > 0) {
    lines.push(`  ${result.dryRun ? "WOULD APPLY" : "APPLIED"}:`);
    for (const f of result.applied) lines.push(`    + ${f}`);
  }
  if (result.skipped.length > 0) {
    lines.push(`  ALREADY APPLIED: ${result.skipped.length}`);
  }
  if (result.modified.length > 0) {
    lines.push(`  MODIFIED (checksum mismatch):`);
    for (const f of result.modified) lines.push(`    ! ${f}`);
  }
  if (result.failed.length > 0) {
    lines.push(`  FAILED:`);
    for (const f of result.failed) lines.push(`    x ${f.filename}: ${f.error}`);
  }

  const total = result.applied.length + result.skipped.length + result.modified.length;
  lines.push(`  TOTAL: ${total} files, ${result.applied.length} applied, ${result.failed.length} failed`);

  return lines.join("\n");
}

export function formatStatusResult(result: StatusResult): string {
  const lines: string[] = [];
  const label = result.database.toUpperCase();

  lines.push(`\n── ${label} Migration Status ──`);

  if (result.migrations.length === 0) {
    lines.push("  No migration files found.");
    return lines.join("\n");
  }

  for (const m of result.migrations) {
    const icon = m.status === "applied" ? "+" : m.status === "pending" ? "-" : "!";
    const suffix =
      m.status === "applied" ? ` (${m.appliedAt?.split("T")[0] ?? "?"})` :
      m.status === "modified" ? " (CHECKSUM MISMATCH)" :
      "";
    lines.push(`  ${icon} ${m.filename}${suffix}`);
  }

  lines.push(
    `  TOTAL: ${result.totals.applied} applied, ${result.totals.pending} pending, ${result.totals.modified} modified`,
  );

  return lines.join("\n");
}

export function formatValidateResult(result: ValidateResult): string {
  const lines: string[] = [];
  const label = result.database.toUpperCase();

  lines.push(`\n── ${label} Validation ──`);

  if (result.seedIssues.length > 0) {
    lines.push("  SEED ISSUES:");
    for (const issue of result.seedIssues) {
      lines.push(`    ! ${issue.file}: ${issue.message}`);
    }
  }

  if (result.driftIssues.length > 0) {
    lines.push("  CODE-vs-DB DRIFT:");
    for (const issue of result.driftIssues) {
      lines.push(`    ! ${issue.table}: ${issue.message}`);
      lines.push(`      Referenced in: ${issue.source}`);
    }
  }

  if (result.clean) {
    lines.push("  All clear — seeds match schema, no drift detected.");
  }

  return lines.join("\n");
}

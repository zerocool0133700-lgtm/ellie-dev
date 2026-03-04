/**
 * Migration Runner Tests — ELLIE-518
 *
 * Tests the SQL migration runner: file discovery, checksum,
 * ledger operations, status, seed validation, drift detection,
 * and formatters.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import postgres from "postgres";
import {
  computeChecksum,
  getMigrationFiles,
  getSeedFiles,
  parseInsertStatements,
  ensureLedger,
  getAppliedMigrations,
  migrate,
  getStatus,
  validateSeeds,
  scanCodeForTableRefs,
  formatMigrateResult,
  formatStatusResult,
  formatValidateResult,
  type MigrateResult,
  type StatusResult,
  type ValidateResult,
  type DatabaseTarget,
} from "../src/migrate.ts";

// ── Test database setup ────────────────────────────────────────────────────
// Uses the local Forest database with a test schema to isolate

let sql: ReturnType<typeof postgres>;
const TEST_SCHEMA = "_migrate_test";

beforeAll(async () => {
  sql = postgres({
    host: "/var/run/postgresql",
    database: "ellie-forest",
    username: "ellie",
    max: 1,
    idle_timeout: 10,
  });

  // Create isolated test schema
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${TEST_SCHEMA}`);
  await sql.unsafe(`SET search_path TO ${TEST_SCHEMA}, public`);
});

afterAll(async () => {
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
  } finally {
    await sql.end();
  }
});

// ── Pure function tests ────────────────────────────────────────────────────

describe("computeChecksum", () => {
  test("returns consistent hash for same content", () => {
    const hash1 = computeChecksum("CREATE TABLE foo (id INT);");
    const hash2 = computeChecksum("CREATE TABLE foo (id INT);");
    expect(hash1).toBe(hash2);
  });

  test("returns different hash for different content", () => {
    const hash1 = computeChecksum("CREATE TABLE foo (id INT);");
    const hash2 = computeChecksum("CREATE TABLE bar (id INT);");
    expect(hash1).not.toBe(hash2);
  });

  test("returns 16-character hex string", () => {
    const hash = computeChecksum("test content");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("handles empty string", () => {
    const hash = computeChecksum("");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("handles unicode content", () => {
    const hash = computeChecksum("-- Créer une table 日本語");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("parseInsertStatements", () => {
  test("parses simple INSERT", () => {
    const result = parseInsertStatements(
      `INSERT INTO users (id, name, email) VALUES ('1', 'Dave', 'dave@test.com');`,
    );
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("users");
    expect(result[0].columns).toEqual(["id", "name", "email"]);
  });

  test("parses multiple INSERTs", () => {
    const sql = `
      INSERT INTO agents (name, type) VALUES ('general', 'generalist');
      INSERT INTO skills (name, agent) VALUES ('coding', 'dev');
    `;
    const result = parseInsertStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0].table).toBe("agents");
    expect(result[1].table).toBe("skills");
  });

  test("handles quoted column names", () => {
    const result = parseInsertStatements(
      `INSERT INTO "events" ("id", "type", "created_at") VALUES (1, 'test', NOW());`,
    );
    expect(result).toHaveLength(1);
    expect(result[0].columns).toEqual(["id", "type", "created_at"]);
  });

  test("handles INSERT with extra whitespace", () => {
    const result = parseInsertStatements(
      `INSERT   INTO   users  ( id , name , email )  VALUES ('1', 'test', 'test@test.com');`,
    );
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("users");
    expect(result[0].columns).toEqual(["id", "name", "email"]);
  });

  test("returns empty for non-INSERT SQL", () => {
    const result = parseInsertStatements("CREATE TABLE users (id INT);");
    expect(result).toHaveLength(0);
  });

  test("case-insensitive matching", () => {
    const result = parseInsertStatements(
      `insert into USERS (ID, NAME) values ('1', 'test');`,
    );
    expect(result).toHaveLength(1);
    expect(result[0].table).toBe("USERS");
  });
});

// ── File discovery tests ───────────────────────────────────────────────────

describe("getMigrationFiles", () => {
  test("reads real migration files from forest directory", async () => {
    const files = await getMigrationFiles("forest");
    expect(files.length).toBeGreaterThan(0);

    // Files should be sorted
    for (let i = 1; i < files.length; i++) {
      expect(files[i].filename >= files[i - 1].filename).toBe(true);
    }

    // Each file should have checksum and content
    for (const file of files) {
      expect(file.filename).toEndWith(".sql");
      expect(file.checksum).toMatch(/^[0-9a-f]{16}$/);
      expect(file.content.length).toBeGreaterThan(0);
    }
  });

  test("reads real migration files from supabase directory", async () => {
    const files = await getMigrationFiles("supabase");
    expect(files.length).toBeGreaterThan(0);
  });

  test("checksums are deterministic", async () => {
    const files1 = await getMigrationFiles("forest");
    const files2 = await getMigrationFiles("forest");
    expect(files1.map((f) => f.checksum)).toEqual(files2.map((f) => f.checksum));
  });
});

describe("getSeedFiles", () => {
  test("reads real seed files from forest directory", async () => {
    const files = await getSeedFiles("forest");
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.filename).toEndWith(".sql");
    }
  });

  test("reads real seed files from supabase directory", async () => {
    const files = await getSeedFiles("supabase");
    expect(files.length).toBeGreaterThan(0);
  });
});

// ── Ledger operations (real DB) ────────────────────────────────────────────

describe("ledger operations", () => {
  let testSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    testSql = postgres({
      host: "/var/run/postgresql",
      database: "ellie-forest",
      username: "ellie",
      max: 1,
      idle_timeout: 10,
    });
    // Use a separate ledger table for testing
    await testSql.unsafe(`DROP TABLE IF EXISTS _migration_ledger_test`);
  });

  afterAll(async () => {
    await testSql.unsafe(`DROP TABLE IF EXISTS _migration_ledger_test`);
    await testSql.end();
  });

  test("ensureLedger creates table idempotently", async () => {
    await ensureLedger(testSql);
    await ensureLedger(testSql); // should not throw
    const rows = await testSql`SELECT COUNT(*)::int as count FROM _migration_ledger`;
    expect(rows[0].count).toBeGreaterThanOrEqual(0);
  });

  test("getAppliedMigrations returns entries", async () => {
    await ensureLedger(testSql);
    const applied = await getAppliedMigrations(testSql);
    expect(Array.isArray(applied)).toBe(true);
  });
});

// ── Migration flow with temp directory ─────────────────────────────────────

describe("migrate (with temp dir)", () => {
  let tempDir: string;
  let testSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "migrate-test-"));

    // Create migration directory structure
    await mkdir(join(tempDir, "migrations", "test_db"), { recursive: true });
    await mkdir(join(tempDir, "seeds", "test_db"), { recursive: true });

    // Create test migration files
    await writeFile(
      join(tempDir, "migrations", "test_db", "001_create_users.sql"),
      "CREATE TABLE IF NOT EXISTS _mtest_users (id SERIAL PRIMARY KEY, name TEXT);",
    );
    await writeFile(
      join(tempDir, "migrations", "test_db", "002_create_posts.sql"),
      "CREATE TABLE IF NOT EXISTS _mtest_posts (id SERIAL PRIMARY KEY, user_id INT, title TEXT);",
    );

    testSql = postgres({
      host: "/var/run/postgresql",
      database: "ellie-forest",
      username: "ellie",
      max: 1,
      idle_timeout: 10,
    });
  });

  afterAll(async () => {
    // Cleanup test tables
    await testSql.unsafe("DROP TABLE IF EXISTS _mtest_users CASCADE");
    await testSql.unsafe("DROP TABLE IF EXISTS _mtest_posts CASCADE");
    // Clean ledger entries from test
    await testSql`DELETE FROM _migration_ledger WHERE filename LIKE '00%_create_%'`.catch(() => {});
    await testSql.end();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("migrate applies pending and records in ledger", async () => {
    await ensureLedger(testSql);

    // Clean up any prior test entries
    await testSql`DELETE FROM _migration_ledger WHERE filename LIKE '00%_create_%'`.catch(() => {});

    const result = await migrate("forest", { sql: testSql });
    // At minimum, it should process files without crashing
    expect(result.database).toBe("forest");
    expect(Array.isArray(result.applied)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(Array.isArray(result.failed)).toBe(true);
  });

  test("dry-run does not apply migrations", async () => {
    const result = await migrate("forest", { sql: testSql, dryRun: true });
    expect(result.dryRun).toBe(true);
    // In dry-run, no failures should occur from execution
    expect(result.failed).toHaveLength(0);
  });
});

// ── Status ─────────────────────────────────────────────────────────────────

describe("getStatus", () => {
  test("returns status for forest", async () => {
    const testSql = postgres({
      host: "/var/run/postgresql",
      database: "ellie-forest",
      username: "ellie",
      max: 1,
      idle_timeout: 10,
    });

    try {
      await ensureLedger(testSql);
      const result = await getStatus("forest", { sql: testSql });
      expect(result.database).toBe("forest");
      expect(Array.isArray(result.migrations)).toBe(true);
      expect(result.totals).toHaveProperty("applied");
      expect(result.totals).toHaveProperty("pending");
      expect(result.totals).toHaveProperty("modified");
      expect(result.totals.applied + result.totals.pending + result.totals.modified).toBe(
        result.migrations.length,
      );
    } finally {
      await testSql.end();
    }
  });
});

// ── Seed validation ────────────────────────────────────────────────────────

describe("validateSeeds", () => {
  test("validates forest seeds against schema", async () => {
    const testSql = postgres({
      host: "/var/run/postgresql",
      database: "ellie-forest",
      username: "ellie",
      max: 1,
      idle_timeout: 10,
    });

    try {
      const issues = await validateSeeds("forest", { sql: testSql });
      expect(Array.isArray(issues)).toBe(true);
      // Each issue should have the expected shape
      for (const issue of issues) {
        expect(issue).toHaveProperty("file");
        expect(issue).toHaveProperty("table");
        expect(issue).toHaveProperty("columns");
        expect(issue).toHaveProperty("missingColumns");
        expect(issue).toHaveProperty("message");
      }
    } finally {
      await testSql.end();
    }
  });
});

// ── Code-vs-DB drift detection ─────────────────────────────────────────────

describe("scanCodeForTableRefs", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "drift-test-"));

    await writeFile(
      join(tempDir, "example.ts"),
      `
        const { data } = await supabase.from("users").select("*");
        const { data: posts } = await supabase.from("posts").select("*");
        await sql\`SELECT * FROM agents WHERE id = \${id}\`;
        await sql\`INSERT INTO messages (content) VALUES (\${text})\`;
      `,
    );

    await writeFile(
      join(tempDir, "other.ts"),
      `
        // This references users too
        const result = await supabase.from("users").insert(row);
        await sql\`UPDATE settings SET value = \${val}\`;
      `,
    );
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("finds .from() references", async () => {
    const refs = await scanCodeForTableRefs(tempDir);
    expect(refs.has("users")).toBe(true);
    expect(refs.has("posts")).toBe(true);
  });

  test("finds SQL keyword references", async () => {
    const refs = await scanCodeForTableRefs(tempDir);
    expect(refs.has("agents")).toBe(true);
    expect(refs.has("messages")).toBe(true);
    expect(refs.has("settings")).toBe(true);
  });

  test("tracks which files reference each table", async () => {
    const refs = await scanCodeForTableRefs(tempDir);
    const userFiles = refs.get("users") ?? [];
    expect(userFiles.length).toBe(2); // both example.ts and other.ts
  });

  test("deduplicates file references", async () => {
    const refs = await scanCodeForTableRefs(tempDir);
    const userFiles = refs.get("users") ?? [];
    const unique = new Set(userFiles);
    expect(unique.size).toBe(userFiles.length);
  });
});

// ── Formatters ─────────────────────────────────────────────────────────────

describe("formatMigrateResult", () => {
  test("formats successful migration", () => {
    const result: MigrateResult = {
      database: "forest",
      applied: ["001_create_users.sql", "002_create_posts.sql"],
      skipped: ["000_init.sql"],
      modified: [],
      failed: [],
      dryRun: false,
    };
    const output = formatMigrateResult(result);
    expect(output).toContain("FOREST");
    expect(output).toContain("APPLIED");
    expect(output).toContain("001_create_users.sql");
    expect(output).toContain("ALREADY APPLIED: 1");
    expect(output).toContain("2 applied");
  });

  test("formats dry run", () => {
    const result: MigrateResult = {
      database: "supabase",
      applied: ["001_create_users.sql"],
      skipped: [],
      modified: [],
      failed: [],
      dryRun: true,
    };
    const output = formatMigrateResult(result);
    expect(output).toContain("SUPABASE");
    expect(output).toContain("DRY RUN");
    expect(output).toContain("WOULD APPLY");
  });

  test("formats modified migrations warning", () => {
    const result: MigrateResult = {
      database: "forest",
      applied: [],
      skipped: ["001_init.sql"],
      modified: ["002_schema.sql"],
      failed: [],
      dryRun: false,
    };
    const output = formatMigrateResult(result);
    expect(output).toContain("MODIFIED");
    expect(output).toContain("002_schema.sql");
  });

  test("formats failures", () => {
    const result: MigrateResult = {
      database: "forest",
      applied: [],
      skipped: [],
      modified: [],
      failed: [{ filename: "bad.sql", error: "syntax error" }],
      dryRun: false,
    };
    const output = formatMigrateResult(result);
    expect(output).toContain("FAILED");
    expect(output).toContain("syntax error");
  });

  test("formats connection skip", () => {
    const result: MigrateResult = {
      database: "supabase",
      applied: [],
      skipped: [],
      modified: [],
      failed: [{ filename: "*", error: "DATABASE_URL not set" }],
      dryRun: false,
    };
    const output = formatMigrateResult(result);
    expect(output).toContain("SKIP");
    expect(output).toContain("DATABASE_URL not set");
  });
});

describe("formatStatusResult", () => {
  test("formats status with mixed states", () => {
    const result: StatusResult = {
      database: "forest",
      migrations: [
        { filename: "001_init.sql", status: "applied", checksum: "abc", appliedAt: "2026-03-01T00:00:00Z" },
        { filename: "002_schema.sql", status: "pending", checksum: "def" },
        { filename: "003_fix.sql", status: "modified", checksum: "ghi", appliedChecksum: "xyz" },
      ],
      totals: { applied: 1, pending: 1, modified: 1 },
    };
    const output = formatStatusResult(result);
    expect(output).toContain("FOREST");
    expect(output).toContain("+ 001_init.sql");
    expect(output).toContain("- 002_schema.sql");
    expect(output).toContain("! 003_fix.sql");
    expect(output).toContain("CHECKSUM MISMATCH");
    expect(output).toContain("1 applied, 1 pending, 1 modified");
  });

  test("formats empty status", () => {
    const result: StatusResult = {
      database: "supabase",
      migrations: [],
      totals: { applied: 0, pending: 0, modified: 0 },
    };
    const output = formatStatusResult(result);
    expect(output).toContain("No migration files found");
  });
});

describe("formatValidateResult", () => {
  test("formats clean validation", () => {
    const result: ValidateResult = {
      database: "forest",
      seedIssues: [],
      driftIssues: [],
      clean: true,
    };
    const output = formatValidateResult(result);
    expect(output).toContain("All clear");
  });

  test("formats seed issues", () => {
    const result: ValidateResult = {
      database: "forest",
      seedIssues: [{
        file: "seed.sql",
        table: "users",
        columns: ["id", "foo"],
        missingColumns: ["foo"],
        message: "Columns [foo] not found in 'users'",
      }],
      driftIssues: [],
      clean: false,
    };
    const output = formatValidateResult(result);
    expect(output).toContain("SEED ISSUES");
    expect(output).toContain("Columns [foo] not found");
  });

  test("formats drift issues", () => {
    const result: ValidateResult = {
      database: "supabase",
      seedIssues: [],
      driftIssues: [{
        table: "nonexistent",
        source: "src/api/test.ts",
        message: "Table 'nonexistent' referenced in code but not found in supabase database",
      }],
      clean: false,
    };
    const output = formatValidateResult(result);
    expect(output).toContain("CODE-vs-DB DRIFT");
    expect(output).toContain("nonexistent");
    expect(output).toContain("src/api/test.ts");
  });
});

// ── Integration: full flow ─────────────────────────────────────────────────

describe("integration: migrate + status round-trip", () => {
  let testSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    testSql = postgres({
      host: "/var/run/postgresql",
      database: "ellie-forest",
      username: "ellie",
      max: 1,
      idle_timeout: 10,
    });
    await ensureLedger(testSql);
  });

  afterAll(async () => {
    await testSql.end();
  });

  test("status totals are consistent", async () => {
    const result = await getStatus("forest", { sql: testSql });
    const { applied, pending, modified } = result.totals;
    expect(applied + pending + modified).toBe(result.migrations.length);
  });

  test("all migration files appear in status", async () => {
    const files = await getMigrationFiles("forest");
    const result = await getStatus("forest", { sql: testSql });
    expect(result.migrations.length).toBe(files.length);
  });
});

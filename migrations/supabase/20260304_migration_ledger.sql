-- Migration ledger — tracks which migrations have been applied
-- Used by: bun run migrate / bun run migrate:status

CREATE TABLE IF NOT EXISTS _migration_ledger (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,           -- SHA-256 of file content at apply time
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by TEXT NOT NULL DEFAULT 'migration-runner'
);

CREATE INDEX IF NOT EXISTS idx_migration_ledger_filename
  ON _migration_ledger (filename);

#!/usr/bin/env bun
/**
 * Bootstrap critical Forest schema for tests.
 *
 * Applies migrations 034-037 (connector_logs, cleaned_data, domain_models, curation)
 * directly via psql, using IF NOT EXISTS / IF NOT COLUMN guards so it's idempotent.
 *
 * Usage:  bun scripts/bootstrap-test-schema.ts
 */

import { $ } from "bun";

const DB = "ellie-forest";

const sql = `
-- 034: connector_logs
CREATE TABLE IF NOT EXISTS connector_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  items_fetched int NOT NULL DEFAULT 0,
  items_normalized int NOT NULL DEFAULT 0,
  items_validated int NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]',
  duration_ms int,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  config jsonb NOT NULL DEFAULT '{}',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_connector_logs_name ON connector_logs (connector_name);
CREATE INDEX IF NOT EXISTS idx_connector_logs_status ON connector_logs (status) WHERE status != 'completed';
CREATE INDEX IF NOT EXISTS idx_connector_logs_started ON connector_logs (started_at DESC);

-- 035: cleaned_data + chunks
CREATE TABLE IF NOT EXISTS cleaned_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_name text NOT NULL,
  source_id text NOT NULL,
  content text NOT NULL,
  content_type text NOT NULL DEFAULT 'plain_text',
  title text,
  metadata jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  error text,
  domain_model_id uuid,
  connector_log_id uuid REFERENCES connector_logs(id),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS cleaned_data_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cleaned_data_id uuid NOT NULL REFERENCES cleaned_data(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  content text NOT NULL,
  token_count int NOT NULL DEFAULT 0,
  embedding vector(1536),
  dedup_hash text,
  is_duplicate boolean NOT NULL DEFAULT false,
  duplicate_of uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cleaned_data_status ON cleaned_data (status) WHERE status != 'ready';
CREATE INDEX IF NOT EXISTS idx_cleaned_data_connector ON cleaned_data (connector_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cleaned_data_source ON cleaned_data (source_id);
CREATE INDEX IF NOT EXISTS idx_cleaned_data_chunks_parent ON cleaned_data_chunks (cleaned_data_id);
CREATE INDEX IF NOT EXISTS idx_cleaned_data_chunks_dedup ON cleaned_data_chunks (dedup_hash) WHERE dedup_hash IS NOT NULL;

-- ivfflat index needs rows to exist; skip if already present
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_cleaned_data_chunks_embedding') THEN
    CREATE INDEX idx_cleaned_data_chunks_embedding
      ON cleaned_data_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);
  END IF;
END $$;

-- 036: domain_models + sources
CREATE TABLE IF NOT EXISTS domain_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  owner_id uuid,
  river_collection text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active',
  config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS domain_model_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_model_id uuid NOT NULL REFERENCES domain_models(id) ON DELETE CASCADE,
  connector_name text NOT NULL,
  source_config jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (domain_model_id, connector_name)
);

CREATE INDEX IF NOT EXISTS idx_domain_models_status ON domain_models (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_domain_model_sources_model ON domain_model_sources (domain_model_id);
CREATE INDEX IF NOT EXISTS idx_domain_model_sources_connector ON domain_model_sources (connector_name);

-- FK: cleaned_data -> domain_models (skip if exists)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_cleaned_data_domain_model'
  ) THEN
    ALTER TABLE cleaned_data
      ADD CONSTRAINT fk_cleaned_data_domain_model
      FOREIGN KEY (domain_model_id) REFERENCES domain_models(id);
  END IF;
END $$;

-- 037: curation columns on cleaned_data
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cleaned_data' AND column_name = 'curation_status'
  ) THEN
    ALTER TABLE cleaned_data ADD COLUMN curation_status text NOT NULL DEFAULT 'pending_review';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cleaned_data' AND column_name = 'memory_tier'
  ) THEN
    ALTER TABLE cleaned_data ADD COLUMN memory_tier text NOT NULL DEFAULT 'untiered';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cleaned_data' AND column_name = 'curated_at'
  ) THEN
    ALTER TABLE cleaned_data ADD COLUMN curated_at timestamptz;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cleaned_data' AND column_name = 'curator_notes'
  ) THEN
    ALTER TABLE cleaned_data ADD COLUMN curator_notes text;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cleaned_data_curation ON cleaned_data (curation_status) WHERE curation_status != 'approved';
CREATE INDEX IF NOT EXISTS idx_cleaned_data_domain_curation ON cleaned_data (domain_model_id, curation_status);
CREATE INDEX IF NOT EXISTS idx_cleaned_data_tier ON cleaned_data (memory_tier) WHERE memory_tier != 'untiered';
`;

async function main() {
  console.log("Bootstrapping test schema on ellie-forest...\n");

  const result = await $`psql -d ${DB} -c ${sql}`.quiet();

  if (result.exitCode !== 0) {
    console.error("FAILED:\n", result.stderr.toString());
    process.exit(1);
  }

  console.log("Schema applied.\n");

  // Verify
  const check = await $`psql -d ${DB} -t -c "
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('connector_logs','cleaned_data','cleaned_data_chunks','domain_models','domain_model_sources')
    ORDER BY table_name;
  "`.quiet();

  const tables = check.stdout.toString().trim().split("\n").map((t: string) => t.trim()).filter(Boolean);
  const expected = ["cleaned_data", "cleaned_data_chunks", "connector_logs", "domain_models", "domain_model_sources"];

  const missing = expected.filter(t => !tables.includes(t));
  if (missing.length) {
    console.error("Missing tables:", missing.join(", "));
    process.exit(1);
  }

  // Check curation columns
  const cols = await $`psql -d ${DB} -t -c "
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'cleaned_data'
      AND column_name IN ('curation_status','memory_tier','curated_at','curator_notes')
    ORDER BY column_name;
  "`.quiet();

  const colList = cols.stdout.toString().trim().split("\n").map((c: string) => c.trim()).filter(Boolean);
  const expectedCols = ["curated_at", "curation_status", "curator_notes", "memory_tier"];
  const missingCols = expectedCols.filter(c => !colList.includes(c));

  if (missingCols.length) {
    console.error("Missing curation columns:", missingCols.join(", "));
    process.exit(1);
  }

  console.log("Verified tables:", expected.join(", "));
  console.log("Verified curation columns:", expectedCols.join(", "));
  console.log("\nDone — all test schema ready.");
}

main();

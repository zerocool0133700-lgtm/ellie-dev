-- ============================================================
-- ELLIE-663: Create mountain_records table
-- ============================================================
-- Mountain data harvesting system — stores structured records
-- pulled from external systems. First domain: medical billing
-- (Office Practicum — billing, visits, schedules).
--
-- Design: typed record_type + JSONB payload so new record types
-- can be added without schema changes.
-- ============================================================

-- Record status enum
DO $$ BEGIN
  CREATE TYPE mountain_record_status AS ENUM (
    'pending',    -- harvested, not yet processed
    'active',     -- processed and current
    'superseded', -- replaced by a newer version
    'archived',   -- soft-deleted / no longer relevant
    'error'       -- harvest or processing failed
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Main table
CREATE TABLE IF NOT EXISTS mountain_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Classification
  record_type TEXT NOT NULL,        -- e.g. 'billing', 'visit', 'schedule'
  source_system TEXT NOT NULL,      -- e.g. 'office-practicum', 'gmail'
  external_id TEXT NOT NULL,        -- ID from the source system

  -- Content
  payload JSONB NOT NULL DEFAULT '{}',
  summary TEXT,                     -- optional human-readable summary

  -- Status
  status mountain_record_status NOT NULL DEFAULT 'active',

  -- Provenance
  harvest_job_id TEXT,              -- which harvest job produced this record
  source_timestamp TIMESTAMPTZ,    -- when the record was created in the source

  -- Versioning
  supersedes_id UUID REFERENCES mountain_records(id),
  version INT NOT NULL DEFAULT 1,

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique constraint: one external ID per source system
  CONSTRAINT uq_mountain_source_external UNIQUE (source_system, external_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_mountain_records_type
  ON mountain_records (record_type) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_mountain_records_source
  ON mountain_records (source_system) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_mountain_records_external_id
  ON mountain_records (external_id);

CREATE INDEX IF NOT EXISTS idx_mountain_records_created
  ON mountain_records (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mountain_records_status
  ON mountain_records (status);

CREATE INDEX IF NOT EXISTS idx_mountain_records_source_type
  ON mountain_records (source_system, record_type) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_mountain_records_harvest_job
  ON mountain_records (harvest_job_id) WHERE harvest_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mountain_records_payload
  ON mountain_records USING gin (payload);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_mountain_records_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_mountain_records_updated_at ON mountain_records;
CREATE TRIGGER trg_mountain_records_updated_at
  BEFORE UPDATE ON mountain_records
  FOR EACH ROW EXECUTE FUNCTION update_mountain_records_updated_at();

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";

const migrationSql = readFileSync(
  new URL("../migrations/supabase/20260316_capture_queue.sql", import.meta.url),
  "utf-8"
);

describe("ELLIE-768: Capture queue migration", () => {
  describe("enum types", () => {
    it("creates capture_type enum with all values", () => {
      expect(migrationSql).toContain("CREATE TYPE capture_type AS ENUM");
      for (const val of ["manual", "tag", "proactive", "replay", "braindump", "template"]) {
        expect(migrationSql).toContain(`'${val}'`);
      }
    });

    it("creates capture_content_type enum with all values", () => {
      expect(migrationSql).toContain("CREATE TYPE capture_content_type AS ENUM");
      for (const val of ["workflow", "decision", "process", "policy", "integration", "reference"]) {
        expect(migrationSql).toContain(`'${val}'`);
      }
    });

    it("creates capture_status enum with all values", () => {
      expect(migrationSql).toContain("CREATE TYPE capture_status AS ENUM");
      for (const val of ["queued", "refined", "approved", "written", "dismissed"]) {
        expect(migrationSql).toContain(`'${val}'`);
      }
    });

    it("handles duplicate enum types gracefully", () => {
      expect(migrationSql).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
    });
  });

  describe("table definition", () => {
    it("creates capture_queue table", () => {
      expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS capture_queue");
    });

    it("has UUID primary key", () => {
      expect(migrationSql).toContain("id UUID PRIMARY KEY DEFAULT gen_random_uuid()");
    });

    it("has source_message_id FK to messages", () => {
      expect(migrationSql).toContain("source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL");
    });

    it("has channel with check constraint", () => {
      expect(migrationSql).toContain("channel TEXT NOT NULL CHECK");
      for (const ch of ["telegram", "ellie-chat", "google-chat", "voice"]) {
        expect(migrationSql).toContain(`'${ch}'`);
      }
    });

    it("has raw_content as NOT NULL", () => {
      expect(migrationSql).toContain("raw_content TEXT NOT NULL");
    });

    it("has nullable refined_content", () => {
      expect(migrationSql).toMatch(/refined_content TEXT[,\s]/);
    });

    it("has suggested_path and suggested_section", () => {
      expect(migrationSql).toContain("suggested_path TEXT");
      expect(migrationSql).toContain("suggested_section TEXT");
    });

    it("has capture_type with default manual", () => {
      expect(migrationSql).toContain("capture_type capture_type NOT NULL DEFAULT 'manual'");
    });

    it("has content_type with default reference", () => {
      expect(migrationSql).toContain("content_type capture_content_type NOT NULL DEFAULT 'reference'");
    });

    it("has status with default queued", () => {
      expect(migrationSql).toContain("status capture_status NOT NULL DEFAULT 'queued'");
    });

    it("has confidence with range constraint", () => {
      expect(migrationSql).toContain("confidence REAL CHECK (confidence >= 0 AND confidence <= 1)");
    });

    it("has timestamp columns", () => {
      expect(migrationSql).toContain("created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      expect(migrationSql).toContain("updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      expect(migrationSql).toContain("processed_at TIMESTAMPTZ");
    });
  });

  describe("indexes", () => {
    it("creates index on status", () => {
      expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS idx_capture_queue_status ON capture_queue(status)");
    });

    it("creates index on channel", () => {
      expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS idx_capture_queue_channel ON capture_queue(channel)");
    });

    it("creates index on created_at DESC", () => {
      expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS idx_capture_queue_created_at ON capture_queue(created_at DESC)");
    });

    it("creates composite index on status + created_at", () => {
      expect(migrationSql).toContain("idx_capture_queue_status_created ON capture_queue(status, created_at DESC)");
    });
  });

  describe("updated_at trigger", () => {
    it("creates trigger function", () => {
      expect(migrationSql).toContain("CREATE OR REPLACE FUNCTION update_capture_queue_updated_at()");
      expect(migrationSql).toContain("NEW.updated_at = NOW()");
    });

    it("creates BEFORE UPDATE trigger", () => {
      expect(migrationSql).toContain("BEFORE UPDATE ON capture_queue");
      expect(migrationSql).toContain("EXECUTE FUNCTION update_capture_queue_updated_at()");
    });
  });

  describe("RLS policies", () => {
    it("enables row level security", () => {
      expect(migrationSql).toContain("ALTER TABLE capture_queue ENABLE ROW LEVEL SECURITY");
    });

    it("creates read policy for authenticated users", () => {
      expect(migrationSql).toContain("capture_queue_authenticated_read ON capture_queue");
      expect(migrationSql).toContain("FOR SELECT TO authenticated");
    });

    it("creates insert policy for authenticated users", () => {
      expect(migrationSql).toContain("capture_queue_authenticated_insert ON capture_queue");
      expect(migrationSql).toContain("FOR INSERT TO authenticated");
    });

    it("creates update policy for authenticated users", () => {
      expect(migrationSql).toContain("capture_queue_authenticated_update ON capture_queue");
      expect(migrationSql).toContain("FOR UPDATE TO authenticated");
    });
  });
});

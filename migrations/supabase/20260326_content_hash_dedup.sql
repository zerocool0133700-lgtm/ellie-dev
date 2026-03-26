-- ELLIE-1031: Content-hash deduplication on conversation_facts
-- Enables cross-channel duplicate detection via SHA256 hash of normalized content

-- Add content_hash column
ALTER TABLE conversation_facts ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- Create index for O(1) hash lookup
CREATE INDEX IF NOT EXISTS idx_cf_content_hash ON conversation_facts(content_hash) WHERE content_hash IS NOT NULL;

-- Add alt_sources column to track which channels contributed the same fact
ALTER TABLE conversation_facts ADD COLUMN IF NOT EXISTS alt_sources JSONB DEFAULT '[]'::jsonb;

-- Backfill existing facts with content hashes
UPDATE conversation_facts
SET content_hash = encode(sha256(
  lower(regexp_replace(trim(content), '\s+', ' ', 'g'))::bytea
), 'hex')
WHERE content_hash IS NULL AND content IS NOT NULL;

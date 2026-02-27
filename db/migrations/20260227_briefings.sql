-- ELLIE-316: Briefing Module — daily AI-generated context summaries
-- Run against Supabase SQL editor

CREATE TABLE IF NOT EXISTS briefings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  briefing_date DATE NOT NULL,
  content JSONB NOT NULL,              -- structured briefing sections
  formatted_text TEXT NOT NULL,         -- markdown for Telegram/Chat delivery
  priority_score FLOAT DEFAULT 0,      -- overall urgency (0-100)
  source_counts JSONB DEFAULT '{}',    -- { calendar: 3, gtd: 5, email: 2, ... }
  delivered_at TIMESTAMPTZ,            -- when sent to Telegram/Chat (null = not yet)
  delivery_channels TEXT[] DEFAULT '{}', -- ['telegram', 'google-chat']
  UNIQUE (briefing_date)
);

CREATE INDEX IF NOT EXISTS idx_briefings_date ON briefings(briefing_date DESC);

-- RLS (single-user system)
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON briefings FOR ALL USING (true) WITH CHECK (true);

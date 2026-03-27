-- ELLIE-1066: Relationship intelligence
CREATE TABLE IF NOT EXISTS person_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_name TEXT NOT NULL,
  aliases TEXT[] DEFAULT '{}',
  meeting_count INT DEFAULT 0,
  last_seen_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  channels TEXT[] DEFAULT '{}',
  top_topics TEXT[] DEFAULT '{}',
  relationship_score FLOAT DEFAULT 0.5,
  previous_score FLOAT,
  score_updated_at TIMESTAMPTZ,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'losing_touch', 'inactive')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(person_name)
);

CREATE INDEX idx_relationships_score ON person_relationships(relationship_score DESC);
CREATE INDEX idx_relationships_status ON person_relationships(status);
CREATE INDEX idx_relationships_last_seen ON person_relationships(last_seen_at DESC);

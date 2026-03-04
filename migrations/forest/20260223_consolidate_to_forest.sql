-- ELLIE-153: Consolidate people/groups/calendar into ellie-forest
-- Moves these tables from Supabase cloud into local Postgres for proper FKs.
-- Run against: psql -U ellie -d ellie-forest

-- ── 1. Extend forest enums ──────────────────────────────────

DO $$ BEGIN
  ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'person';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'group';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'calendar_event';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. People table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS people (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  notes TEXT,
  contact_methods JSONB DEFAULT '{}',
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
CREATE INDEX IF NOT EXISTS idx_people_relationship_type ON people(relationship_type);
CREATE INDEX IF NOT EXISTS idx_people_entity_id ON people(entity_id) WHERE entity_id IS NOT NULL;

-- ── 3. Groups table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS groups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  default_model TEXT,
  metadata JSONB DEFAULT '{}',
  owner_id UUID REFERENCES people(id),
  entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);
CREATE INDEX IF NOT EXISTS idx_groups_owner_id ON groups(owner_id);
CREATE INDEX IF NOT EXISTS idx_groups_entity_id ON groups(entity_id) WHERE entity_id IS NOT NULL;

-- ── 4. Group memberships ────────────────────────────────────

CREATE TABLE IF NOT EXISTS group_memberships (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  owner_id UUID REFERENCES people(id),
  role TEXT DEFAULT 'member',
  access_level TEXT DEFAULT 'full',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_group_memberships_group_id ON group_memberships(group_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_person_id ON group_memberships(person_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_owner_id ON group_memberships(owner_id);

-- ── 5. Calendar events ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  external_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'outlook', 'apple')),
  calendar_id TEXT NOT NULL DEFAULT 'primary',
  calendar_name TEXT NOT NULL DEFAULT '',
  account_label TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '(no title)',
  description TEXT,
  location TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  all_day BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'confirmed',
  recurring BOOLEAN NOT NULL DEFAULT FALSE,
  recurrence_rule TEXT,
  attendees JSONB DEFAULT '[]',
  organizer TEXT,
  meeting_url TEXT,
  color TEXT,
  reminders JSONB DEFAULT '[]',
  raw_data JSONB DEFAULT '{}',
  tree_id UUID REFERENCES trees(id) ON DELETE SET NULL,
  owner_entity_id UUID REFERENCES entities(id) ON DELETE SET NULL,
  last_synced TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_time);
CREATE INDEX IF NOT EXISTS idx_calendar_events_provider ON calendar_events(provider);
CREATE INDEX IF NOT EXISTS idx_calendar_events_tree_id ON calendar_events(tree_id) WHERE tree_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calendar_events_owner_entity ON calendar_events(owner_entity_id) WHERE owner_entity_id IS NOT NULL;

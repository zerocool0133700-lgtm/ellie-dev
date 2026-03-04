-- ELLIE-49: Groups, people, and membership relationships
-- Run against Supabase SQL editor

-- ============================================================
-- GROUPS: Top-level domains (Family, Dev, Business, Social)
-- ============================================================

CREATE TABLE IF NOT EXISTS groups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  default_model TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_groups_name ON groups(name);

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON groups FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- PEOPLE: Everyone Ellie knows about
-- ============================================================

CREATE TABLE IF NOT EXISTS people (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  notes TEXT,
  contact_methods JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_people_name ON people(name);
CREATE INDEX IF NOT EXISTS idx_people_relationship_type ON people(relationship_type);

ALTER TABLE people ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON people FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- GROUP MEMBERSHIPS: Many-to-many linking people to groups
-- ============================================================

CREATE TABLE IF NOT EXISTS group_memberships (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  access_level TEXT DEFAULT 'full',
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(group_id, person_id)
);

CREATE INDEX IF NOT EXISTS idx_group_memberships_group_id ON group_memberships(group_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_person_id ON group_memberships(person_id);

ALTER TABLE group_memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow all" ON group_memberships FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- REALTIME
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE groups;
ALTER PUBLICATION supabase_realtime ADD TABLE people;
ALTER PUBLICATION supabase_realtime ADD TABLE group_memberships;

-- ============================================================
-- SEED DATA
-- ============================================================

INSERT INTO groups (name, description, icon) VALUES
  ('Family', 'Family members and household', '👨‍👩‍👧'),
  ('Dev Group', 'Development team and collaborators', '💻'),
  ('Business', 'Business contacts and partners', '💼'),
  ('Social', 'Friends and social connections', '🎉')
ON CONFLICT (name) DO NOTHING;

INSERT INTO people (name, relationship_type, notes) VALUES
  ('Georgia', 'daughter', 'Dave''s daughter');

INSERT INTO group_memberships (group_id, person_id)
SELECT g.id, p.id FROM groups g, people p
WHERE g.name = 'Family' AND p.name = 'Georgia'
ON CONFLICT (group_id, person_id) DO NOTHING;

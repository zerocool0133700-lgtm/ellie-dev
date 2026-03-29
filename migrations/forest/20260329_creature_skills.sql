-- creature_skills: the toolbox
CREATE TABLE IF NOT EXISTS creature_skills (
  creature_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (creature_id, skill_name)
);

CREATE INDEX idx_creature_skills_creature ON creature_skills(creature_id);
CREATE INDEX idx_creature_skills_skill ON creature_skills(skill_name);

-- archetype_default_skills: reference table for bootstrapping
CREATE TABLE IF NOT EXISTS archetype_default_skills (
  archetype TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  PRIMARY KEY (archetype, skill_name)
);

-- ELLIE-54: Add output_schema to skills for pipeline step output formatting
-- Optional JSON Schema defining expected output format when a skill is used as a pipeline step.
-- NULL means free-form text output (default behavior).

ALTER TABLE skills ADD COLUMN IF NOT EXISTS output_schema JSONB DEFAULT NULL;

COMMENT ON COLUMN skills.output_schema IS
  'Optional JSON Schema defining the expected output format when this skill is used as a pipeline step. NULL means free-form text output.';

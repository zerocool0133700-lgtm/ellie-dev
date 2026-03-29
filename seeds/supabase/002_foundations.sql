-- 002_foundations.sql
-- Seeds two foundations: software-dev (active) and life-management (inactive)
-- Re-runnable: deletes existing rows by name before inserting

DELETE FROM foundations WHERE name IN ('software-dev', 'life-management');

INSERT INTO foundations (name, description, icon, version, agents, recipes, behavior, active)
VALUES
(
  'software-dev',
  'Software development foundation — seven-agent team covering coding, critique, research, strategy, ops, content, and finance.',
  'code-bracket',
  1,
  '[
    {
      "name": "james",
      "role": "developer",
      "model": "claude-sonnet-4-6",
      "tools": [
        "read", "write", "edit", "glob", "grep",
        "bash_builds", "bash_tests", "systemctl",
        "plane_mcp", "forest_bridge_read", "forest_bridge_write",
        "git", "supabase_mcp", "psql_forest"
      ]
    },
    {
      "name": "brian",
      "role": "critic",
      "model": "claude-sonnet-4-6",
      "tools": [
        "read", "glob", "grep",
        "forest_bridge_read", "forest_bridge_write",
        "plane_mcp", "bash_tests", "bash_type_checks"
      ]
    },
    {
      "name": "kate",
      "role": "researcher",
      "model": "claude-sonnet-4-6",
      "tools": [
        "brave_search", "forest_bridge", "qmd_search",
        "google_workspace", "grep_glob_codebase", "memory_extraction"
      ]
    },
    {
      "name": "alan",
      "role": "strategist",
      "model": "claude-sonnet-4-6",
      "tools": [
        "brave_web_search",
        "forest_bridge_read", "forest_bridge_write",
        "qmd_search", "plane_mcp", "miro", "memory_extraction"
      ]
    },
    {
      "name": "jason",
      "role": "ops",
      "model": "claude-sonnet-4-6",
      "tools": [
        "bash_systemctl", "bash_journalctl", "bash_process_mgmt",
        "health_endpoint_checks", "log_analysis",
        "forest_bridge_read", "forest_bridge_write",
        "plane_mcp", "github_mcp", "telegram", "google_chat"
      ]
    },
    {
      "name": "amy",
      "role": "content",
      "model": "claude-sonnet-4-6",
      "tools": [
        "google_workspace", "forest_bridge_read",
        "qmd_search", "brave_web_search", "memory_extraction"
      ]
    },
    {
      "name": "marcus",
      "role": "finance",
      "model": "claude-sonnet-4-6",
      "tools": [
        "plane_mcp",
        "forest_bridge_read", "forest_bridge_write",
        "memory_extraction", "transaction_import", "receipt_parsing"
      ]
    }
  ]'::jsonb,
  '[
    {
      "name": "code-review",
      "type": "pipeline",
      "steps": ["james", "brian"]
    },
    {
      "name": "architecture-decision",
      "type": "round-table",
      "participants": ["james", "brian", "alan"]
    },
    {
      "name": "deploy-checklist",
      "type": "pipeline",
      "steps": ["james", "jason"]
    }
  ]'::jsonb,
  '{
    "proactivity": "high",
    "tone": "direct/technical",
    "escalation": "block_and_ask",
    "max_iterations": 10,
    "cost_limits": {
      "per_session_usd": 2.00,
      "per_day_usd": 20.00
    },
    "default_model": "claude-sonnet-4-6"
  }'::jsonb,
  true
),
(
  'life-management',
  'Life management foundation — four-agent team covering habits, scheduling, notes, and daily check-ins.',
  'heart',
  1,
  '[
    {
      "name": "coach",
      "role": "habits",
      "model": "claude-sonnet-4-6",
      "tools": [
        "forest_bridge", "memory_extraction", "plane_mcp"
      ]
    },
    {
      "name": "scheduler",
      "role": "calendar",
      "model": "claude-sonnet-4-6",
      "tools": [
        "google_workspace", "forest_bridge", "memory_extraction"
      ]
    },
    {
      "name": "scribe",
      "role": "notes",
      "model": "claude-sonnet-4-6",
      "tools": [
        "forest_bridge", "forest_bridge_write",
        "qmd_search", "memory_extraction"
      ]
    },
    {
      "name": "buddy",
      "role": "check-ins",
      "model": "claude-haiku-4-5",
      "tools": [
        "forest_bridge", "memory_extraction", "brave_web_search"
      ]
    }
  ]'::jsonb,
  '[
    {
      "name": "morning-routine",
      "type": "pipeline",
      "steps": ["scheduler", "coach"]
    },
    {
      "name": "weekly-review",
      "type": "fan-out",
      "participants": ["coach", "scheduler", "scribe"]
    },
    {
      "name": "habit-check",
      "type": "pipeline",
      "steps": ["coach", "buddy"]
    }
  ]'::jsonb,
  '{
    "proactivity": "medium",
    "tone": "warm/encouraging",
    "escalation": "suggest_and_move_on",
    "max_iterations": 6,
    "cost_limits": {
      "per_session_usd": 1.00,
      "per_day_usd": 10.00
    },
    "default_model": "claude-haiku-4-5"
  }'::jsonb,
  false
);

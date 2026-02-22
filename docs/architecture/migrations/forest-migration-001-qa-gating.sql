-- ============================================================
-- FOREST MIGRATION 001 — QA Gating & Extended Tree Types
-- ============================================================
-- Adds gate creature type, QA gating fields to contribution
-- policies, new tree types for future use cases, and gate
-- event kinds for observability.
-- ============================================================

-- New tree types
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'incident_response';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'onboarding';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'learning';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'automation';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'debate';
ALTER TYPE tree_type ADD VALUE IF NOT EXISTS 'deliverable';

-- Gate creature type
ALTER TYPE creature_type ADD VALUE IF NOT EXISTS 'gate';

-- Gate event kinds
ALTER TYPE event_kind ADD VALUE IF NOT EXISTS 'gate.requested';
ALTER TYPE event_kind ADD VALUE IF NOT EXISTS 'gate.approved';
ALTER TYPE event_kind ADD VALUE IF NOT EXISTS 'gate.rejected';

-- QA gating fields on contribution_policies
ALTER TABLE contribution_policies
  ADD COLUMN IF NOT EXISTS gate_entities UUID[],
  ADD COLUMN IF NOT EXISTS gate_strategy TEXT DEFAULT NULL
    CHECK (gate_strategy IN ('all_must_approve', 'any_can_approve', 'majority'));

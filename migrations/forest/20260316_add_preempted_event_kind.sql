-- Add 'creature.preempted' to event_kind enum
-- The preemption system (creature-preemption.ts) emits this event
-- but it was missing from the enum.
ALTER TYPE event_kind ADD VALUE IF NOT EXISTS 'creature.preempted';

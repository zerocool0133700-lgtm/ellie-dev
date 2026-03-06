-- Add 'preempted' to creature_state enum
-- Required by ELLIE-499 creature preemption system and ELLIE-526 benchmark script
ALTER TYPE creature_state ADD VALUE IF NOT EXISTS 'preempted';

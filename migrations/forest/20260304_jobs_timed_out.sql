-- ELLIE-527: Add timed_out outcome to job tracking
--
-- Adds a distinct 'timed_out' status to the job_status enum so that
-- jobs hitting the subprocess timeout limit are not silently recorded
-- as 'completed'. This enables accurate timeout frequency metrics and
-- regression detection in the benchmark script.
--
-- Background: during ELLIE-526 benchmarking, a dev agent task that timed
-- out at 600s was recorded as completed — a false positive in health metrics.

-- Extend job_status enum with timed_out outcome
-- IF NOT EXISTS prevents errors on repeated migrations
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'timed_out';

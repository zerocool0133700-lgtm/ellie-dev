-- OS Auth — Persistent rate limiting table (ELLIE-1253/1254)
-- Replaces in-memory Map with Postgres-backed sliding window counters.
-- Survives process restarts and supports future multi-instance deployment.

BEGIN;

CREATE TABLE os_rate_limits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL,           -- "<endpoint>:<ip>"
  timestamp   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_os_rate_limits_key_ts ON os_rate_limits (key, timestamp);

-- Automatic cleanup: delete entries older than 1 hour (well beyond any window)
-- via a periodic DELETE. A trigger on INSERT keeps the table bounded.
CREATE OR REPLACE FUNCTION os_rate_limits_cleanup() RETURNS trigger AS $$
BEGIN
  DELETE FROM os_rate_limits WHERE timestamp < now() - interval '1 hour';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fire cleanup every 100th insert (probabilistic, avoids per-row cost)
-- Using a simple modulo on a sequence for probabilistic cleanup
CREATE SEQUENCE os_rate_limits_insert_seq;

CREATE OR REPLACE FUNCTION os_rate_limits_maybe_cleanup() RETURNS trigger AS $$
BEGIN
  IF nextval('os_rate_limits_insert_seq') % 100 = 0 THEN
    DELETE FROM os_rate_limits WHERE timestamp < now() - interval '1 hour';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_os_rate_limits_cleanup
  AFTER INSERT ON os_rate_limits
  FOR EACH ROW EXECUTE FUNCTION os_rate_limits_maybe_cleanup();

COMMIT;

-- ============================================================
-- BRIDGE KEYS SEED DATA
-- ============================================================
-- Populates the bridge_keys table with test/development keys.
-- Used by tests and local development for Forest Bridge API auth.
-- ============================================================

INSERT INTO bridge_keys (
  name,
  collaborator,
  key_hash,
  key_prefix,
  allowed_scopes,
  permissions,
  active
) VALUES
  -- Test key used by tier3/tier4/tier5 tests
  (
    'Test Key',
    'ellie',
    '5e09b5fa109578c27178ca43e53bfa8bd61073c9b611f9f7fdc494dca9208421',
    'bk_d81869ef',
    ARRAY['2', '2/1', '2/2', '2/3', '2/4', 'R', 'R/R'],
    ARRAY['read', 'write'],
    TRUE
  )
ON CONFLICT (key_hash) DO NOTHING;

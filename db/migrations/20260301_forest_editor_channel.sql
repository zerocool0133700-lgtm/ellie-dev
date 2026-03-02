-- ELLIE-400: Forest Editor command bar channel
-- Pre-seeded channel with skill-only mode for the inline Knowledge Tree command bar

INSERT INTO chat_channels (id, name, slug, parent_id, context_mode, token_budget, is_ephemeral, description, icon, sort_order)
VALUES (
  'a0000000-0000-0000-0000-000000000100',
  'Forest Editor', 'forest-editor', NULL,
  'skill-only', 40000, false,
  'Inline command bar for Knowledge Tree editing', 'tree', 999
)
ON CONFLICT (id) DO NOTHING;

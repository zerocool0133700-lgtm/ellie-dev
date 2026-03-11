-- ============================================================
-- ELLIE-667: Example mountain_records rows
-- ============================================================
-- Documents expected payload shapes for message-oriented
-- record types used by the relay and backfill systems.
-- ============================================================

-- Standard message record (real-time ingestion via relay)
INSERT INTO mountain_records (record_type, source_system, external_id, payload, summary, source_timestamp)
VALUES (
  'message',
  'relay',
  'relay:telegram:msg-001',
  '{
    "content": "Hey, can you check the deployment status?",
    "role": "user",
    "channel": "telegram",
    "sender": "dave",
    "conversation_id": "conv-abc-123",
    "metadata": {},
    "backfilled": false
  }'::jsonb,
  'Hey, can you check the deployment status?',
  '2026-03-10T14:30:00Z'
)
ON CONFLICT (source_system, external_id) DO NOTHING;

-- Voice transcript record
INSERT INTO mountain_records (record_type, source_system, external_id, payload, summary, source_timestamp)
VALUES (
  'voice_transcript',
  'relay',
  'relay:telegram:msg-002',
  '{
    "content": "Reminder to myself: update the forest migration before Friday.",
    "role": "user",
    "channel": "telegram",
    "sender": "dave",
    "conversation_id": "conv-abc-123",
    "metadata": {
      "voice_transcript": true,
      "duration_seconds": 8,
      "transcription_provider": "groq"
    },
    "backfilled": false
  }'::jsonb,
  'Reminder to myself: update the forest migration before Friday.',
  '2026-03-10T14:35:00Z'
)
ON CONFLICT (source_system, external_id) DO NOTHING;

-- Contact identity record (from contact seed pipeline)
INSERT INTO mountain_records (record_type, source_system, external_id, payload, summary, source_timestamp)
VALUES (
  'contact_identity',
  'contact-seed',
  'contact:wincy',
  '{
    "display_name": "Wincy",
    "identifiers": [
      {"channel": "telegram", "id": "wincy_tg"},
      {"channel": "email", "id": "wincy@example.com"},
      {"channel": "discord", "id": "wincy#1234"}
    ],
    "sources": ["apple-contacts", "telegram"],
    "merged_from": 2
  }'::jsonb,
  'Wincy — 3 channels (telegram, email, discord)',
  '2026-03-10T10:00:00Z'
)
ON CONFLICT (source_system, external_id) DO NOTHING;

-- Backfilled historical message (imported from Supabase)
INSERT INTO mountain_records (record_type, source_system, external_id, payload, summary, source_timestamp)
VALUES (
  'message',
  'relay',
  'backfill:telegram:hist-msg-500',
  '{
    "content": "What time is the meeting tomorrow?",
    "role": "user",
    "channel": "telegram",
    "sender": "dave",
    "conversation_id": null,
    "metadata": {},
    "backfilled": true
  }'::jsonb,
  'What time is the meeting tomorrow?',
  '2026-01-15T09:22:00Z'
)
ON CONFLICT (source_system, external_id) DO NOTHING;

-- Conversation summary record
INSERT INTO mountain_records (record_type, source_system, external_id, payload, summary, source_timestamp)
VALUES (
  'conversation_summary',
  'relay',
  'summary:conv-abc-123',
  '{
    "conversation_id": "conv-abc-123",
    "channel": "telegram",
    "message_count": 24,
    "participants": ["dave", "ellie"],
    "topics": ["deployment", "forest migration", "friday deadline"],
    "key_decisions": ["Deploy after forest migration is complete"],
    "time_span": {
      "start": "2026-03-10T14:30:00Z",
      "end": "2026-03-10T15:45:00Z"
    }
  }'::jsonb,
  'Telegram conversation: deployment + forest migration (24 messages)',
  '2026-03-10T15:45:00Z'
)
ON CONFLICT (source_system, external_id) DO NOTHING;

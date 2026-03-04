-- ELLIE-472: Discord thread binding system
-- Persists subagent→Discord thread associations so they survive relay restarts.

create table if not exists discord_thread_bindings (
  session_key   text        primary key,
  thread_id     text        not null,
  channel_id    text        not null,
  guild_id      text        not null,
  webhook_id    text        not null,
  webhook_token text        not null,
  agent_label   text        not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

-- Index for expiry cleanup job
create index if not exists discord_thread_bindings_expires_at
  on discord_thread_bindings (expires_at);

-- RLS: relay service role only
alter table discord_thread_bindings enable row level security;

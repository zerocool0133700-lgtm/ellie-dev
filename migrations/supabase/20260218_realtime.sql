-- Enable Supabase Realtime on dashboard-facing tables
-- These tables will broadcast INSERT/UPDATE/DELETE events to connected clients

ALTER PUBLICATION supabase_realtime ADD TABLE messages;
ALTER PUBLICATION supabase_realtime ADD TABLE work_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE todos;
ALTER PUBLICATION supabase_realtime ADD TABLE memory;

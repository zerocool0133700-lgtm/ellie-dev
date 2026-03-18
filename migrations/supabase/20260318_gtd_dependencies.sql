-- ELLIE-885: Task dependencies — directed graph

CREATE TABLE IF NOT EXISTS todo_dependencies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  todo_id UUID NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  depends_on UUID NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (todo_id, depends_on),
  CHECK (todo_id != depends_on)
);

CREATE INDEX IF NOT EXISTS idx_todo_deps_todo ON todo_dependencies(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_deps_depends_on ON todo_dependencies(depends_on);

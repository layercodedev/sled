-- Create default user and permanent session for local app (no login required)
-- Using fixed UUIDs so they're predictable and stable across migrations

INSERT OR IGNORE INTO users (id, email, created_at)
VALUES ('00000000-0000-0000-0000-000000000001', 'local@localhost', datetime('now'));

INSERT OR IGNORE INTO sessions (id, user_id, created_at, expires_at)
VALUES ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', datetime('now'), NULL);

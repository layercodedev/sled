# Durable Object SQLite Migrations

D1 migrations (the numbered .sql files) are run by wrangler and apply to the shared D1 database.

Durable Object storage uses a separate SQLite instance per DO, so migrations must be run inline in the code. See `ensureMessagesTable()` in `src/index.tsx`.

## DO Messages Table Schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  heard INTEGER NOT NULL DEFAULT 0
);
```

## DO Migrations (inline)

### 001 - Add heard column
Added `heard` column to track which messages have been played via TTS.
```sql
ALTER TABLE messages ADD COLUMN heard INTEGER NOT NULL DEFAULT 0
```

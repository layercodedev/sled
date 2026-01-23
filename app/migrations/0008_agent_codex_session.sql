ALTER TABLE agents ADD COLUMN codex_session_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_codex_session_id ON agents(codex_session_id);

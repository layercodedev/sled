-- Add voice selection for TTS
-- Per-agent voice setting and user's default voice preference

-- Add voice column to agents (NULL means use user's default or 'random')
ALTER TABLE agents ADD COLUMN voice TEXT;

-- Add default_voice column to users (NULL means 'random')
ALTER TABLE users ADD COLUMN default_voice TEXT;

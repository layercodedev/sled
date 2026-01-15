-- Add Claude Code support and API key columns
-- Adds agent type column and API key storage for both providers

-- Add type column to agents (defaults to 'gemini' for existing agents)
ALTER TABLE agents ADD COLUMN type TEXT DEFAULT 'gemini';

-- Add API key columns to users table
ALTER TABLE users ADD COLUMN anthropic_api_key TEXT;

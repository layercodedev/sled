-- Add title column to agents for auto-generated conversation summaries
-- Separate from 'name' which is user-provided at creation

ALTER TABLE agents ADD COLUMN title TEXT;

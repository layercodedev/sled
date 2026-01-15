-- Add working directory tracking for local agent processes
ALTER TABLE agents ADD COLUMN workdir TEXT;

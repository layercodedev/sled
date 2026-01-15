-- Add yolo mode for skipping permission prompts
ALTER TABLE agents ADD COLUMN yolo INTEGER DEFAULT 0;

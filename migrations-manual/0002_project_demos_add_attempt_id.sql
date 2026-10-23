-- Migration: Track the current launch attempt on project_demos
ALTER TABLE project_demos ADD COLUMN attempt_id TEXT;
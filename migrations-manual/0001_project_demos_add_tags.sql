-- Migration: Add tags column to project_demos
ALTER TABLE project_demos ADD COLUMN tags TEXT;

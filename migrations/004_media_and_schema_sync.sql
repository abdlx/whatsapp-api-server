-- Migration 004: Add missing columns that the application code expects
-- Run this in the Supabase SQL Editor AFTER migrations 001-003

-- Add media columns to messages table (used by rich message sending)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mimetype VARCHAR(100);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_filename VARCHAR(255);

-- Add proxy and country columns to sessions table (used by ProxyManager)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS proxy_id UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS phone_country_code VARCHAR(4);

-- Index for faster message queries by type
CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(message_type);

-- Index for session restoration queries
CREATE INDEX IF NOT EXISTS idx_sessions_status_active ON sessions(status) WHERE status IN ('active', 'error');

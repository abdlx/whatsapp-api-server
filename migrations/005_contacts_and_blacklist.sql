-- Migration 005: Contacts & Blacklist Support

-- Contact cache table (for bulk check results)
CREATE TABLE IF NOT EXISTS contact_cache (
    phone_number VARCHAR(20) PRIMARY KEY,
    exists_on_whatsapp BOOLEAN DEFAULT false,
    checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Blacklist table: per-session blocking
CREATE TABLE IF NOT EXISTS blacklist (
    session_id VARCHAR(50) REFERENCES sessions(id) ON DELETE CASCADE,
    phone_number VARCHAR(20) NOT NULL,
    reason TEXT,
    blocked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (session_id, phone_number)
);

-- Index for session lookups
CREATE INDEX IF NOT EXISTS idx_blacklist_session ON blacklist(session_id);

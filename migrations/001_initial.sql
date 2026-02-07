-- Supabase SQL Migration
-- Run this in the Supabase SQL Editor

-- Sessions table: tracks all WhatsApp connections
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(50) PRIMARY KEY,
  agent_name VARCHAR(100) NOT NULL,
  phone_number VARCHAR(20),
  auth_state_backup TEXT, -- Encrypted backup of Baileys auth
  connected_at TIMESTAMP WITH TIME ZONE,
  last_active TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  status VARCHAR(20) DEFAULT 'disconnected',
  daily_message_count INTEGER DEFAULT 0,
  daily_count_reset_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Messages table: full audit trail
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(50) REFERENCES sessions(id) ON DELETE CASCADE,
  recipient VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  message_type VARCHAR(20) DEFAULT 'text',
  sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  delivered_at TIMESTAMP WITH TIME ZONE,
  read_at TIMESTAMP WITH TIME ZONE,
  status VARCHAR(20) DEFAULT 'pending',
  error_message TEXT,
  metadata JSONB
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

-- RPC function to increment message count atomically
CREATE OR REPLACE FUNCTION increment_message_count(session_id VARCHAR)
RETURNS void AS $$
BEGIN
  UPDATE sessions
  SET daily_message_count = daily_message_count + 1,
      last_active = NOW()
  WHERE id = session_id;
END;
$$ LANGUAGE plpgsql;

-- RLS Policies (enable as needed)
-- ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

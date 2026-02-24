-- Create sessions table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    status TEXT DEFAULT 'offline',
    phone_number TEXT,
    last_active TIMESTAMPTZ,
    daily_message_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create messages table (also needed)
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS (Row Level Security) but allow service role full access
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Create policies for service role (your API uses service role key)
CREATE POLICY "Service role has full access to sessions" ON sessions
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to messages" ON messages
    FOR ALL USING (true) WITH CHECK (true);
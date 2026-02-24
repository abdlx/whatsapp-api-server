-- New: proxy pool table
CREATE TABLE IF NOT EXISTS proxies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT,
    password TEXT,
    country_code VARCHAR(5) NOT NULL,   -- 'US', 'PK', 'GB', etc.
    is_active BOOLEAN DEFAULT true,
    assigned_session_id VARCHAR(50),      -- References sessions.id
    last_assigned_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Modified: sessions table — add columns for proxy binding
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS proxy_id UUID REFERENCES proxies(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS phone_country_code VARCHAR(5);

-- Indexes for proxy lookups
CREATE INDEX IF NOT EXISTS idx_proxies_country ON proxies(country_code) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_proxies_assigned ON proxies(assigned_session_id) WHERE assigned_session_id IS NOT NULL;

-- Migration 003: Webhooks Support

-- Webhooks: stores callback endpoints registered by the user
CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(50) REFERENCES sessions(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    -- Comma-separated list of events to subscribe to, e.g. 'message.received,message.delivered'
    -- Leave NULL to receive ALL events
    events TEXT,
    secret TEXT, -- Optional HMAC secret for payload signing
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Webhook delivery logs for auditing and retry tracking
CREATE TABLE IF NOT EXISTS webhook_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id UUID REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL,
    -- Delivery tracking
    status VARCHAR(20) DEFAULT 'pending', -- pending, delivered, failed
    http_status INTEGER,
    response_body TEXT,
    attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_webhooks_session ON webhooks(session_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook ON webhook_logs(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_status ON webhook_logs(status) WHERE status != 'delivered';

-- Add a media_url column to messages table for rich media support
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mimetype TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_filename TEXT;

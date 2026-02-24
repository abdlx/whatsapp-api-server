import { vi } from 'vitest';

// Set dummy env for validation
process.env.SUPABASE_URL = 'https://dummy.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key';
process.env.API_KEY = 'dummy-api-key-at-least-16-chars';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.NODE_ENV = 'test';
process.env.ALLOWED_IPS = '*';

// Mock Supabase
vi.mock('../config/supabase.js', () => ({
    supabase: {
        from: vi.fn(() => ({
            select: vi.fn().mockReturnThis(),
            insert: vi.fn().mockReturnThis(),
            update: vi.fn().mockReturnThis(),
            delete: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: null })),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockReturnThis(),
        })),
    },
}));

// Mock Redis
vi.mock('../config/redis.js', () => ({
    redis: {
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
        setex: vi.fn(),
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(true),
        ttl: vi.fn().mockResolvedValue(60),
        quit: vi.fn(),
        on: vi.fn(),
    },
}));

// Mock BullMQ
vi.mock('bullmq', () => {
    return {
        Queue: class {
            add = vi.fn();
            close = vi.fn();
        },
        Worker: class {
            on = vi.fn();
            close = vi.fn();
        },
    };
});

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    // Supabase
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

    // Redis
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // Security
    API_KEY: z.string().min(16),
    ALLOWED_IPS: z.string().default('127.0.0.1'),

    // Anti-Ban
    MAX_MESSAGES_PER_DAY: z.coerce.number().default(200),
    MIN_DELAY_MS: z.coerce.number().default(3000),
    MAX_DELAY_MS: z.coerce.number().default(8000),
    TYPING_SPEED_MS: z.coerce.number().default(50),

    // Human Behavior Simulation
    DEFAULT_TIMEZONE: z.string().default('UTC'),
    RESPECT_WEEKENDS: z.coerce.boolean().default(false),

    // Contact Protection
    BLOCK_UNSAVED_CONTACTS: z.coerce.boolean().default(false),

    // Monitoring
    ALERT_WEBHOOK_URL: z.string().optional(),

    // Multi-instance networking
    // Set to this pod's internal hostname/IP so the session router can proxy
    // requests to the correct instance when running multiple pods.
    POD_HOST: z.string().default('localhost'),
});

export const env = envSchema.parse(process.env);

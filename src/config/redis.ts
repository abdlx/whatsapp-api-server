import { Redis } from 'ioredis';
import { env } from './env.js';

export const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
});

redis.on('connect', () => {
    console.log('[Redis] Connected');
});

redis.on('error', (err: Error) => {
    console.error('[Redis] Connection error:', err.message);
});

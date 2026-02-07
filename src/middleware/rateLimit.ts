import { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';

interface RateLimitOptions {
    max: number;
    windowMs: number;
    keyPrefix: string;
}

export function createRateLimiter(options: RateLimitOptions) {
    const { max, windowMs, keyPrefix } = options;

    return async function rateLimitMiddleware(
        request: FastifyRequest,
        reply: FastifyReply
    ): Promise<void> {
        const key = `${keyPrefix}:${request.ip}`;
        const windowSeconds = Math.ceil(windowMs / 1000);

        const current = await redis.incr(key);

        if (current === 1) {
            await redis.expire(key, windowSeconds);
        }

        const ttl = await redis.ttl(key);

        reply.header('X-RateLimit-Limit', max);
        reply.header('X-RateLimit-Remaining', Math.max(0, max - current));
        reply.header('X-RateLimit-Reset', Date.now() + ttl * 1000);

        if (current > max) {
            logger.warn({ ip: request.ip, requests: current }, 'Rate limit exceeded');
            reply.status(429).send({
                error: 'Too Many Requests',
                message: `Rate limit exceeded. Try again in ${ttl} seconds.`,
                retryAfter: ttl,
            });
            return;
        }
    };
}

// Pre-configured rate limiters
export const globalRateLimiter = createRateLimiter({
    max: 100,
    windowMs: 60000, // 1 minute
    keyPrefix: 'ratelimit:global',
});

export const messageRateLimiter = createRateLimiter({
    max: 20,
    windowMs: 60000, // 1 minute
    keyPrefix: 'ratelimit:message',
});

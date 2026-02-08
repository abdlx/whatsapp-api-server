import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    const apiKey = request.headers['x-api-key'];

    if (!apiKey || apiKey !== env.API_KEY) {
        logger.warn({ ip: request.ip, path: request.url }, 'Unauthorized request');
        reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or missing API key' });
        return;
    }
}

export async function ipWhitelistMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    const rawAllowedIps = env.ALLOWED_IPS?.trim() || '';

    // Skip whitelist check if not configured, empty, or set to wildcard
    if (!rawAllowedIps || rawAllowedIps === '*' || rawAllowedIps === '0.0.0.0') {
        return;
    }

    const allowedIps = rawAllowedIps.split(',').map((ip) => ip.trim()).filter(Boolean);
    const clientIp = request.ip;

    // Skip whitelist check if only localhost is configured (for development)
    if (allowedIps.length === 1 && allowedIps[0] === '127.0.0.1') {
        return;
    }

    // Check if wildcard is in the list
    if (allowedIps.includes('*') || allowedIps.includes('0.0.0.0')) {
        return;
    }

    if (!allowedIps.includes(clientIp)) {
        logger.warn({ ip: clientIp, path: request.url }, 'IP not whitelisted');
        reply.status(403).send({ error: 'Forbidden', message: 'IP not whitelisted' });
        return;
    }
}

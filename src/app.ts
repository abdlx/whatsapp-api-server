import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { redis } from './config/redis.js';
import { sessionManager } from './core/SessionManager.js';
import { healthMonitor } from './services/HealthMonitor.js';
import { messageWorker } from './services/MessageQueue.js';
import { webhookWorker } from './services/WebhookDispatcher.js';
import { sessionRoutes } from './routes/session.routes.js';
import { messageRoutes } from './routes/message.routes.js';
import { webhookRoutes } from './routes/webhook.routes.js';
import { authMiddleware, ipWhitelistMiddleware } from './middleware/auth.js';
import { globalRateLimiter } from './middleware/rateLimit.js';
import { sessionRouterMiddleware } from './middleware/sessionRouter.js';

// ─── Server ─────────────────────────────────────────────────────────────────

const fastify = Fastify({
    logger: false, // Using custom pino logger
    trustProxy: true,
});

// ─── Swagger API Documentation ───────────────────────────────────────────────

await fastify.register(swagger, {
    openapi: {
        openapi: '3.0.0',
        info: {
            title: 'WhatsApp API Server',
            description: 'Production-grade WhatsApp API server powered by Baileys — featuring anti-ban protection, rich media, webhooks, and multi-instance support.',
            version: '2.0.0',
        },
        tags: [
            { name: 'Sessions', description: 'Manage WhatsApp sessions' },
            { name: 'Messages', description: 'Send and track messages' },
            { name: 'Webhooks', description: 'Register and manage webhook endpoints' },
        ],
        components: {
            securitySchemes: {
                apiKey: {
                    type: 'apiKey',
                    in: 'header',
                    name: 'x-api-key',
                },
            },
        },
        security: [{ apiKey: [] }],
    },
});

await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
    },
    staticCSP: true,
});

// ─── CORS ────────────────────────────────────────────────────────────────────

fastify.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
});

// ─── Auth & Security Middleware ───────────────────────────────────────────────

fastify.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];

    // Public endpoints — skip auth, rate limiting
    if (path === '/health' || path === '/' || path === '/docs' || path.startsWith('/docs/')) {
        return;
    }

    await authMiddleware(request, reply);
    if (reply.sent) return; // Short-circuit if auth rejected

    await ipWhitelistMiddleware(request, reply);
    if (reply.sent) return;

    await globalRateLimiter(request, reply);
    if (reply.sent) return;

    // Multi-instance session routing (proxies to the owning pod if needed)
    await sessionRouterMiddleware(request, reply);
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// Root info endpoint
fastify.get('/', {
    schema: { hide: true } as object,
}, async () => ({
    status: 'ok',
    message: 'WhatsApp API Server is running',
    version: '2.0.0',
    documentation: '/docs',
}));

// Health check (public)
fastify.get('/health', {
    schema: { hide: true } as object,
}, async (_request, reply) => reply.send({
    status: 'ok',
    uptime: process.uptime(),
    activeSessions: sessionManager.getActiveSessionCount(),
    timestamp: new Date().toISOString(),
}));

fastify.register(sessionRoutes);
fastify.register(messageRoutes);
fastify.register(webhookRoutes);

// 404 handler
fastify.setNotFoundHandler((request, reply) => {
    logger.warn({ url: request.url, method: request.method }, '404 Not Found');
    return reply.status(404).send({
        error: 'Not Found',
        message: `Route ${request.method}:${request.url} not found`,
        timestamp: new Date().toISOString(),
    });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function gracefulShutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');

    await fastify.close();
    logger.info('HTTP server closed');

    healthMonitor.stop();

    await messageWorker.close();
    await webhookWorker.close();
    logger.info('Workers stopped');

    await sessionManager.disconnectAll();
    logger.info('WhatsApp sessions disconnected');

    await redis.quit();
    logger.info('Redis connection closed');

    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
    try {
        logger.info('Initializing WhatsApp API Server v2...');

        await sessionManager.restoreAllSessions();
        logger.info('Sessions restored');

        healthMonitor.start();

        await fastify.ready();
        logger.info('Fastify ready — Swagger docs available at /docs');

        const port = env.PORT || 3000;
        const host = '0.0.0.0';

        const address = await fastify.listen({ port, host });
        logger.info({ address, env: env.NODE_ENV, port }, 'WhatsApp API Server v2 started');
    } catch (err) {
        logger.error({ err }, 'Failed to start server');
        process.exit(1);
    }
}

start();

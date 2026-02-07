import Fastify from 'fastify';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { redis } from './config/redis.js';
import { sessionManager } from './core/SessionManager.js';
import { healthMonitor } from './services/HealthMonitor.js';
import { messageWorker } from './services/MessageQueue.js';
import { sessionRoutes } from './routes/session.routes.js';
import { messageRoutes } from './routes/message.routes.js';
import { authMiddleware, ipWhitelistMiddleware } from './middleware/auth.js';
import { globalRateLimiter } from './middleware/rateLimit.js';

const fastify = Fastify({
    logger: false, // Using custom pino logger
    trustProxy: true,
});

// Register middleware
fastify.addHook('onRequest', async (request, reply) => {
    // Skip auth and rate limiting for health check and root
    if (request.url === '/health' || request.url === '/') {
        return;
    }

    await authMiddleware(request, reply);
    await ipWhitelistMiddleware(request, reply);
    await globalRateLimiter(request, reply);
});

// Root route for simple verification
fastify.get('/', async () => {
    return {
        message: 'WhatsApp API Server is running',
        version: '1.0.0',
        documentation: 'https://github.com/abdlx/whatsapp-api-server'
    };
});

// Health check endpoint
fastify.get('/health', async (_request, reply) => {
    return reply.send({
        status: 'ok',
        uptime: process.uptime(),
        activeSessions: sessionManager.getActiveSessionCount(),
        timestamp: new Date().toISOString(),
    });
});


// Register routes
fastify.register(sessionRoutes);
fastify.register(messageRoutes);

// Graceful shutdown handler
async function gracefulShutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Received shutdown signal');

    // Stop accepting new requests
    await fastify.close();
    logger.info('HTTP server closed');

    // Stop health monitor
    healthMonitor.stop();

    // Stop message worker
    await messageWorker.close();
    logger.info('Message worker stopped');

    // Disconnect all WhatsApp sessions
    await sessionManager.disconnectAll();
    logger.info('WhatsApp sessions disconnected');

    // Close Redis
    await redis.quit();
    logger.info('Redis connection closed');

    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start server
async function start(): Promise<void> {
    try {
        // Restore existing sessions
        await sessionManager.restoreAllSessions();

        // Start health monitor
        healthMonitor.start();

        // Start HTTP server
        await fastify.listen({ port: env.PORT, host: '0.0.0.0' });
        logger.info({ port: env.PORT, env: env.NODE_ENV }, 'WhatsApp API Server started');
    } catch (err) {
        logger.error({ err }, 'Failed to start server');
        process.exit(1);
    }
}

start();

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
    const path = request.url.split('?')[0];
    if (path === '/health' || path === '/' || path === '/health/') {
        return;
    }

    await authMiddleware(request, reply);
    await ipWhitelistMiddleware(request, reply);
    await globalRateLimiter(request, reply);
});

// Root route for simple verification
fastify.get('/', async () => {
    return {
        status: 'ok',
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

// Custom 404 handler for debugging
fastify.setNotFoundHandler((request, reply) => {
    logger.warn({
        url: request.url,
        method: request.method,
        headers: request.headers,
    }, '404 Not Found - Route not matched');

    return reply.status(404).send({
        error: 'Not Found',
        message: `Route ${request.method}:${request.url} not found on WhatsApp API Server`,
        timestamp: new Date().toISOString(),
    });
});

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
        logger.info('Initializing WhatsApp API Server...');

        // Restore existing sessions
        await sessionManager.restoreAllSessions();
        logger.info('Sessions restored');

        // Start health monitor
        healthMonitor.start();

        // Register routes (these are fastify.register calls)
        logger.info('Registering routes...');

        // Wait for all plugins/routes to be registered
        await fastify.ready();
        logger.info('Fastify ready (all plugins registered)');

        // Start HTTP server
        const port = env.PORT || 3000;
        const host = '0.0.0.0'; // MUST be 0.0.0.0 for Docker/Coolify

        logger.info({ port, host }, 'Attempting to start HTTP server...');

        const address = await fastify.listen({ port, host });
        logger.info({ address, env: env.NODE_ENV, port, host }, 'WhatsApp API Server started and listening');

        // Print all registered routes for debugging
        logger.info('Registered routes:');
        console.log(fastify.printRoutes());
    } catch (err) {
        logger.error({ err }, 'Failed to start server');
        process.exit(1);
    }
}

start();

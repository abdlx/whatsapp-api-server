import { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import axios from 'axios';

/**
 * Multi-instance session routing middleware.
 *
 * When running multiple server pods, each pod holds a subset of active WA
 * sessions in memory. This middleware transparently proxies requests to the
 * pod that owns the target session, so callers don't need to track which pod
 * holds which session.
 *
 * Redis key: `session:owner:${sessionId}` = JSON { pid, host, port }
 */
export async function sessionRouterMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    // Intercept all session-scoped operations that need an active in-memory socket
    const routedPaths = [
        '/message/send',
        '/message/',      // covers /message/:id status lookup
        '/messages',      // message listing (uses sessionId query)
        '/session/',      // covers /session/:id/status and delete
        '/groups',        // covers all group management endpoints
    ];

    const needsRouting = routedPaths.some((p) => request.url.startsWith(p));
    if (!needsRouting) return;

    // Extract sessionId from body, URL path, or query params
    let sessionId: string | undefined;

    const body = request.body as Record<string, unknown> | undefined;
    if (body?.sessionId) {
        sessionId = String(body.sessionId);
    } else {
        // Extract from URL pattern /session/:id/...
        const match = request.url.match(/^\/session\/([^/?]+)/);
        if (match) sessionId = match[1];
    }

    // Also check query params (group routes and message listing use ?sessionId=...)
    if (!sessionId) {
        const url = new URL(request.url, `http://${request.hostname}`);
        const querySessionId = url.searchParams.get('sessionId');
        if (querySessionId) sessionId = querySessionId;
    }

    if (!sessionId) return;

    // Look up the session owner in Redis
    const ownerRaw = await redis.get(`session:owner:${sessionId}`);
    if (!ownerRaw) return; // Unknown session — let the route handler return 404

    const owner: { pid: number; host: string; port: number } = JSON.parse(ownerRaw);
    const currentHost = process.env.POD_HOST || 'localhost';
    const currentPort = parseInt(process.env.PORT || '3000', 10);

    // If it's us, proceed normally
    if (owner.host === currentHost && owner.port === currentPort) return;

    // Otherwise, proxy to the owning pod
    logger.info(
        { sessionId, ownerHost: owner.host, ownerPort: owner.port },
        'Proxying request to session owner pod'
    );

    try {
        const targetUrl = `http://${owner.host}:${owner.port}${request.url}`;

        const proxyResponse = await axios({
            method: request.method as 'GET' | 'POST' | 'DELETE' | 'PATCH',
            url: targetUrl,
            headers: {
                ...request.headers,
                'X-Forwarded-For': request.ip,
                'X-Proxied-By': currentHost,
            },
            data: request.method !== 'GET' && request.method !== 'DELETE' ? request.body : undefined,
            timeout: 30000,
            validateStatus: () => true, // Forward all HTTP statuses as-is
        });

        reply.status(proxyResponse.status);
        for (const [key, value] of Object.entries(proxyResponse.headers)) {
            if (key.toLowerCase() !== 'content-length') { // let Fastify set this
                reply.header(key, value as string);
            }
        }
        return reply.send(proxyResponse.data);
    } catch (err) {
        logger.error({ sessionId, owner, err }, 'Failed to proxy request to session owner');
        return reply.status(502).send({
            error: 'Bad Gateway',
            message: 'Session owner pod is unreachable. Please retry.',
        });
    }
}

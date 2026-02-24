import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../core/SessionManager.js';
import { logger } from '../utils/logger.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const sessionIdQuery = z.object({
    sessionId: z.string().min(1),
});

const createNewsletterSchema = z.object({
    sessionId: z.string().min(1),
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
});

// ─── Helper ──────────────────────────────────────────────────────────────────

async function getConnectedSocket(sessionId: string) {
    const client = await sessionManager.getSession(sessionId);
    if (!client || client.connectionState !== 'open') {
        throw new Error('Session not found or not connected');
    }
    const socket = client.getSocket();
    if (!socket) throw new Error('Socket not available');
    return socket;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function newsletterRoutes(fastify: FastifyInstance): Promise<void> {

    // ─── Create Newsletter ───────────────────────────────────────────────────
    fastify.post('/newsletters', {
        schema: {
            summary: 'Create a new newsletter (Channel)',
            tags: ['Newsletters'],
            body: {
                type: 'object',
                required: ['sessionId', 'name'],
                properties: {
                    sessionId: { type: 'string' },
                    name: { type: 'string' },
                    description: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = createNewsletterSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const newsletter = await (socket as any).newsletterCreate(body.name, body.description);

            return reply.send({ status: 'ok', newsletter });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Get Newsletter Info ─────────────────────────────────────────────────
    fastify.get<{ Params: { id: string } }>('/newsletters/:id', {
        schema: {
            summary: 'Get newsletter metadata',
            tags: ['Newsletters'],
            querystring: {
                type: 'object',
                required: ['sessionId'],
                properties: { sessionId: { type: 'string' } }
            }
        },
    }, async (request, reply) => {
        try {
            const { sessionId } = sessionIdQuery.parse(request.query);
            const socket = await getConnectedSocket(sessionId);

            const metadata = await (socket as any).newsletterMetadata('invite', request.params.id);

            return reply.send(metadata);
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Follow Newsletter ───────────────────────────────────────────────────
    fastify.post<{ Params: { id: string } }>('/newsletters/:id/follow', {
        schema: {
            summary: 'Follow a newsletter',
            tags: ['Newsletters'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: { sessionId: { type: 'string' } }
            }
        } as object,
    }, async (request, reply) => {
        try {
            const { sessionId } = z.object({ sessionId: z.string() }).parse(request.body);
            const socket = await getConnectedSocket(sessionId);

            await (socket as any).newsletterFollow(request.params.id);

            return reply.send({ status: 'ok', message: 'Followed successfully' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Unfollow Newsletter ─────────────────────────────────────────────────
    fastify.post<{ Params: { id: string } }>('/newsletters/:id/unfollow', {
        schema: {
            summary: 'Unfollow a newsletter',
            tags: ['Newsletters'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: { sessionId: { type: 'string' } }
            }
        } as object,
    }, async (request, reply) => {
        try {
            const { sessionId } = z.object({ sessionId: z.string() }).parse(request.body);
            const socket = await getConnectedSocket(sessionId);

            await (socket as any).newsletterUnfollow(request.params.id);

            return reply.send({ status: 'ok', message: 'Unfollowed successfully' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });
}

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../core/SessionManager.js';
import { logger } from '../utils/logger.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const presenceSchema = z.object({
    sessionId: z.string().min(1),
    presence: z.enum(['available', 'unavailable']),
});

const typingSchema = z.object({
    sessionId: z.string().min(1),
    chatId: z.string().min(1),
    type: z.enum(['composing', 'recording', 'paused']),
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

export async function presenceRoutes(fastify: FastifyInstance): Promise<void> {

    // ─── Set Own Presence (Online/Offline) ──────────────────────────────────
    fastify.put('/presence/me', {
        schema: {
            summary: 'Set own online/offline status',
            tags: ['Presence'],
            body: {
                type: 'object',
                required: ['sessionId', 'presence'],
                properties: {
                    sessionId: { type: 'string' },
                    presence: { type: 'string', enum: ['available', 'unavailable'] },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = presenceSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            await socket.sendPresenceUpdate(body.presence);

            return reply.send({ status: 'ok', presence: body.presence });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Send Typing/Recording Status ────────────────────────────────────────
    fastify.put('/presence/type', {
        schema: {
            summary: 'Send typing or recording indicator to a chat',
            tags: ['Presence'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId', 'type'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string' },
                    type: { type: 'string', enum: ['composing', 'recording', 'paused'] },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = typingSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            await socket.sendPresenceUpdate(body.type as any, body.chatId);

            return reply.send({ status: 'ok', type: body.type });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Subscribe to Presence Updates ───────────────────────────────────────
    fastify.post('/presence/subscribe', {
        schema: {
            summary: 'Subscribe to presence updates for a specific contact',
            tags: ['Presence'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                sessionId: z.string().min(1),
                chatId: z.string().min(1),
            }).parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            await socket.presenceSubscribe(body.chatId);

            return reply.send({ status: 'ok', message: `Subscribed to presence for ${body.chatId}` });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });
}

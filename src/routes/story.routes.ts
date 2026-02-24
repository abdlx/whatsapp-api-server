import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../core/SessionManager.js';
import { logger } from '../utils/logger.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const storySchema = z.object({
    sessionId: z.string().min(1),
    text: z.string().min(1).optional(),
    mediaUrl: z.string().url().optional(),
    mediaBase64: z.string().optional(),
    mediaMimetype: z.string().optional(),
    backgroundColor: z.string().optional(),
    font: z.number().optional(),
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

export async function storyRoutes(fastify: FastifyInstance): Promise<void> {

    // ─── Post Status Update (Story) ──────────────────────────────────────────
    fastify.post('/stories', {
        schema: {
            summary: 'Post a status update (Story)',
            tags: ['Stories'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                    text: { type: 'string' },
                    mediaUrl: { type: 'string', format: 'uri' },
                    backgroundColor: { type: 'string', description: 'Hex color for text status' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = storySchema.parse(request.body);
            const client = await sessionManager.getSession(body.sessionId);
            if (!client) throw new Error('Session not found');

            // Construct outbound structure
            const outbound: any = {
                type: body.mediaUrl || body.mediaBase64 ? 'image' : 'text',
                text: body.text,
                mediaUrl: body.mediaUrl,
                mediaBase64: body.mediaBase64,
                mediaMimetype: body.mediaMimetype,
            };

            // Baileys status JID is 'status@broadcast'
            const statusJid = 'status@broadcast';

            const messageId = await client.sendMessage(statusJid, outbound);

            return reply.send({ status: 'ok', messageId });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });
}

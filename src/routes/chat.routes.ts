import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../core/SessionManager.js';
import { logger } from '../utils/logger.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const sessionIdQuery = z.object({
    sessionId: z.string().min(1),
});

const chatSettingsSchema = z.object({
    sessionId: z.string().min(1),
    pin: z.boolean().optional().describe('Pin or unpin the chat'),
    mute: z.union([z.literal(0), z.number().positive()]).optional().describe('Mute duration in seconds (0 = unmute)'),
    archive: z.boolean().optional().describe('Archive or unarchive the chat'),
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

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {

    // ─── List Chats ──────────────────────────────────────────────────────────
    fastify.get('/chats', {
        schema: {
            summary: 'List all chats for a session',
            tags: ['Chats'],
            querystring: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { sessionId } = sessionIdQuery.parse(request.query);
            const socket = await getConnectedSocket(sessionId);

            const chats = await socket.groupFetchAllParticipating();
            // groupFetchAllParticipating returns groups; combine with store chats if available
            const chatList = Object.values(chats).map((c: any) => ({
                id: c.id,
                name: c.subject || c.name || c.id,
                isGroup: c.id?.endsWith('@g.us') ?? false,
                participantCount: c.participants?.length ?? 0,
                unreadCount: c.unreadCount ?? 0,
            }));

            return reply.send({ count: chatList.length, chats: chatList });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to list chats');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Get Chat ────────────────────────────────────────────────────────────
    fastify.get<{ Params: { chatId: string } }>('/chats/:chatId', {
        schema: {
            summary: 'Get chat metadata',
            tags: ['Chats'],
            querystring: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { sessionId } = sessionIdQuery.parse(request.query);
            const socket = await getConnectedSocket(sessionId);

            const chatId = request.params.chatId.includes('@')
                ? request.params.chatId
                : `${request.params.chatId}@s.whatsapp.net`;

            // Try to fetch group metadata if it's a group
            if (chatId.endsWith('@g.us')) {
                const metadata = await socket.groupMetadata(chatId);
                return reply.send({
                    id: metadata.id,
                    name: metadata.subject,
                    isGroup: true,
                    owner: metadata.owner,
                    desc: metadata.desc,
                    participants: metadata.participants,
                    size: metadata.size ?? metadata.participants?.length ?? 0,
                });
            }

            // For individual chats, return basic info
            const results = await socket.onWhatsApp(chatId.replace('@s.whatsapp.net', ''));
            const result = results?.[0];
            return reply.send({
                id: chatId,
                name: chatId,
                isGroup: false,
                exists: result?.exists ?? false,
            });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to get chat');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Delete Chat ─────────────────────────────────────────────────────────
    fastify.delete<{ Params: { chatId: string } }>('/chats/:chatId', {
        schema: {
            summary: 'Delete a chat',
            tags: ['Chats'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                },
            },
        } as object,
    }, async (request, reply) => {
        try {
            const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.body);
            const socket = await getConnectedSocket(sessionId);

            const chatId = request.params.chatId.includes('@')
                ? request.params.chatId
                : `${request.params.chatId}@s.whatsapp.net`;

            await socket.chatModify({ delete: true, lastMessages: [] }, chatId);

            logger.info({ chatId }, 'Chat deleted');
            return reply.send({ status: 'ok', message: 'Chat deleted' });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to delete chat');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Archive / Unarchive Chat ────────────────────────────────────────────
    fastify.post<{ Params: { chatId: string } }>('/chats/:chatId/archive', {
        schema: {
            summary: 'Archive or unarchive a chat',
            tags: ['Chats'],
            body: {
                type: 'object',
                required: ['sessionId', 'archive'],
                properties: {
                    sessionId: { type: 'string' },
                    archive: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                sessionId: z.string().min(1),
                archive: z.boolean(),
            }).parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const chatId = request.params.chatId.includes('@')
                ? request.params.chatId
                : `${request.params.chatId}@s.whatsapp.net`;

            await socket.chatModify(
                { archive: body.archive, lastMessages: [] },
                chatId
            );

            const action = body.archive ? 'archived' : 'unarchived';
            logger.info({ chatId, action }, `Chat ${action}`);
            return reply.send({ status: 'ok', message: `Chat ${action}` });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to archive chat');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Chat Settings (Pin, Mute) ───────────────────────────────────────────
    fastify.patch<{ Params: { chatId: string } }>('/chats/:chatId/settings', {
        schema: {
            summary: 'Update chat settings (pin, mute)',
            tags: ['Chats'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                    pin: { type: 'boolean' },
                    mute: { type: 'number', description: 'Mute duration in seconds. 0 = unmute.' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = chatSettingsSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const chatId = request.params.chatId.includes('@')
                ? request.params.chatId
                : `${request.params.chatId}@s.whatsapp.net`;

            const actions: string[] = [];

            if (body.pin !== undefined) {
                await socket.chatModify(
                    { pin: body.pin },
                    chatId
                );
                actions.push(body.pin ? 'pinned' : 'unpinned');
            }

            if (body.mute !== undefined) {
                const muteExpiry = body.mute === 0
                    ? 0 // Unmute
                    : Math.floor(Date.now() / 1000) + body.mute;
                await socket.chatModify(
                    { mute: muteExpiry || null } as any,
                    chatId
                );
                actions.push(body.mute === 0 ? 'unmuted' : `muted for ${body.mute}s`);
            }

            logger.info({ chatId, actions }, 'Chat settings updated');
            return reply.send({ status: 'ok', actions });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to update chat settings');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });
}

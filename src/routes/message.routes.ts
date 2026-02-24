import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addMessageToQueue } from '../services/MessageQueue.js';
import { sessionManager } from '../core/SessionManager.js';
import { supabase } from '../config/supabase.js';
import { messageRateLimiter } from '../middleware/rateLimit.js';
import { OutboundMessage } from '../core/WhatsAppClient.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const messageTypeEnum = z.enum([
    'text', 'image', 'video', 'audio', 'document', 'sticker',
    'button', 'list', 'poll', 'location', 'contact',
    'voice', 'gif', 'link_preview', 'live_location', 'contact_list', 'short_video',
]);

const buttonItemSchema = z.object({ id: z.string(), text: z.string() });
const listRowSchema = z.object({ id: z.string(), title: z.string(), description: z.string().optional() });
const listSectionSchema = z.object({ title: z.string(), rows: z.array(listRowSchema).min(1) });

const sendMessageSchema = z.object({
    sessionId: z.string().min(1),
    recipient: z.string().min(7).max(20),
    // Message content
    type: messageTypeEnum.default('text').describe("Message type. Default: 'text'"),
    text: z.string().min(1).max(4096).optional().describe('Text content or caption for media'),
    mediaUrl: z.string().url().optional().describe('Public URL of media to send'),
    mediaBase64: z.string().optional().describe('Base64-encoded media (alternative to mediaUrl)'),
    mediaMimetype: z.string().optional().describe('MIME type (required when using mediaBase64)'),
    filename: z.string().optional().describe('Filename for document messages'),
    caption: z.string().max(1024).optional().describe('Caption for image/video/document'),
    // Button messages
    buttons: z.array(buttonItemSchema).max(3).optional().describe('Up to 3 buttons'),
    footer: z.string().max(60).optional().describe('Footer text for button/list messages'),
    // List messages
    listTitle: z.string().optional().describe('List header title'),
    buttonText: z.string().optional().describe('Button text that opens the list'),
    sections: z.array(listSectionSchema).optional().describe('List sections with rows'),
    // Poll messages
    pollQuestion: z.string().max(256).optional().describe('Poll question text'),
    pollOptions: z.array(z.string()).min(2).max(12).optional().describe('Poll answer options (2-12)'),
    pollSelectCount: z.number().min(0).max(12).optional().describe('Max selectable options (0 = unlimited)'),
    // Location messages
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    locationName: z.string().optional(),
    locationAddress: z.string().optional(),
    // Contact card messages
    contactName: z.string().optional(),
    vcard: z.string().optional(),
    // Voice / Audio
    ptt: z.boolean().optional().describe('Push-to-talk: true = voice bubble, false = audio file'),
    // GIF
    gifPlayback: z.boolean().optional().describe('Send video as GIF (auto-play, no sound)'),
    // Link preview
    previewUrl: z.string().url().optional().describe('URL to generate link preview for'),
    previewTitle: z.string().optional().describe('Custom preview title'),
    previewDescription: z.string().optional().describe('Custom preview description'),
    previewThumbnailUrl: z.string().url().optional().describe('Custom preview thumbnail URL'),
    // Live location
    liveLocationDurationSeconds: z.number().min(60).max(28800).optional().describe('Live location duration (60-28800 seconds)'),
    // Contact list (multi-contact)
    vcards: z.array(z.string()).optional().describe('Array of vCard strings for contact_list'),
    contactNames: z.array(z.string()).optional().describe('Display names for each vCard'),
    // Anti-ban options
    timezone: z.string().optional(),
    respectWeekends: z.boolean().optional(),
    minConversationScore: z.number().min(0).max(100).optional(),
    bypassChecks: z.boolean().optional(),
}).superRefine((data, ctx) => {
    // Type-specific validation
    if (data.type === 'text' && !data.text) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: 'text is required for text messages' });
    }
    const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker', 'voice', 'gif', 'short_video'];
    if (mediaTypes.includes(data.type) && !data.mediaUrl && !data.mediaBase64) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mediaUrl'], message: 'mediaUrl or mediaBase64 is required for media messages' });
    }
    if (data.mediaBase64 && !data.mediaMimetype) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mediaMimetype'], message: 'mediaMimetype is required when using mediaBase64' });
    }
    if (data.type === 'document' && !data.filename) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filename'], message: 'filename is required for document messages' });
    }
    if (data.type === 'button' && (!data.buttons || data.buttons.length === 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['buttons'], message: 'buttons array is required for button messages' });
    }
    if (data.type === 'list' && (!data.sections || data.sections.length === 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sections'], message: 'sections array is required for list messages' });
    }
    if (data.type === 'poll' && (!data.pollQuestion || !data.pollOptions)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pollQuestion'], message: 'pollQuestion and pollOptions are required for poll messages' });
    }
    if ((data.type === 'location' || data.type === 'live_location') && (data.latitude === undefined || data.longitude === undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['latitude'], message: 'latitude and longitude are required for location messages' });
    }
    if (data.type === 'contact' && (!data.contactName || !data.vcard)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contactName'], message: 'contactName and vcard are required for contact messages' });
    }
    if (data.type === 'contact_list' && (!data.vcards || data.vcards.length === 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vcards'], message: 'vcards array is required for contact_list messages' });
    }
    if (data.type === 'link_preview' && !data.previewUrl && !data.text) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['previewUrl'], message: 'previewUrl or text with a URL is required for link_preview messages' });
    }
});

const getMessagesSchema = z.object({
    sessionId: z.string().optional(),
    status: z.enum(['pending', 'sent', 'delivered', 'read', 'failed']).optional(),
    type: messageTypeEnum.optional(),
    limit: z.coerce.number().min(1).max(100).default(50),
    offset: z.coerce.number().min(0).default(0),
});

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function messageRoutes(fastify: FastifyInstance): Promise<void> {

    // ─── Send Message ────────────────────────────────────────────────────────
    fastify.post('/message/send', {
        preHandler: messageRateLimiter,
        schema: {
            summary: 'Send a message (text, media, button, list, poll, location, contact)',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'recipient'],
                properties: {
                    sessionId: { type: 'string' },
                    recipient: { type: 'string', description: 'Phone number in E.164 format (without +)' },
                    type: { type: 'string', enum: ['text', 'image', 'video', 'audio', 'document', 'sticker', 'button', 'list', 'poll', 'location', 'contact', 'voice', 'gif', 'link_preview', 'live_location', 'contact_list', 'short_video'], default: 'text' },
                    text: { type: 'string' },
                    mediaUrl: { type: 'string', format: 'uri' },
                    mediaBase64: { type: 'string' },
                    mediaMimetype: { type: 'string' },
                    filename: { type: 'string' },
                    caption: { type: 'string' },
                    buttons: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } } },
                    footer: { type: 'string' },
                    listTitle: { type: 'string' },
                    buttonText: { type: 'string' },
                    sections: { type: 'array', items: { type: 'object' } },
                    pollQuestion: { type: 'string' },
                    pollOptions: { type: 'array', items: { type: 'string' } },
                    pollSelectCount: { type: 'number' },
                    latitude: { type: 'number' },
                    longitude: { type: 'number' },
                    locationName: { type: 'string' },
                    locationAddress: { type: 'string' },
                    contactName: { type: 'string' },
                    vcard: { type: 'string' },
                    ptt: { type: 'boolean', description: 'Push-to-talk: true = voice bubble' },
                    gifPlayback: { type: 'boolean' },
                    previewUrl: { type: 'string', format: 'uri' },
                    previewTitle: { type: 'string' },
                    previewDescription: { type: 'string' },
                    previewThumbnailUrl: { type: 'string', format: 'uri' },
                    liveLocationDurationSeconds: { type: 'number' },
                    vcards: { type: 'array', items: { type: 'string' } },
                    contactNames: { type: 'array', items: { type: 'string' } },
                    timezone: { type: 'string' },
                    respectWeekends: { type: 'boolean' },
                    bypassChecks: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = sendMessageSchema.parse(request.body);

            const client = await sessionManager.getSession(body.sessionId);
            if (!client || client.connectionState !== 'open') {
                return reply.status(400).send({
                    error: 'Session Unavailable',
                    message: 'Session not found or not connected',
                });
            }

            const outbound: OutboundMessage = {
                type: body.type,
                text: body.text,
                mediaUrl: body.mediaUrl,
                mediaBase64: body.mediaBase64,
                mediaMimetype: body.mediaMimetype,
                filename: body.filename,
                caption: body.caption,
                // Rich types
                buttons: body.buttons,
                footer: body.footer,
                listTitle: body.listTitle,
                buttonText: body.buttonText,
                sections: body.sections,
                pollQuestion: body.pollQuestion,
                pollOptions: body.pollOptions,
                pollSelectCount: body.pollSelectCount,
                latitude: body.latitude,
                longitude: body.longitude,
                locationName: body.locationName,
                locationAddress: body.locationAddress,
                contactName: body.contactName,
                vcard: body.vcard,
                // New types
                ptt: body.ptt,
                gifPlayback: body.gifPlayback,
                previewUrl: body.previewUrl,
                previewTitle: body.previewTitle,
                previewDescription: body.previewDescription,
                previewThumbnailUrl: body.previewThumbnailUrl,
                liveLocationDurationSeconds: body.liveLocationDurationSeconds,
                vcards: body.vcards,
                contactNames: body.contactNames,
            };

            const messageId = await addMessageToQueue(body.sessionId, body.recipient, outbound, {
                timezone: body.timezone,
                respectWeekends: body.respectWeekends,
                minConversationScore: body.minConversationScore,
                bypassChecks: body.bypassChecks,
            });

            return reply.status(202).send({
                messageId,
                status: 'queued',
                message: 'Message added to queue',
            });
        } catch (error: unknown) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            return reply.status(500).send({ error: 'Internal Error', message: (error as Error).message });
        }
    });

    // ─── Get Message Status ──────────────────────────────────────────────────
    fastify.get<{ Params: { id: string } }>('/message/:id', {
        schema: {
            description: 'Get message status by ID',
            tags: ['Messages'],
        } as object,
    }, async (request, reply) => {
        const { data, error } = await supabase.from('messages').select('*').eq('id', request.params.id).single();
        if (error || !data) {
            return reply.status(404).send({ error: 'Not Found', message: 'Message not found' });
        }
        return reply.send(data);
    });

    // ─── List Messages ───────────────────────────────────────────────────────
    fastify.get('/messages', {
        schema: {
            description: 'List messages with optional filters',
            tags: ['Messages'],
        } as object,
    }, async (request, reply) => {
        try {
            const query = getMessagesSchema.parse(request.query);

            let dbQuery = supabase
                .from('messages')
                .select('*')
                .order('sent_at', { ascending: false })
                .range(query.offset, query.offset + query.limit - 1);

            if (query.sessionId) dbQuery = dbQuery.eq('session_id', query.sessionId);
            if (query.status) dbQuery = dbQuery.eq('status', query.status);
            if (query.type) dbQuery = dbQuery.eq('message_type', query.type);

            const { data, error, count } = await dbQuery;

            if (error) {
                return reply.status(500).send({ error: 'Database Error', message: error.message });
            }

            return reply.send({ messages: data, pagination: { limit: query.limit, offset: query.offset, total: count } });
        } catch (error: unknown) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            return reply.status(500).send({ error: 'Internal Error', message: (error as Error).message });
        }
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Message Actions
    // ═══════════════════════════════════════════════════════════════════════════

    const messageActionSchema = z.object({
        sessionId: z.string().min(1),
        chatId: z.string().min(1).describe('Chat JID (e.g. 923001234567@s.whatsapp.net)'),
    });

    // Helper to get socket for message actions
    async function getSocket(sessionId: string) {
        const client = await sessionManager.getSession(sessionId);
        if (!client || client.connectionState !== 'open') throw new Error('Session not found or not connected');
        const socket = client.getSocket();
        if (!socket) throw new Error('Socket not available');
        return socket;
    }

    // ─── Mark as Read ────────────────────────────────────────────────────────
    fastify.put<{ Params: { id: string } }>('/message/:id/read', {
        schema: {
            summary: 'Mark a message as read (sends blue ticks)',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string', description: 'Chat JID the message belongs to' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = messageActionSchema.parse(request.body);
            const socket = await getSocket(body.sessionId);

            await socket.readMessages([{
                remoteJid: body.chatId,
                id: request.params.id,
            }]);

            return reply.send({ status: 'ok', message: 'Message marked as read' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── React to Message ────────────────────────────────────────────────────
    fastify.put<{ Params: { id: string } }>('/message/:id/react', {
        schema: {
            summary: 'React to a message with an emoji',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId', 'emoji'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string' },
                    emoji: { type: 'string', description: 'Emoji to react with (e.g. 👍, ❤️)' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                ...messageActionSchema.shape,
                emoji: z.string().min(1).max(10),
            }).parse(request.body);
            const socket = await getSocket(body.sessionId);

            await socket.sendMessage(body.chatId, {
                react: {
                    text: body.emoji,
                    key: {
                        remoteJid: body.chatId,
                        id: request.params.id,
                    },
                },
            });

            return reply.send({ status: 'ok', message: 'Reaction sent' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Remove Reaction ─────────────────────────────────────────────────────
    fastify.delete<{ Params: { id: string } }>('/message/:id/react', {
        schema: {
            summary: 'Remove reaction from a message',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string' },
                },
            },
        } as object,
    }, async (request, reply) => {
        try {
            const body = messageActionSchema.parse(request.body);
            const socket = await getSocket(body.sessionId);

            await socket.sendMessage(body.chatId, {
                react: {
                    text: '', // Empty = remove reaction
                    key: {
                        remoteJid: body.chatId,
                        id: request.params.id,
                    },
                },
            });

            return reply.send({ status: 'ok', message: 'Reaction removed' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Forward Message ─────────────────────────────────────────────────────
    fastify.post<{ Params: { id: string } }>('/message/:id/forward', {
        schema: {
            summary: 'Forward a message to another chat',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId', 'targetChatId'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string', description: 'Source chat JID' },
                    targetChatId: { type: 'string', description: 'Target chat JID to forward to' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                ...messageActionSchema.shape,
                targetChatId: z.string().min(1),
            }).parse(request.body);
            const socket = await getSocket(body.sessionId);

            // Fetch the original message from the store or construct the key
            const forwardResult = await socket.sendMessage(body.targetChatId, {
                forward: {
                    key: {
                        remoteJid: body.chatId,
                        id: request.params.id,
                    },
                } as any,
            } as any);

            return reply.send({
                status: 'ok',
                message: 'Message forwarded',
                messageId: forwardResult?.key?.id,
            });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Delete Message ──────────────────────────────────────────────────────
    fastify.delete<{ Params: { id: string } }>('/message/:id', {
        schema: {
            summary: 'Delete a message (for me or for everyone)',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string' },
                    forEveryone: { type: 'boolean', description: 'Delete for everyone (default: true)' },
                },
            },
        } as object,
    }, async (request, reply) => {
        try {
            const body = z.object({
                ...messageActionSchema.shape,
                forEveryone: z.boolean().default(true),
            }).parse(request.body);
            const socket = await getSocket(body.sessionId);

            const messageKey = {
                remoteJid: body.chatId,
                id: request.params.id,
            };

            if (body.forEveryone) {
                await socket.sendMessage(body.chatId, { delete: messageKey });
            } else {
                await socket.chatModify(
                    { clear: { messages: [{ id: request.params.id, fromMe: true, timestamp: Date.now() }] } } as any,
                    body.chatId
                );
            }

            return reply.send({ status: 'ok', message: body.forEveryone ? 'Message deleted for everyone' : 'Message deleted for me' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Star Message ────────────────────────────────────────────────────────
    fastify.put<{ Params: { id: string } }>('/message/:id/star', {
        schema: {
            summary: 'Star or unstar a message',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string' },
                    star: { type: 'boolean', description: 'true = star, false = unstar (default: true)' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                ...messageActionSchema.shape,
                star: z.boolean().default(true),
            }).parse(request.body);
            const socket = await getSocket(body.sessionId);

            await socket.chatModify(
                { star: { messages: [{ id: request.params.id, fromMe: true }], star: body.star } },
                body.chatId
            );

            return reply.send({ status: 'ok', message: body.star ? 'Message starred' : 'Message unstarred' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Pin Message ─────────────────────────────────────────────────────────
    fastify.post<{ Params: { id: string } }>('/message/:id/pin', {
        schema: {
            summary: 'Pin a message in a chat',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string' },
                    duration: { type: 'number', description: 'Pin duration in seconds (default: 604800 = 7 days)' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                ...messageActionSchema.shape,
                duration: z.number().default(604800), // 7 days
            }).parse(request.body);
            const socket = await getSocket(body.sessionId);

            await socket.sendMessage(body.chatId, {
                pin: {
                    type: 1, // PIN
                    time: body.duration,
                    key: {
                        remoteJid: body.chatId,
                        id: request.params.id,
                    },
                },
            } as any);

            return reply.send({ status: 'ok', message: 'Message pinned' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Unpin Message ───────────────────────────────────────────────────────
    fastify.delete<{ Params: { id: string } }>('/message/:id/pin', {
        schema: {
            summary: 'Unpin a message',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'chatId'],
                properties: {
                    sessionId: { type: 'string' },
                    chatId: { type: 'string' },
                },
            },
        } as object,
    }, async (request, reply) => {
        try {
            const body = messageActionSchema.parse(request.body);
            const socket = await getSocket(body.sessionId);

            await socket.sendMessage(body.chatId, {
                pin: {
                    type: 2, // UNPIN
                    time: 0,
                    key: {
                        remoteJid: body.chatId,
                        id: request.params.id,
                    },
                },
            } as any);

            return reply.send({ status: 'ok', message: 'Message unpinned' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });
}

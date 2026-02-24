import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addMessageToQueue } from '../services/MessageQueue.js';
import { sessionManager } from '../core/SessionManager.js';
import { supabase } from '../config/supabase.js';
import { messageRateLimiter } from '../middleware/rateLimit.js';
import { OutboundMessage } from '../core/WhatsAppClient.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const messageTypeEnum = z.enum(['text', 'image', 'video', 'audio', 'document', 'sticker']);

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
    if (data.type !== 'text' && !data.mediaUrl && !data.mediaBase64) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mediaUrl'], message: 'mediaUrl or mediaBase64 is required for non-text messages' });
    }
    if (data.mediaBase64 && !data.mediaMimetype) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mediaMimetype'], message: 'mediaMimetype is required when using mediaBase64' });
    }
    if (data.type === 'document' && !data.filename) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filename'], message: 'filename is required for document messages' });
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
            summary: 'Send a message (text or media)',
            tags: ['Messages'],
            body: {
                type: 'object',
                required: ['sessionId', 'recipient'],
                properties: {
                    sessionId: { type: 'string' },
                    recipient: { type: 'string', description: 'Phone number in E.164 format (without +)' },
                    type: { type: 'string', enum: ['text', 'image', 'video', 'audio', 'document', 'sticker'], default: 'text' },
                    text: { type: 'string' },
                    mediaUrl: { type: 'string', format: 'uri' },
                    mediaBase64: { type: 'string' },
                    mediaMimetype: { type: 'string' },
                    filename: { type: 'string' },
                    caption: { type: 'string' },
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
}

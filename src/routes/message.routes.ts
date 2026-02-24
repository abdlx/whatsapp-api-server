import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addMessageToQueue } from '../services/MessageQueue.js';
import { sessionManager } from '../core/SessionManager.js';
import { supabase } from '../config/supabase.js';
import { messageRateLimiter } from '../middleware/rateLimit.js';

const sendMessageSchema = z.object({
    sessionId: z.string().min(1),
    recipient: z.string().min(10).max(20), // Phone number
    message: z.string().min(1).max(4096),
    // Anti-ban options
    timezone: z.string().optional(),
    respectWeekends: z.boolean().optional(),
    minConversationScore: z.number().min(0).max(100).optional(),
    bypassChecks: z.boolean().optional(), // ⚠️ Use only for testing
});

const getMessagesSchema = z.object({
    sessionId: z.string().optional(),
    status: z.enum(['pending', 'sent', 'delivered', 'read', 'failed']).optional(),
    limit: z.coerce.number().min(1).max(100).default(50),
    offset: z.coerce.number().min(0).default(0),
});

export async function messageRoutes(fastify: FastifyInstance): Promise<void> {
    // Send a message (queued)
    fastify.post('/message/send', { preHandler: messageRateLimiter }, async (request, reply) => {
        try {
            const body = sendMessageSchema.parse(request.body);

            // Verify session exists and is connected
            const client = await sessionManager.getSession(body.sessionId);
            if (!client || client.connectionState !== 'open') {
                return reply.status(400).send({
                    error: 'Session Unavailable',
                    message: 'Session not found or not connected',
                });
            }

            // Add to queue
            const messageId = await addMessageToQueue(body.sessionId, body.recipient, body.message);

            return reply.status(202).send({
                messageId,
                status: 'queued',
                message: 'Message added to queue',
            });
        } catch (error: unknown) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            const err = error as Error;
            return reply.status(500).send({ error: 'Internal Error', message: err.message });
        }
    });

    // Get message status
    fastify.get<{ Params: { id: string } }>('/message/:id', async (request, reply) => {
        const { id } = request.params;

        const { data, error } = await supabase.from('messages').select('*').eq('id', id).single();

        if (error || !data) {
            return reply.status(404).send({ error: 'Not Found', message: 'Message not found' });
        }

        return reply.send(data);
    });

    // List messages with filters
    fastify.get('/messages', async (request, reply) => {
        try {
            const query = getMessagesSchema.parse(request.query);

            let dbQuery = supabase
                .from('messages')
                .select('*')
                .order('sent_at', { ascending: false })
                .range(query.offset, query.offset + query.limit - 1);

            if (query.sessionId) {
                dbQuery = dbQuery.eq('session_id', query.sessionId);
            }
            if (query.status) {
                dbQuery = dbQuery.eq('status', query.status);
            }

            const { data, error, count } = await dbQuery;

            if (error) {
                return reply.status(500).send({ error: 'Database Error', message: error.message });
            }

            return reply.send({
                messages: data,
                pagination: {
                    limit: query.limit,
                    offset: query.offset,
                    total: count,
                },
            });
        } catch (error: unknown) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            const err = error as Error;
            return reply.status(500).send({ error: 'Internal Error', message: err.message });
        }
    });
}

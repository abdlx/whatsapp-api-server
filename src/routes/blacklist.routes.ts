import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../core/SessionManager.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const blockSchema = z.object({
    sessionId: z.string().min(1),
    phone: z.string().min(7).max(20),
    reason: z.string().optional(),
});

const sessionIdQuery = z.object({
    sessionId: z.string().min(1),
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

export async function blacklistRoutes(fastify: FastifyInstance): Promise<void> {

    // ─── List Blacklist ──────────────────────────────────────────────────────
    fastify.get('/blacklist', {
        schema: {
            summary: 'List all blocked numbers for a session',
            tags: ['Blacklist'],
            querystring: {
                type: 'object',
                required: ['sessionId'],
                properties: { sessionId: { type: 'string' } }
            }
        },
    }, async (request, reply) => {
        try {
            const { sessionId } = sessionIdQuery.parse(request.query);

            const { data, error } = await supabase
                .from('blacklist')
                .select('*')
                .eq('session_id', sessionId)
                .order('blocked_at', { ascending: false });

            if (error) throw error;

            return reply.send({ count: data.length, blacklist: data });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Block User ──────────────────────────────────────────────────────────
    fastify.post('/blacklist', {
        schema: {
            summary: 'Block a user on WhatsApp and add to blacklist',
            tags: ['Blacklist'],
            body: {
                type: 'object',
                required: ['sessionId', 'phone'],
                properties: {
                    sessionId: { type: 'string' },
                    phone: { type: 'string' },
                    reason: { type: 'string' },
                }
            }
        },
    }, async (request, reply) => {
        try {
            const body = blockSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const jid = body.phone.includes('@') ? body.phone : `${body.phone}@s.whatsapp.net`;

            // Block on WhatsApp
            await socket.updateBlockStatus(jid, 'block');

            // Record in database
            await supabase.from('blacklist').upsert({
                session_id: body.sessionId,
                phone_number: body.phone,
                reason: body.reason || null,
                blocked_at: new Date().toISOString(),
            });

            logger.info({ sessionId: body.sessionId, phone: body.phone }, 'User blocked');
            return reply.send({ status: 'ok', message: 'User blocked' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Unblock User ────────────────────────────────────────────────────────
    fastify.delete<{ Params: { phone: string } }>('/blacklist/:phone', {
        schema: {
            summary: 'Unblock a user on WhatsApp and remove from blacklist',
            tags: ['Blacklist'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' }
                }
            }
        } as object,
    }, async (request, reply) => {
        try {
            const { phone } = request.params as { phone: string };
            const { sessionId } = z.object({ sessionId: z.string() }).parse(request.body);
            const socket = await getConnectedSocket(sessionId);

            const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

            // Unblock on WhatsApp
            await socket.updateBlockStatus(jid, 'unblock');

            // Remove from database
            await supabase
                .from('blacklist')
                .delete()
                .eq('session_id', sessionId)
                .eq('phone_number', phone);

            logger.info({ sessionId, phone }, 'User unblocked');
            return reply.send({ status: 'ok', message: 'User unblocked' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });
}

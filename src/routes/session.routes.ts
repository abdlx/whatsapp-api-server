import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../core/SessionManager.js';
import { redis } from '../config/redis.js';
import QRCode from 'qrcode';

const createSessionSchema = z.object({
    agentId: z.string().min(1).max(50),
    agentName: z.string().min(1).max(100),
    phoneNumber: z.string().min(10).max(20), // Required for proxy geo-matching
});

export async function sessionRoutes(fastify: FastifyInstance): Promise<void> {
    // Create a new session
    fastify.post('/session/create', async (request, reply) => {
        try {
            const body = createSessionSchema.parse(request.body);
            const { sessionId, qr } = await sessionManager.createSession(
                body.agentId,
                body.agentName,
                body.phoneNumber
            );

            return reply.status(201).send({
                sessionId,
                status: 'pairing',
                message: qr ? 'Scan QR code to connect' : 'Session initializing',
            });
        } catch (error: unknown) {

            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            const err = error as Error;
            return reply.status(500).send({ error: 'Internal Error', message: err.message });
        }
    });

    // Get QR code for session
    fastify.get<{ Params: { id: string } }>('/session/:id/qr', async (request, reply) => {
        const { id } = request.params;

        const qr = await redis.get(`qr:${id}`);
        if (!qr) {
            return reply.status(404).send({ error: 'Not Found', message: 'QR code not available or expired' });
        }

        // Generate QR code as data URL
        const qrDataUrl = await QRCode.toDataURL(qr);

        return reply.send({
            sessionId: id,
            qr: qrDataUrl,
            expiresIn: 120, // seconds
        });
    });

    // Get session status
    fastify.get<{ Params: { id: string } }>('/session/:id/status', async (request, reply) => {
        const { id } = request.params;

        const status = await sessionManager.getSessionStatus(id);
        if (!status) {
            return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
        }

        return reply.send({
            sessionId: id,
            ...status,
        });
    });

    // Delete session
    fastify.delete<{ Params: { id: string } }>('/session/:id', async (request, reply) => {
        const { id } = request.params;

        try {
            await sessionManager.deleteSession(id);
            return reply.send({ message: 'Session disconnected and deleted' });
        } catch (error: unknown) {
            const err = error as Error;
            return reply.status(500).send({ error: 'Internal Error', message: err.message });
        }
    });

    // List all sessions
    fastify.get('/sessions', async (_request, reply) => {
        const { data, error } = await (await import('../config/supabase.js')).supabase
            .from('sessions')
            .select('id, agent_name, status, phone_number, last_active, daily_message_count')
            .order('created_at', { ascending: false });

        if (error) {
            return reply.status(500).send({ error: 'Database Error', message: error.message });
        }

        return reply.send({
            count: data?.length || 0,
            sessions: data,
        });
    });
}

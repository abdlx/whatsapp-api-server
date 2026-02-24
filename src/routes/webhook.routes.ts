import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

const createWebhookSchema = z.object({
    sessionId: z.string().min(1).optional().nullable(),
    url: z.string().url('Webhook URL must be a valid HTTPS URL'),
    events: z
        .array(z.enum([
            'message.received', 'message.sent', 'message.delivered',
            'message.read', 'message.failed', 'message.revoked', 'message.reaction',
            'session.connected', 'session.disconnected', 'session.qr',
            'call.received', 'group.update',
        ]))
        .optional()
        .describe('Event types to subscribe to. Omit to receive ALL events.'),
    secret: z.string().min(16).optional().describe('HMAC-SHA256 secret for payload signing'),
});

const updateWebhookSchema = createWebhookSchema.partial().extend({
    isActive: z.boolean().optional(),
});

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {

    // ─── Register a Webhook ──────────────────────────────────────────────────
    fastify.post('/webhooks', {
        schema: {
            summary: 'Register a webhook',
            tags: ['Webhooks'],
            body: {
                type: 'object',
                required: ['url'],
                properties: {
                    sessionId: { type: 'string', nullable: true, description: 'Scope to a specific session. Omit to receive events from all sessions.' },
                    url: { type: 'string', format: 'uri' },
                    events: { type: 'array', items: { type: 'string' }, description: 'Specific events to receive. Omit for all events.' },
                    secret: { type: 'string', description: 'Optional HMAC secret for signature verification.' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = createWebhookSchema.parse(request.body);

            const { data, error } = await supabase
                .from('webhooks')
                .insert({
                    session_id: body.sessionId ?? null,
                    url: body.url,
                    events: body.events ? body.events.join(',') : null,
                    secret: body.secret ?? null,
                    is_active: true,
                })
                .select()
                .single();

            if (error) {
                logger.error({ error }, 'Failed to create webhook');
                return reply.status(500).send({ error: 'Database Error', message: error.message });
            }

            logger.info({ webhookId: data.id, url: body.url }, 'Webhook registered');
            return reply.status(201).send(data);
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: err.issues });
            }
            return reply.status(500).send({ error: 'Internal Error', message: (err as Error).message });
        }
    });

    // ─── List Webhooks ───────────────────────────────────────────────────────
    fastify.get('/webhooks', {
        schema: {
            summary: 'List all registered webhooks',
            tags: ['Webhooks'],
            querystring: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Filter by session ID' },
                },
            },
        },
    }, async (request, reply) => {
        const { sessionId } = request.query as { sessionId?: string };

        let query = supabase.from('webhooks').select('*').order('created_at', { ascending: false });
        if (sessionId) {
            query = query.eq('session_id', sessionId);
        }

        const { data, error } = await query;
        if (error) {
            return reply.status(500).send({ error: 'Database Error', message: error.message });
        }

        return reply.send({ count: data.length, webhooks: data });
    });

    // ─── Get Webhook ─────────────────────────────────────────────────────────
    fastify.get<{ Params: { id: string } }>('/webhooks/:id', {
        schema: { summary: 'Get a webhook by ID', tags: ['Webhooks'] },
    }, async (request, reply) => {
        const { data, error } = await supabase
            .from('webhooks')
            .select('*')
            .eq('id', request.params.id)
            .single();

        if (error || !data) {
            return reply.status(404).send({ error: 'Not Found', message: 'Webhook not found' });
        }

        return reply.send(data);
    });

    // ─── Update Webhook ──────────────────────────────────────────────────────
    fastify.patch<{ Params: { id: string } }>('/webhooks/:id', {
        schema: { summary: 'Update a webhook', tags: ['Webhooks'] },
    }, async (request, reply) => {
        try {
            const body = updateWebhookSchema.parse(request.body);

            const { data, error } = await supabase
                .from('webhooks')
                .update({
                    ...(body.url && { url: body.url }),
                    ...(body.events !== undefined && { events: body.events ? body.events.join(',') : null }),
                    ...(body.secret !== undefined && { secret: body.secret }),
                    ...(body.isActive !== undefined && { is_active: body.isActive }),
                    updated_at: new Date().toISOString(),
                })
                .eq('id', request.params.id)
                .select()
                .single();

            if (error || !data) {
                return reply.status(404).send({ error: 'Not Found', message: 'Webhook not found' });
            }

            return reply.send(data);
        } catch (err) {
            if (err instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: err.issues });
            }
            return reply.status(500).send({ error: 'Internal Error', message: (err as Error).message });
        }
    });

    // ─── Delete Webhook ──────────────────────────────────────────────────────
    fastify.delete<{ Params: { id: string } }>('/webhooks/:id', {
        schema: { summary: 'Delete a webhook', tags: ['Webhooks'] },
    }, async (request, reply) => {
        const { error } = await supabase
            .from('webhooks')
            .delete()
            .eq('id', request.params.id);

        if (error) {
            return reply.status(500).send({ error: 'Database Error', message: error.message });
        }

        return reply.send({ message: 'Webhook deleted successfully' });
    });

    // ─── Get Webhook Delivery Logs ───────────────────────────────────────────
    fastify.get<{ Params: { id: string } }>('/webhooks/:id/logs', {
        schema: { summary: 'Get delivery logs for a webhook', tags: ['Webhooks'] },
    }, async (request, reply) => {
        const { limit = '50', status } = request.query as { limit?: string; status?: string };

        let query = supabase
            .from('webhook_logs')
            .select('*')
            .eq('webhook_id', request.params.id)
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (status) {
            query = query.eq('status', status);
        }

        const { data, error } = await query;
        if (error) {
            return reply.status(500).send({ error: 'Database Error', message: error.message });
        }

        return reply.send({ count: data.length, logs: data });
    });
}

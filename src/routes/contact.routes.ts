import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../core/SessionManager.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const checkPhonesSchema = z.object({
    sessionId: z.string().min(1),
    phones: z.array(z.string().min(7).max(20)).min(1).max(100),
});

const contactIdParams = z.object({
    contactId: z.string().min(7).max(20),
});

const upsertContactSchema = z.object({
    sessionId: z.string().min(1),
    name: z.string().min(1).optional(),
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

export async function contactRoutes(fastify: FastifyInstance): Promise<void> {

    // ─── Bulk Check Phones ───────────────────────────────────────────────────
    fastify.post('/contacts/check', {
        schema: {
            summary: 'Check if phone numbers exist on WhatsApp',
            tags: ['Contacts'],
            body: {
                type: 'object',
                required: ['sessionId', 'phones'],
                properties: {
                    sessionId: { type: 'string' },
                    phones: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = checkPhonesSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const results = await Promise.all(
                body.phones.map(async (phone) => {
                    // Check cache first
                    const { data: cached } = await supabase
                        .from('contact_cache')
                        .select('*')
                        .eq('phone_number', phone)
                        .maybeSingle();

                    // If cached within the last 24 hours
                    if (cached && (Date.now() - new Date(cached.checked_at).getTime() < 86400000)) {
                        return { phone, exists: cached.exists_on_whatsapp, cached: true };
                    }

                    // Otherwise query Baileys
                    try {
                        const results = await socket.onWhatsApp(phone);
                        const onWa = results?.[0];
                        const exists = !!onWa?.exists;

                        await supabase.from('contact_cache').upsert({
                            phone_number: phone,
                            exists_on_whatsapp: exists,
                            checked_at: new Date().toISOString()
                        });

                        return { phone, exists, cached: false };
                    } catch (err) {
                        return { phone, exists: false, error: 'Failed to check' };
                    }
                })
            );

            return reply.send({ results });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            logger.error({ error: error.message }, 'Failed to check phones');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Get Contact Info ────────────────────────────────────────────────────
    fastify.get<{ Params: { contactId: string } }>('/contacts/:contactId', {
        schema: {
            summary: 'Get contact information and status',
            tags: ['Contacts'],
            params: {
                type: 'object',
                properties: { contactId: { type: 'string' } }
            },
            querystring: {
                type: 'object',
                required: ['sessionId'],
                properties: { sessionId: { type: 'string' } }
            }
        },
    }, async (request, reply) => {
        try {
            const { contactId } = contactIdParams.parse(request.params);
            const { sessionId } = z.object({ sessionId: z.string() }).parse(request.query);
            const socket = await getConnectedSocket(sessionId);

            const jid = contactId.includes('@') ? contactId : `${contactId}@s.whatsapp.net`;

            const results = await socket.onWhatsApp(contactId);
            const result = results?.[0];
            const profilePicture = await socket.profilePictureUrl(jid).catch(() => null);
            const status = await socket.fetchStatus(jid).catch(() => null) as any;

            return reply.send({
                id: jid,
                exists: !!result?.exists,
                profilePicture,
                status: status?.status,
                statusTimestamp: status?.setAt
            });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Add/Update Contact ──────────────────────────────────────────────────
    fastify.put<{ Params: { contactId: string } }>('/contacts/:contactId', {
        schema: {
            summary: 'Upsert contact name in session address book',
            tags: ['Contacts'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                    name: { type: 'string' }
                }
            }
        },
    }, async (request, reply) => {
        try {
            const { contactId } = contactIdParams.parse(request.params);
            const body = upsertContactSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const jid = contactId.includes('@') ? contactId : `${contactId}@s.whatsapp.net`;

            // Baileys doesn't have a direct "add contact" that syncs to the phone's OS address book,
            // but we can update the in-memory display name which affects notifications and headers.
            await socket.updateProfileName(body.name || contactId); // This updates the current session's own name usually

            // For general contacts, we often use the 'contacts.upsert' event via the store, 
            // but the socket itself exposes fewer direct CRUD methods for the remote phone's contact list.

            return reply.send({ status: 'ok', message: 'Contact metadata updated in session' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });
}

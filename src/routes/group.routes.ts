import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sessionManager } from '../core/SessionManager.js';
import { logger } from '../utils/logger.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const sessionIdQuery = z.object({
    sessionId: z.string().min(1),
});

const createGroupSchema = z.object({
    sessionId: z.string().min(1),
    subject: z.string().min(1).max(100),
    participants: z.array(z.string().min(7).max(20)).min(1),
});

const participantsSchema = z.object({
    sessionId: z.string().min(1),
    participants: z.array(z.string().min(7).max(20)).min(1),
});

const updateGroupSchema = z.object({
    sessionId: z.string().min(1),
    subject: z.string().min(1).max(100).optional(),
    description: z.string().max(512).optional(),
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

export async function groupRoutes(fastify: FastifyInstance): Promise<void> {

    // ─── List Joined Groups ──────────────────────────────────────────────────
    fastify.get('/groups', {
        schema: {
            summary: 'List all joined groups for a session',
            tags: ['Groups'],
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

            const groups = await socket.groupFetchAllParticipating();
            const groupList = Object.values(groups).map((g: any) => ({
                id: g.id,
                subject: g.subject,
                owner: g.owner,
                creation: g.creation,
                size: g.size ?? g.participants?.length ?? 0,
                desc: g.desc ?? null,
            }));

            return reply.send({ count: groupList.length, groups: groupList });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to list groups');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Create Group ────────────────────────────────────────────────────────
    fastify.post('/groups', {
        schema: {
            summary: 'Create a new WhatsApp group',
            tags: ['Groups'],
            body: {
                type: 'object',
                required: ['sessionId', 'subject', 'participants'],
                properties: {
                    sessionId: { type: 'string' },
                    subject: { type: 'string' },
                    participants: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = createGroupSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const jids = body.participants.map((p) =>
                p.includes('@') ? p : `${p}@s.whatsapp.net`
            );

            const group = await socket.groupCreate(body.subject, jids);

            logger.info({ groupId: group.id, subject: body.subject }, 'Group created');
            return reply.status(201).send({
                groupId: group.id,
                subject: body.subject,
                participants: group.participants,
            });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to create group');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Get Group Metadata ──────────────────────────────────────────────────
    fastify.get<{ Params: { groupId: string } }>('/groups/:groupId', {
        schema: {
            summary: 'Get group metadata',
            tags: ['Groups'],
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

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            const metadata = await socket.groupMetadata(groupId);

            return reply.send({
                id: metadata.id,
                subject: metadata.subject,
                owner: metadata.owner,
                creation: metadata.creation,
                desc: metadata.desc,
                descId: metadata.descId,
                participants: metadata.participants,
                size: metadata.size ?? metadata.participants?.length ?? 0,
            });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to get group metadata');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Add Participants ────────────────────────────────────────────────────
    fastify.post<{ Params: { groupId: string } }>('/groups/:groupId/participants', {
        schema: {
            summary: 'Add participants to a group',
            tags: ['Groups'],
            body: {
                type: 'object',
                required: ['sessionId', 'participants'],
                properties: {
                    sessionId: { type: 'string' },
                    participants: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = participantsSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            const jids = body.participants.map((p) =>
                p.includes('@') ? p : `${p}@s.whatsapp.net`
            );

            const result = await socket.groupParticipantsUpdate(groupId, jids, 'add');

            logger.info({ groupId, added: jids.length }, 'Participants added');
            return reply.send({ status: 'ok', result });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to add participants');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Remove Participants ─────────────────────────────────────────────────
    fastify.delete<{ Params: { groupId: string } }>('/groups/:groupId/participants', {
        schema: {
            summary: 'Remove participants from a group',
            tags: ['Groups'],
            body: {
                type: 'object',
                required: ['sessionId', 'participants'],
                properties: {
                    sessionId: { type: 'string' },
                    participants: { type: 'array', items: { type: 'string' } },
                },
            },
        } as object,
    }, async (request, reply) => {
        try {
            const body = participantsSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            const jids = body.participants.map((p) =>
                p.includes('@') ? p : `${p}@s.whatsapp.net`
            );

            const result = await socket.groupParticipantsUpdate(groupId, jids, 'remove');

            logger.info({ groupId, removed: jids.length }, 'Participants removed');
            return reply.send({ status: 'ok', result });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to remove participants');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Update Group Subject / Description ──────────────────────────────────
    fastify.patch<{ Params: { groupId: string } }>('/groups/:groupId', {
        schema: {
            summary: 'Update group subject or description',
            tags: ['Groups'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                    subject: { type: 'string' },
                    description: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = updateGroupSchema.parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            if (body.subject) {
                await socket.groupUpdateSubject(groupId, body.subject);
            }
            if (body.description !== undefined) {
                await socket.groupUpdateDescription(groupId, body.description);
            }

            logger.info({ groupId, subject: body.subject, description: body.description }, 'Group updated');
            return reply.send({ status: 'ok', message: 'Group updated' });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to update group');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Leave Group ─────────────────────────────────────────────────────────
    fastify.post<{ Params: { groupId: string } }>('/groups/:groupId/leave', {
        schema: {
            summary: 'Leave a group',
            tags: ['Groups'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(request.body);
            const socket = await getConnectedSocket(sessionId);

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            await socket.groupLeave(groupId);

            logger.info({ groupId }, 'Left group');
            return reply.send({ status: 'ok', message: 'Left group successfully' });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to leave group');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Get Invite Link ─────────────────────────────────────────────────────
    fastify.get<{ Params: { groupId: string } }>('/groups/:groupId/invite', {
        schema: {
            summary: 'Get group invite link',
            tags: ['Groups'],
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

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            const code = await socket.groupInviteCode(groupId);

            return reply.send({
                inviteCode: code,
                inviteLink: `https://chat.whatsapp.com/${code}`,
            });
        } catch (error: any) {
            if (error instanceof z.ZodError) {
                return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            }
            logger.error({ error: error.message }, 'Failed to get invite link');
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Revoke Invite Link ──────────────────────────────────────────────────
    fastify.delete<{ Params: { groupId: string } }>('/groups/:groupId/invite', {
        schema: {
            summary: 'Revoke group invite link',
            tags: ['Groups'],
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

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            const code = await socket.groupRevokeInvite(groupId);

            return reply.send({ status: 'ok', message: 'Invite link revoked', newCode: code });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Join Group via Link ─────────────────────────────────────────────────
    fastify.post('/groups/join', {
        schema: {
            summary: 'Join a group via invite link',
            tags: ['Groups'],
            body: {
                type: 'object',
                required: ['sessionId', 'inviteLink'],
                properties: {
                    sessionId: { type: 'string' },
                    inviteLink: { type: 'string', description: 'Full invite link or just the code' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                sessionId: z.string().min(1),
                inviteLink: z.string().min(1),
            }).parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const code = body.inviteLink.split('/').pop() || '';
            const groupId = await socket.groupAcceptInvite(code);

            return reply.send({ status: 'ok', message: 'Joined group', groupId });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Admin Management (Promote/Demote) ──────────────────────────────────
    fastify.put<{ Params: { groupId: string } }>('/groups/:groupId/admin', {
        schema: {
            summary: 'Promote or demote group participants',
            tags: ['Groups'],
            body: {
                type: 'object',
                required: ['sessionId', 'participants', 'action'],
                properties: {
                    sessionId: { type: 'string' },
                    participants: { type: 'array', items: { type: 'string' } },
                    action: { type: 'string', enum: ['promote', 'demote'] },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                sessionId: z.string().min(1),
                participants: z.array(z.string().min(1)),
                action: z.enum(['promote', 'demote']),
            }).parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            const jids = body.participants.map(p => p.includes('@') ? p : `${p}@s.whatsapp.net`);

            await socket.groupParticipantsUpdate(groupId, jids, body.action);

            return reply.send({ status: 'ok', message: `Participants ${body.action}d` });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Set Group Icon ──────────────────────────────────────────────────────
    fastify.put<{ Params: { groupId: string } }>('/groups/:groupId/icon', {
        schema: {
            summary: 'Set group profile picture',
            tags: ['Groups'],
            body: {
                type: 'object',
                required: ['sessionId', 'imageUrl'],
                properties: {
                    sessionId: { type: 'string' },
                    imageUrl: { type: 'string', format: 'uri' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                sessionId: z.string().min(1),
                imageUrl: z.string().url(),
            }).parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            await socket.updateProfilePicture(groupId, { url: body.imageUrl });

            return reply.send({ status: 'ok', message: 'Group icon updated' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });

    // ─── Set Group Settings ──────────────────────────────────────────────────
    fastify.put<{ Params: { groupId: string } }>('/groups/:groupId/settings', {
        schema: {
            summary: 'Update group settings (announcement, locked)',
            tags: ['Groups'],
            body: {
                type: 'object',
                required: ['sessionId'],
                properties: {
                    sessionId: { type: 'string' },
                    announcement: { type: 'boolean', description: 'true = only admins can send messages' },
                    locked: { type: 'boolean', description: 'true = only admins can edit group info' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const body = z.object({
                sessionId: z.string().min(1),
                announcement: z.boolean().optional(),
                locked: z.boolean().optional(),
            }).parse(request.body);
            const socket = await getConnectedSocket(body.sessionId);

            const groupId = request.params.groupId.includes('@')
                ? request.params.groupId
                : `${request.params.groupId}@g.us`;

            if (body.announcement !== undefined) {
                await socket.groupSettingUpdate(groupId, body.announcement ? 'announcement' : 'not_announcement');
            }
            if (body.locked !== undefined) {
                await socket.groupSettingUpdate(groupId, body.locked ? 'locked' : 'unlocked');
            }

            return reply.send({ status: 'ok', message: 'Group settings updated' });
        } catch (error: any) {
            if (error instanceof z.ZodError) return reply.status(400).send({ error: 'Validation Error', details: error.issues });
            return reply.status(500).send({ error: 'Internal Error', message: error.message });
        }
    });
}

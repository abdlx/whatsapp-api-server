import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { fastify } from '../../app.js';
import { sessionManager } from '../../core/SessionManager.js';

vi.mock('../../core/SessionManager.js', () => ({
    sessionManager: {
        getSession: vi.fn(),
    },
}));

describe('Message Integration Routes', () => {
    beforeEach(async () => {
        await fastify.ready();
        vi.clearAllMocks();
    });

    it('should send a text message through the API', async () => {
        const mockClient = {
            connectionState: 'open',
            sendMessage: vi.fn().mockResolvedValue('msg-id-123'),
        };
        // Mock the queue behavior if needed, but here we're testing the route handler
        // In our implementation, /message/send calls addMessageToQueue which returns a messageId

        // Actually, we need to mock addMessageToQueue if we want to avoid side effects
        // But for simplicity of this test, let's just mock getSession if it's used directly

        (sessionManager.getSession as any).mockResolvedValue(mockClient);

        const response = await request(fastify.server)
            .post('/message/send')
            .set('x-api-key', 'dummy-api-key-at-least-16-chars')
            .send({
                sessionId: 'test-session',
                recipient: '1234567890',
                type: 'text',
                text: 'hello integration',
            });

        if (response.status !== 202) console.error(response.body);
        expect(response.status).toBe(202);
        expect(response.body).toEqual({
            status: 'queued',
            message: 'Message added to queue',
            messageId: expect.any(String),
        });
    });

    it('should return 401 if API key is missing', async () => {
        const response = await request(fastify.server)
            .post('/message/send')
            .send({
                sessionId: 'test-session',
                recipient: '1234567890',
                type: 'text',
                text: 'fail',
            });

        expect(response.status).toBe(401);
    });

    it('should return 400 for invalid message type', async () => {
        const response = await request(fastify.server)
            .post('/message/send')
            .set('x-api-key', 'dummy-api-key-at-least-16-chars')
            .send({
                sessionId: 'test-session',
                recipient: '1234567890',
                type: 'invalid-type',
                text: 'fail',
            });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('Bad Request');
    });
});

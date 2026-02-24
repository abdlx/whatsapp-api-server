import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../config/redis.js';
import { sessionManager } from '../core/SessionManager.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { OutboundMessage, SendOptions } from '../core/WhatsAppClient.js';

// ─── Job Interface ────────────────────────────────────────────────────────────

interface MessageJob {
    sessionId: string;
    recipient: string;
    outbound: OutboundMessage;
    messageId?: string;
    options?: SendOptions;
}

const QUEUE_NAME = 'whatsapp-messages';

// ─── Queue ────────────────────────────────────────────────────────────────────

export const messageQueue = new Queue<MessageJob>(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
        attempts: 10,
        backoff: {
            type: 'exponential',
            delay: 10000,
        },
        removeOnComplete: 100,
        removeOnFail: 1000,
    },
});

// ─── Worker ───────────────────────────────────────────────────────────────────

export const messageWorker = new Worker<MessageJob>(
    QUEUE_NAME,
    async (job: Job<MessageJob>) => {
        const { sessionId, recipient, outbound, messageId, options } = job.data;

        // Per-session lock — ensures only one message per session is processed at a time
        // while allowing different sessions to process in parallel
        const lockKey = `queue:lock:${sessionId}`;
        // Lock TTL must exceed max break duration (10 min) + max delay (~45s) + buffer
        const acquired = await redis.set(lockKey, job.id ?? '1', 'EX', 15 * 60, 'NX');
        if (!acquired) {
            // Another job for this session is in progress — throw to let BullMQ retry
            throw new Error(`Session ${sessionId} busy — will retry`);
        }

        logger.info({ jobId: job.id, sessionId, recipient, type: outbound.type }, 'Processing message job');

        try {
            const client = await sessionManager.getSession(sessionId);
            if (!client) {
                throw new Error(`Session ${sessionId} not found`);
            }

            if (client.connectionState !== 'open') {
                throw new Error(`Session ${sessionId} not connected`);
            }

            const sentMessageId = await client.sendMessage(recipient, outbound, options);

            if (messageId) {
                await supabase
                    .from('messages')
                    .update({ status: 'sent', sent_at: new Date().toISOString() })
                    .eq('id', messageId);
            }

            logger.info({ jobId: job.id, messageId: sentMessageId }, 'Message sent successfully');
            return { messageId: sentMessageId };
        } catch (error: any) {
            // Human behavior delays are expected — log and let BullMQ retry
            if (error.message?.includes('scheduled for later')) {
                logger.info({ jobId: job.id, reason: error.message }, 'Message rescheduled due to human behavior patterns');
            }
            throw error;
        } finally {
            // Always release the per-session lock
            await redis.del(lockKey);
        }
    },
    {
        connection: redis,
        concurrency: 20, // Process up to 20 sessions in parallel (one per session via lock)
    }
);

// ─── Worker Event Handlers ────────────────────────────────────────────────────

messageWorker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Message job completed');
});

messageWorker.on('failed', async (job, error) => {
    if (!job) return;
    logger.error({ jobId: job.id, error: error.message }, 'Message job failed');

    if (job.data.messageId) {
        await supabase
            .from('messages')
            .update({ status: 'failed', error_message: error.message })
            .eq('id', job.data.messageId);
    }
});

// ─── Queue Helper ─────────────────────────────────────────────────────────────

export async function addMessageToQueue(
    sessionId: string,
    recipient: string,
    outbound: OutboundMessage,
    options?: SendOptions
): Promise<string> {
    const messageId = crypto.randomUUID();

    // Create pending record in DB (audit trail before any send attempt)
    await supabase.from('messages').insert({
        id: messageId,
        session_id: sessionId,
        recipient,
        content: outbound.text ?? outbound.caption ?? `[${outbound.type}]`,
        message_type: outbound.type,
        media_url: outbound.mediaUrl ?? null,
        media_mimetype: outbound.mediaMimetype ?? null,
        media_filename: outbound.filename ?? null,
        status: 'pending',
    });

    await messageQueue.add('send-message', {
        sessionId,
        recipient,
        outbound,
        messageId,
        options,
    });

    logger.info({ messageId, sessionId, recipient, type: outbound.type }, 'Message added to queue');

    return messageId;
}

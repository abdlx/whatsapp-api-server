import { Queue, Worker, Job } from 'bullmq';

import { redis } from '../config/redis.js';
import { sessionManager } from '../core/SessionManager.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

interface MessageJob {
    sessionId: string;
    recipient: string;
    message: string;
    messageId?: string;
    options?: {
        timezone?: string;
        respectWeekends?: boolean;
        minConversationScore?: number;
        bypassChecks?: boolean;
    };
}

const QUEUE_NAME = 'whatsapp-messages';

export const messageQueue = new Queue<MessageJob>(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
        attempts: 10, // Increased attempts for behavior-based retries
        backoff: {
            type: 'exponential',
            delay: 10000,
        },
        removeOnComplete: 100,
        removeOnFail: 1000,
    },
});

export const messageWorker = new Worker<MessageJob>(
    QUEUE_NAME,
    async (job: Job<MessageJob>) => {
        const { sessionId, recipient, message, messageId, options } = job.data;

        logger.info({ jobId: job.id, sessionId, recipient }, 'Processing message job');

        const client = await sessionManager.getSession(sessionId);
        if (!client) {
            throw new Error(`Session ${sessionId} not found`);
        }

        if (client.connectionState !== 'open') {
            throw new Error(`Session ${sessionId} not connected`);
        }

        try {
            const sentMessageId = await client.sendMessageWithTyping(recipient, message, options);

            // Update message record if we have an existing ID
            if (messageId) {
                await supabase
                    .from('messages')
                    .update({ status: 'sent', sent_at: new Date().toISOString() })
                    .eq('id', messageId);
            }

            logger.info({ jobId: job.id, messageId: sentMessageId }, 'Message sent successfully');

            return { messageId: sentMessageId };
        } catch (error: any) {
            // Check for human behavior delays (Active Hours / Weekend checks)
            if (error.message.includes('scheduled for later')) {
                logger.info(
                    { jobId: job.id, reason: error.message },
                    'Message scheduled for retry due to human behavior patterns'
                );
            }

            throw error;
        }

    },
    {
        connection: redis,
        concurrency: 1, // Process one message at a time for anti-ban
    }
);

messageWorker.on('completed', (job) => {
    logger.debug({ jobId: job.id }, 'Message job completed');
});

messageWorker.on('failed', async (job, error) => {
    if (!job) return;

    logger.error({ jobId: job.id, error: error.message }, 'Message job failed');


    // Update message status to failed
    if (job.data.messageId) {
        await supabase
            .from('messages')
            .update({ status: 'failed', error_message: error.message })
            .eq('id', job.data.messageId);
    }
});

export async function addMessageToQueue(
    sessionId: string,
    recipient: string,
    message: string,
    options?: MessageJob['options']
): Promise<string> {
    const messageId = crypto.randomUUID();

    // Create pending message record
    await supabase.from('messages').insert({
        id: messageId,
        session_id: sessionId,
        recipient,
        content: message,
        status: 'pending',
    });

    // Add to queue
    await messageQueue.add('send-message', {
        sessionId,
        recipient,
        message,
        messageId,
        options,
    });

    logger.info({ messageId, sessionId, recipient }, 'Message added to queue');

    return messageId;
}


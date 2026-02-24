import { Queue, Worker, Job } from 'bullmq';
import axios from 'axios';
import crypto from 'crypto';
import { redis } from '../config/redis.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

// ─── Webhook Event Types ──────────────────────────────────────────────────────

export type WebhookEventType =
    | 'message.received'
    | 'message.sent'
    | 'message.delivered'
    | 'message.read'
    | 'message.failed'
    | 'message.revoked'
    | 'message.reaction'
    | 'session.connected'
    | 'session.disconnected'
    | 'session.qr'
    | 'call.received'
    | 'group.update';

export interface WebhookPayload {
    event: WebhookEventType;
    sessionId: string;
    timestamp: string;
    data: Record<string, unknown>;
}

interface WebhookJob {
    webhookId: string;
    webhookUrl: string;
    secret: string | null;
    payload: WebhookPayload;
    logId: string;
}

// ─── Queue Setup ─────────────────────────────────────────────────────────────

const WEBHOOK_QUEUE = 'whatsapp-webhooks';

export const webhookQueue = new Queue<WebhookJob>(WEBHOOK_QUEUE, {
    connection: redis,
    defaultJobOptions: {
        attempts: 7, // Retry up to 7 times
        backoff: {
            type: 'exponential',
            delay: 5000, // 5s, 10s, 20s, 40s, 80s, 160s, 320s
        },
        removeOnComplete: 200,
        removeOnFail: 500,
    },
});

// ─── Worker ──────────────────────────────────────────────────────────────────

export const webhookWorker = new Worker<WebhookJob>(
    WEBHOOK_QUEUE,
    async (job: Job<WebhookJob>) => {
        const { webhookId, webhookUrl, secret, payload, logId } = job.data;

        // Sign payload with HMAC-SHA256 if a secret was provided
        const body = JSON.stringify(payload);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-WhatsApp-Event': payload.event,
            'X-Delivery-Id': logId,
        };

        if (secret) {
            const signature = crypto
                .createHmac('sha256', secret)
                .update(body)
                .digest('hex');
            headers['X-Signature-256'] = `sha256=${signature}`;
        }

        // Attempt delivery
        const response = await axios.post(webhookUrl, body, {
            headers,
            timeout: 15000,
            validateStatus: (status) => status < 500, // Treat 4xx as non-retryable
        });

        // Update log with success
        await supabase
            .from('webhook_logs')
            .update({
                status: 'delivered',
                http_status: response.status,
                response_body: JSON.stringify(response.data).slice(0, 1000),
                attempts: (job.attemptsMade ?? 0) + 1,
                last_attempt_at: new Date().toISOString(),
                delivered_at: new Date().toISOString(),
            })
            .eq('id', logId);

        logger.info({ webhookId, logId, event: payload.event, status: response.status }, 'Webhook delivered');
    },
    { connection: redis, concurrency: 10 }
);

webhookWorker.on('failed', async (job, error) => {
    if (!job) return;
    logger.error({ jobId: job.id, webhookId: job.data.webhookId, error: error.message }, 'Webhook delivery failed');

    const isFinal = (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 7) - 1;

    await supabase
        .from('webhook_logs')
        .update({
            status: isFinal ? 'failed' : 'pending',
            attempts: (job.attemptsMade ?? 0) + 1,
            last_attempt_at: new Date().toISOString(),
        })
        .eq('id', job.data.logId);
});

// ─── Dispatch Helper ─────────────────────────────────────────────────────────

/**
 * Dispatch a normalized webhook event to all registered endpoints for the session.
 * Handles filtering, log creation, and queuing — call this from WhatsAppClient.
 */
export async function dispatchWebhookEvent(payload: WebhookPayload): Promise<void> {
    try {
        // Look up all active webhooks for this session (or global webhooks with no session_id)
        const { data: webhooks } = await supabase
            .from('webhooks')
            .select('id, url, secret, events')
            .or(`session_id.eq.${payload.sessionId},session_id.is.null`)
            .eq('is_active', true);

        if (!webhooks || webhooks.length === 0) return;

        for (const webhook of webhooks) {
            // Filter by event if the webhook specifies a subscription list
            if (webhook.events) {
                const subscribedEvents = webhook.events.split(',').map((e: string) => e.trim());
                if (!subscribedEvents.includes(payload.event)) continue;
            }

            // Create a log record first (pessimistic — log before attempt)
            const { data: log } = await supabase
                .from('webhook_logs')
                .insert({
                    webhook_id: webhook.id,
                    event_type: payload.event,
                    payload,
                    status: 'pending',
                })
                .select('id')
                .single();

            if (!log) continue;

            // Enqueue the delivery job
            await webhookQueue.add('deliver', {
                webhookId: webhook.id,
                webhookUrl: webhook.url,
                secret: webhook.secret ?? null,
                payload,
                logId: log.id,
            });
        }
    } catch (err) {
        // Webhook dispatch should NEVER crash the main flow
        logger.error({ err, event: payload.event, sessionId: payload.sessionId }, 'Failed to dispatch webhook event');
    }
}

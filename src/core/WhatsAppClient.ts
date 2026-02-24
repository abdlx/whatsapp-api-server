import makeWASocket, {
    DisconnectReason,
    WASocket,
    ConnectionState,
    Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { supabase } from '../config/supabase.js';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { humanDelay, typingDuration, gaussianRandom, randomDelay } from '../utils/delays.js';
import { env } from '../config/env.js';
import { useRedisAuthState } from './authState/RedisAuthState.js';
import { proxyManager, Proxy } from './ProxyManager.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { encrypt } from '../utils/encryption.js';
import pino from 'pino';
import crypto from 'crypto';

export class WhatsAppClient {
    private socket: WASocket | null = null;
    private sessionId: string;
    public connectionState: 'open' | 'connecting' | 'close' = 'close';
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 5;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    async connect(): Promise<string | null> {
        // 1. Setup distributed auth state in Redis
        const { state, saveCreds } = await useRedisAuthState(redis, this.sessionId);

        // 2. Load residential proxy for this session
        const proxy = await proxyManager.getProxyForSession(this.sessionId);
        const agent = proxy
            ? new HttpsProxyAgent(`http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`)
            : undefined;

        const silentLogger = pino({ level: 'silent' });

        // 3. Initialize socket with premium fingerprint and proxy
        this.socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: silentLogger,
            browser: Browsers.macOS('Desktop'), // High-trust signature
            agent,               // Use residential proxy for all WA traffic
            fetchAgent: agent,   // Use residential proxy for media
            markOnlineOnConnect: false, // Don't broadcast presence immediately (stealth)
            syncFullHistory: false, // Performance
        });

        let qrCode: string | null = null;

        this.socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                await redis.set(`qr:${this.sessionId}`, qr, 'EX', 120);
                logger.info({ sessionId: this.sessionId }, 'QR code generated');
            }

            if (connection === 'open') {
                this.connectionState = 'open';
                this.reconnectAttempts = 0; // Reset backoff

                // Get the connected phone number from the socket
                const phoneNumber = this.socket?.user?.id?.split(':')[0] || null;

                await this.updateSessionStatus('active', phoneNumber);
                await this.backupAuthState();
                logger.info({
                    sessionId: this.sessionId,
                    phoneNumber,
                    country: proxy?.country_code
                }, 'WhatsApp connected via residential proxy');
            }

            if (connection === 'close') {
                this.connectionState = 'close';
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    await this.scheduleReconnect(statusCode);
                } else {
                    await this.updateSessionStatus('disconnected');
                    await proxyManager.releaseProxy(this.sessionId);
                    logger.info({ sessionId: this.sessionId }, 'Logged out, session ended');
                }
            }
        });

        this.socket.ev.on('messages.update', async (updates) => {
            for (const { key, update } of updates) {
                if (!key.id) continue;

                if (update.status === 2) { // Delivered
                    await supabase
                        .from('messages')
                        .update({ delivered_at: new Date().toISOString(), status: 'delivered' })
                        .eq('id', key.id);
                }
                if (update.status === 3) { // Read
                    await supabase
                        .from('messages')
                        .update({ read_at: new Date().toISOString(), status: 'read' })
                        .eq('id', key.id);
                }
            }
        });

        this.socket.ev.on('creds.update', saveCreds);

        return qrCode;
    }

    private async scheduleReconnect(statusCode: number | undefined): Promise<void> {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            logger.error({ sessionId: this.sessionId, attempts: this.reconnectAttempts }, 'Max reconnect attempts reached. Giving up.');
            await this.updateSessionStatus('error');
            return;
        }

        // Capped exponential backoff: 5s, 10s, 20s, 40s, 80s
        const baseDelay = 5000 * Math.pow(2, this.reconnectAttempts);
        const backoffMs = Math.min(baseDelay, 80000);

        // Add Gaussian jitter to avoid "reconnection storms"
        const jitter = (Math.random() - 0.5) * backoffMs * 0.3;
        const totalDelay = Math.floor(backoffMs + jitter);

        this.reconnectAttempts++;
        logger.warn({ sessionId: this.sessionId, statusCode, nextAttemptIn: `${totalDelay}ms`, attempt: this.reconnectAttempts }, 'Connection closed, scheduling reconnect');

        setTimeout(() => {
            this.connect().catch((err) => logger.error({ sessionId: this.sessionId, err }, 'Reconnection error'));
        }, totalDelay);
    }

    async sendMessageWithTyping(
        recipient: string,
        message: string,
        options?: {
            timezone?: string;
            respectWeekends?: boolean;
            minConversationScore?: number;
            bypassChecks?: boolean;
        }
    ): Promise<string> {
        if (!this.socket || this.connectionState !== 'open') {
            throw new Error('WhatsApp client not connected');
        }

        const { verifyContact, getConversationScore } = await import('../utils/contactVerification.js');
        const {
            canSendMessage,
            getAccountRiskProfile,
            incrementHourlyCounter,
            resetFailures,
            recordFailure,
        } = await import('../utils/adaptiveRateLimiting.js');
        const { shouldDelayForHumanBehavior, getContextualDelay, shouldTakeRandomBreak } = await import('../utils/humanBehavior.js');

        const timezone = options?.timezone || 'UTC';
        const bypassChecks = options?.bypassChecks || false;

        // PROTECTION 1: Adaptive Rate Limiting (account age-based)
        if (!bypassChecks) {
            const rateCheck = await canSendMessage(this.sessionId);
            if (!rateCheck.allowed) {
                logger.warn({ sessionId: this.sessionId, reason: rateCheck.reason }, 'Rate limit check failed');
                throw new Error(rateCheck.reason || 'Rate limit exceeded');
            }
        }

        // PROTECTION 2: Contact Verification (CRITICAL - prevents spam flags)
        const phoneNumber = recipient.replace('@s.whatsapp.net', '');
        const contactCheck = await verifyContact(this.socket, phoneNumber, this.sessionId);

        if (!contactCheck.exists) {
            await recordFailure(this.sessionId);
            throw new Error(`Number ${phoneNumber} does not exist on WhatsApp`);
        }

        // PROTECTION 3: Conversation History Scoring
        const conversationScore = await getConversationScore(this.sessionId, recipient);
        const minScore = options?.minConversationScore !== undefined ? options.minConversationScore : 10;

        if (!bypassChecks && conversationScore < minScore && !contactCheck.isSaved) {
            const warningMessage = `Low conversation score (${conversationScore}) with unsaved contact - HIGH BAN RISK`;

            logger.warn(
                { sessionId: this.sessionId, recipient, conversationScore, minScore, isSaved: contactCheck.isSaved },
                warningMessage
            );

            // Only BLOCK if explicitly configured to do so
            if (env.BLOCK_UNSAVED_CONTACTS) {
                throw new Error(
                    `Recipient ${phoneNumber} has ${warningMessage}. ` +
                    `Score must be >=${minScore} or contact must be saved. ` +
                    `Set BLOCK_UNSAVED_CONTACTS=false in .env to allow (not recommended for new accounts).`
                );
            }

            // Otherwise just warn and continue (still applies all other protections)
            logger.info(
                { sessionId: this.sessionId, recipient },
                'Proceeding with message despite low score (BLOCK_UNSAVED_CONTACTS=false)'
            );
        }

        // PROTECTION 4: Human Behavior Patterns (time-based)
        if (!bypassChecks) {
            const behaviorCheck = shouldDelayForHumanBehavior(timezone, options?.respectWeekends);
            if (behaviorCheck.shouldWait) {
                logger.info(
                    { sessionId: this.sessionId, reason: behaviorCheck.reason, waitMs: behaviorCheck.suggestedWaitMs },
                    'Human behavior check - delaying message'
                );
                throw new Error(
                    `${behaviorCheck.reason}. Message scheduled for later (wait ${Math.floor(behaviorCheck.suggestedWaitMs! / 60000)} minutes)`
                );
            }

            // Random break simulation (5% chance)
            const breakCheck = shouldTakeRandomBreak();
            if (breakCheck.takeBreak) {
                logger.debug(
                    { sessionId: this.sessionId, breakMs: breakCheck.breakDurationMs },
                    'Taking random break to simulate human behavior'
                );
                await new Promise((resolve) => setTimeout(resolve, breakCheck.breakDurationMs));
            }
        }

        // Get dynamic risk profile for adaptive delays
        const riskProfile = await getAccountRiskProfile(this.sessionId);
        logger.info(
            {
                sessionId: this.sessionId,
                recipient,
                riskLevel: riskProfile.riskLevel,
                accountAge: Math.floor(riskProfile.ageInDays),
                conversationScore,
            },
            'Sending message with risk profile'
        );

        // Format recipient
        const jid = recipient.includes('@') ? recipient : `${recipient}@s.whatsapp.net`;

        try {
            // ANTI-BAN: Contextual delay based on time of day
            const contextualDelay = getContextualDelay(timezone);
            await new Promise((resolve) => setTimeout(resolve, contextualDelay));

            // ANTI-BAN: Additional random delay with adaptive timing
            await randomDelay(riskProfile.minDelayMs, riskProfile.maxDelayMs);

            // ANTI-BAN: Typing simulation
            const typingMs = typingDuration(message);
            await this.socket.presenceSubscribe(jid);
            await this.socket.sendPresenceUpdate('composing', jid);
            await new Promise((resolve) => setTimeout(resolve, typingMs));
            await this.socket.sendPresenceUpdate('paused', jid);

            // Send message
            const result = await this.socket.sendMessage(jid, { text: message });

            // SUCCESS: Reset failure counter
            await resetFailures(this.sessionId);

            // Increment counters
            await incrementHourlyCounter(this.sessionId);
            await this.incrementCounters(); // Local Redis counter + DB sync

            // Log to database
            const messageId = result?.key?.id || crypto.randomUUID();
            await supabase.from('messages').insert({
                id: messageId,
                session_id: this.sessionId,
                recipient: recipient,
                content: message,
                status: 'sent',
                sent_at: new Date().toISOString(),
            });

            logger.info({ messageId, sessionId: this.sessionId, recipient }, 'Message sent successfully');

            return messageId;
        } catch (error) {
            // FAILURE: Record failure for adaptive rate limiting
            await recordFailure(this.sessionId);
            logger.error({ sessionId: this.sessionId, recipient, error }, 'Failed to send message');
            throw error;
        }
    }

    private async backupAuthState(): Promise<void> {
        try {
            const creds = await redis.get(`auth:${this.sessionId}:creds`);
            if (creds) {
                const encrypted = encrypt(creds);
                await supabase
                    .from('sessions')
                    .update({
                        auth_state_backup: encrypted,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', this.sessionId);
                logger.info({ sessionId: this.sessionId }, 'Auth state backed up');
            }
        } catch (error) {
            logger.error({ sessionId: this.sessionId, error }, 'Failed to backup auth state');
        }
    }

    private async getDailyMessageCountRedis(): Promise<number> {
        const dateKey = new Date().toISOString().slice(0, 10);
        const key = `count:${this.sessionId}:${dateKey}`;
        const count = await redis.get(key);
        return parseInt(count || '0', 10);
    }

    private async incrementCounters(): Promise<void> {
        const dateKey = new Date().toISOString().slice(0, 10);
        const key = `count:${this.sessionId}:${dateKey}`;

        await redis.incr(key);
        await redis.expire(key, 86400 * 2); // Keep for 2 days

        // Sync to DB in background
        Promise.resolve(supabase.rpc('increment_message_count', { session_id: this.sessionId })).catch(() => { });
    }

    private async updateSessionStatus(status: string, phoneNumber?: string | null): Promise<void> {
        await supabase
            .from('sessions')
            .update({
                status,
                last_active: new Date().toISOString(),
                ...(status === 'active' ? { connected_at: new Date().toISOString() } : {}),
                ...(phoneNumber ? { phone_number: phoneNumber } : {}),
            })
            .eq('id', this.sessionId);
    }

    async reconnect(): Promise<void> {
        this.reconnectAttempts = 0;
        await this.connect();
    }

    async disconnect(): Promise<void> {
        if (this.socket) {
            try {
                await this.socket.logout();
            } catch (err) {
                logger.error({ sessionId: this.sessionId, err }, 'Logout error');
            }
            this.socket = null;
        }
        this.connectionState = 'close';
        await this.updateSessionStatus('disconnected');
        await proxyManager.releaseProxy(this.sessionId);
    }
}

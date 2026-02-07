import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    WASocket,
    ConnectionState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { supabase } from '../config/supabase.js';
import { redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';
import { randomDelay, typingDuration } from '../utils/delays.js';
import { encrypt } from '../utils/encryption.js';
import { env } from '../config/env.js';
import fs from 'fs/promises';
import path from 'path';
import pino from 'pino';

export class WhatsAppClient {
    private socket: WASocket | null = null;
    private sessionId: string;
    public connectionState: 'open' | 'connecting' | 'close' = 'close';

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    async connect(): Promise<string | null> {
        const sessionPath = path.join(process.cwd(), 'sessions', this.sessionId);
        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

        const silentLogger = pino({ level: 'silent' });

        this.socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: silentLogger,
            browser: ['Chrome', 'Desktop', '122.0.0'],
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
                await this.updateSessionStatus('active');
                await this.backupAuthState();
                logger.info({ sessionId: this.sessionId }, 'WhatsApp connected');
            }

            if (connection === 'close') {
                this.connectionState = 'close';
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    logger.warn({ sessionId: this.sessionId, statusCode }, 'Connection closed, reconnecting...');
                    await this.reconnect();
                } else {
                    await this.updateSessionStatus('disconnected');
                    logger.info({ sessionId: this.sessionId }, 'Logged out, session ended');
                }
            }
        });

        this.socket.ev.on('messages.update', async (updates) => {
            for (const { key, update } of updates) {
                if (!key.id) continue;

                if (update.status === 2) {
                    await supabase
                        .from('messages')
                        .update({ delivered_at: new Date().toISOString(), status: 'delivered' })
                        .eq('id', key.id);
                }
                if (update.status === 3) {
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
            await supabase.rpc('increment_message_count', { session_id: this.sessionId });

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

    private async getDailyMessageCount(): Promise<number> {
        const { data } = await supabase
            .from('sessions')
            .select('daily_message_count, daily_count_reset_at')
            .eq('id', this.sessionId)
            .single();

        if (!data) return 0;

        const resetTime = new Date(data.daily_count_reset_at);
        const now = new Date();

        // Reset if 24 hours have passed
        if (now.getTime() - resetTime.getTime() > 86400000) {
            await supabase
                .from('sessions')
                .update({
                    daily_message_count: 0,
                    daily_count_reset_at: now.toISOString(),
                })
                .eq('id', this.sessionId);
            return 0;
        }

        return data.daily_message_count;
    }

    private async updateSessionStatus(status: string): Promise<void> {
        await supabase
            .from('sessions')
            .update({
                status,
                last_active: new Date().toISOString(),
                ...(status === 'active' ? { connected_at: new Date().toISOString() } : {}),
            })
            .eq('id', this.sessionId);
    }

    private async backupAuthState(): Promise<void> {
        try {
            const credsPath = path.join(process.cwd(), 'sessions', this.sessionId, 'creds.json');
            const credsData = await fs.readFile(credsPath, 'utf-8');
            const encrypted = encrypt(credsData);

            await supabase
                .from('sessions')
                .update({ auth_state_backup: encrypted, updated_at: new Date().toISOString() })
                .eq('id', this.sessionId);

            logger.debug({ sessionId: this.sessionId }, 'Auth state backed up');
        } catch (error) {
            logger.error({ sessionId: this.sessionId, error }, 'Failed to backup auth state');
        }
    }

    async reconnect(): Promise<void> {
        logger.info({ sessionId: this.sessionId }, 'Attempting reconnect...');
        this.connectionState = 'connecting';
        await this.connect();
    }

    async disconnect(): Promise<void> {
        if (this.socket) {
            await this.socket.logout();
            this.socket = null;
        }
        this.connectionState = 'close';
        await this.updateSessionStatus('disconnected');
    }
}

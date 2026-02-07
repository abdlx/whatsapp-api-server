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

    async sendMessageWithTyping(recipient: string, message: string): Promise<string> {
        if (!this.socket || this.connectionState !== 'open') {
            throw new Error('WhatsApp client not connected');
        }

        // Check daily limit
        const dailyCount = await this.getDailyMessageCount();
        if (dailyCount >= env.MAX_MESSAGES_PER_DAY) {
            throw new Error(`Daily message limit reached (${env.MAX_MESSAGES_PER_DAY})`);
        }

        // Format recipient (ensure @s.whatsapp.net suffix)
        const jid = recipient.includes('@') ? recipient : `${recipient}@s.whatsapp.net`;

        // Anti-ban: random delay
        await randomDelay();

        // Anti-ban: typing simulation
        const typingMs = typingDuration(message);
        await this.socket.presenceSubscribe(jid);
        await this.socket.sendPresenceUpdate('composing', jid);
        await new Promise((resolve) => setTimeout(resolve, typingMs));
        await this.socket.sendPresenceUpdate('paused', jid);

        // Send message
        const result = await this.socket.sendMessage(jid, { text: message });

        // Increment daily counter
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

        return messageId;
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

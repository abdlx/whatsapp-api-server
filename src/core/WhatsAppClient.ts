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
import { humanDelay, typingDuration, gaussianRandom } from '../utils/delays.js';
import { env } from '../config/env.js';
import { useRedisAuthState } from './authState/RedisAuthState.js';
import { proxyManager, Proxy } from './ProxyManager.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import pino from 'pino';

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
                await this.updateSessionStatus('active');
                logger.info({ sessionId: this.sessionId, country: proxy?.country_code }, 'WhatsApp connected via residential proxy');
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

    async sendMessageWithTyping(recipient: string, message: string): Promise<string> {
        if (!this.socket || this.connectionState !== 'open') {
            throw new Error('WhatsApp client not connected');
        }

        // Check daily limit (Redis-backed for perf)
        const dailyCount = await this.getDailyMessageCountRedis();
        if (dailyCount >= env.MAX_MESSAGES_PER_DAY) {
            throw new Error(`Daily message limit reached (${env.MAX_MESSAGES_PER_DAY})`);
        }

        const jid = recipient.includes('@') ? recipient : `${recipient}@s.whatsapp.net`;

        // Anti-ban: Gaussian human-like delay
        await humanDelay();

        // Anti-ban: Natural typing simulation
        const typingMs = typingDuration(message);
        await this.socket.presenceSubscribe(jid);
        await this.socket.sendPresenceUpdate('composing', jid);

        // Split typing into chunks if long message
        await new Promise((resolve) => setTimeout(resolve, typingMs));

        await this.socket.sendPresenceUpdate('paused', jid);

        // Send message
        const result = await this.socket.sendMessage(jid, { text: message });

        // Increment counters
        await this.incrementCounters();

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


import makeWASocket, {
    DisconnectReason,
    WASocket,
    ConnectionState,
    Browsers,
    AnyMessageContent,
    downloadMediaMessage,
    getContentType,
    WAMessage,
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
import { dispatchWebhookEvent, WebhookEventType } from '../services/WebhookDispatcher.js';
import { getBrowserFingerprint } from '../utils/browserFingerprint.js';
import pino from 'pino';
import crypto from 'crypto';
import axios from 'axios';

// ─── Media & Rich Message Types ───────────────────────────────────────────────

export type OutboundMessageType =
    | 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker'
    | 'button' | 'list' | 'poll' | 'location' | 'contact'
    | 'voice' | 'gif' | 'link_preview' | 'live_location' | 'contact_list' | 'short_video';

export interface ButtonItem {
    id: string;
    text: string;
}

export interface ListRow {
    id: string;
    title: string;
    description?: string;
}

export interface ListSection {
    title: string;
    rows: ListRow[];
}

export interface OutboundMessage {
    type: OutboundMessageType;
    text?: string;                // Used for text messages and captions
    mediaUrl?: string;            // Remote URL of the media to send
    mediaBase64?: string;         // Base64 encoded media (alternative to URL)
    mediaMimetype?: string;       // MIME type (required for base64)
    filename?: string;            // Filename for documents
    caption?: string;             // Caption for image/video
    // Button messages (interactive format)
    buttons?: ButtonItem[];       // Up to 3 buttons
    footer?: string;              // Footer text for button/list messages
    // List messages (interactive format)
    listTitle?: string;           // Title for list header
    buttonText?: string;          // Button text that opens the list
    sections?: ListSection[];     // List sections with rows
    // Poll messages
    pollQuestion?: string;        // Poll question text
    pollOptions?: string[];       // Poll answer options
    pollSelectCount?: number;     // Max selectable options (0 = unlimited)
    // Location messages
    latitude?: number;
    longitude?: number;
    locationName?: string;
    locationAddress?: string;
    // Contact card messages
    contactName?: string;
    vcard?: string;
    // Voice messages
    ptt?: boolean;                // Push-to-talk (voice note) — true = voice bubble, false = audio file
    // GIF messages
    gifPlayback?: boolean;        // Send video as GIF (auto-play, no sound)
    // Link preview
    previewUrl?: string;          // URL to preview
    previewTitle?: string;        // Custom preview title (optional)
    previewDescription?: string;  // Custom preview description (optional)
    previewThumbnailUrl?: string; // Custom thumbnail URL (optional)
    // Live location
    liveLocationDurationSeconds?: number; // Duration for live location sharing
    // Contact list (multi-contact)
    vcards?: string[];            // Multiple vCards for contact list messages
    contactNames?: string[];      // Display names for each vCard
}

export interface SendOptions {
    timezone?: string;
    respectWeekends?: boolean;
    minConversationScore?: number;
    bypassChecks?: boolean;
}

// ─── Class ────────────────────────────────────────────────────────────────────

export class WhatsAppClient {
    private socket: WASocket | null = null;
    private sessionId: string;
    public connectionState: 'open' | 'connecting' | 'close' = 'close';
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECT_ATTEMPTS = 5;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    /** Expose underlying Baileys socket for direct API calls (e.g., group management) */
    getSocket(): WASocket | null {
        return this.socket;
    }

    async connect(): Promise<string | null> {
        // 1. Setup distributed auth state in Redis
        const { state, saveCreds } = await useRedisAuthState(redis, this.sessionId);

        // 2. Load residential proxy for this session
        const proxy = await proxyManager.getProxyForSession(this.sessionId);
        if (!proxy && !env.ALLOW_DIRECT_CONNECTION) {
            throw new Error(
                `No proxy available for session ${this.sessionId}. ` +
                'Set ALLOW_DIRECT_CONNECTION=true to allow connecting from the server\'s IP.'
            );
        }
        const agent = proxy
            ? new HttpsProxyAgent(`http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`)
            : undefined;

        const silentLogger = pino({ level: 'silent' });

        // 3. Rotate browser fingerprint per session (monthly rotation)
        const fingerprint = getBrowserFingerprint(this.sessionId);

        // 4. Initialize socket with rotated fingerprint and proxy
        this.socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: silentLogger,
            browser: fingerprint.browser as [string, string, string],
            agent,               // Use residential proxy for all WA traffic
            fetchAgent: agent,   // Use residential proxy for media
            markOnlineOnConnect: false, // Don't broadcast presence immediately (stealth)
            syncFullHistory: false, // Performance
        });

        let qrCode: string | null = null;

        // ─── Connection Events ────────────────────────────────────────────────
        this.socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                await redis.set(`qr:${this.sessionId}`, qr, 'EX', 120);
                logger.info({ sessionId: this.sessionId }, 'QR code generated');

                // Dispatch QR event so integrations can render/refresh the QR
                dispatchWebhookEvent({
                    event: 'session.qr',
                    sessionId: this.sessionId,
                    timestamp: new Date().toISOString(),
                    data: { qr },
                });
            }

            if (connection === 'open') {
                this.connectionState = 'open';
                this.reconnectAttempts = 0;

                const phoneNumber = this.socket?.user?.id?.split(':')[0] || null;
                await this.updateSessionStatus('active', phoneNumber);
                await this.backupAuthState();

                logger.info({
                    sessionId: this.sessionId,
                    phoneNumber,
                    country: proxy?.country_code
                }, 'WhatsApp connected via residential proxy');

                dispatchWebhookEvent({
                    event: 'session.connected',
                    sessionId: this.sessionId,
                    timestamp: new Date().toISOString(),
                    data: { phoneNumber, proxyCountry: proxy?.country_code ?? null },
                });
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

                    dispatchWebhookEvent({
                        event: 'session.disconnected',
                        sessionId: this.sessionId,
                        timestamp: new Date().toISOString(),
                        data: { reason: 'logged_out', statusCode },
                    });
                }
            }
        });

        // ─── Inbound Messages ─────────────────────────────────────────────────
        this.socket.ev.on('messages.upsert', async (upsert) => {
            if (upsert.type !== 'notify') return;

            for (const msg of upsert.messages) {
                // Ignore outbound messages that echo back
                if (msg.key.fromMe) continue;

                try {
                    await this.handleInboundMessage(msg);
                } catch (err) {
                    logger.error({ sessionId: this.sessionId, msgId: msg.key.id, err }, 'Error processing inbound message');
                }
            }
        });

        // ─── Delivery & Read Receipts ─────────────────────────────────────────
        this.socket.ev.on('messages.update', async (updates) => {
            for (const { key, update } of updates) {
                if (!key.id) continue;

                if (update.status === 2) { // Delivered
                    await supabase
                        .from('messages')
                        .update({ delivered_at: new Date().toISOString(), status: 'delivered' })
                        .eq('id', key.id);

                    dispatchWebhookEvent({
                        event: 'message.delivered',
                        sessionId: this.sessionId,
                        timestamp: new Date().toISOString(),
                        data: { messageId: key.id, recipient: key.remoteJid },
                    });
                }

                if (update.status === 3) { // Read
                    await supabase
                        .from('messages')
                        .update({ read_at: new Date().toISOString(), status: 'read' })
                        .eq('id', key.id);

                    dispatchWebhookEvent({
                        event: 'message.read',
                        sessionId: this.sessionId,
                        timestamp: new Date().toISOString(),
                        data: { messageId: key.id, recipient: key.remoteJid },
                    });
                }
            }
        });

        // ─── Message Revoke ───────────────────────────────────────────────────
        this.socket.ev.on('messages.delete', (event) => {
            if (!('keys' in event)) return;
            for (const key of event.keys) {
                dispatchWebhookEvent({
                    event: 'message.revoked',
                    sessionId: this.sessionId,
                    timestamp: new Date().toISOString(),
                    data: { messageId: key.id, from: key.remoteJid },
                });
            }
        });

        // ─── Reactions ────────────────────────────────────────────────────────
        this.socket.ev.on('messages.reaction', (reactions) => {
            for (const r of reactions) {
                dispatchWebhookEvent({
                    event: 'message.reaction',
                    sessionId: this.sessionId,
                    timestamp: new Date().toISOString(),
                    data: {
                        messageId: r.key.id,
                        from: r.key.remoteJid,
                        emoji: r.reaction.text,
                        senderKeyId: r.reaction.senderTimestampMs,
                    },
                });
            }
        });

        // ─── Incoming Calls ───────────────────────────────────────────────────
        this.socket.ev.on('call', (calls) => {
            for (const call of calls) {
                dispatchWebhookEvent({
                    event: 'call.received',
                    sessionId: this.sessionId,
                    timestamp: new Date().toISOString(),
                    data: {
                        callId: call.id,
                        from: call.from,
                        status: call.status,
                        isVideo: call.isVideo,
                        isGroup: call.isGroup,
                    },
                });
            }
        });

        // ─── Group Updates ────────────────────────────────────────────────────
        this.socket.ev.on('groups.update', (groups) => {
            for (const group of groups) {
                dispatchWebhookEvent({
                    event: 'group.update',
                    sessionId: this.sessionId,
                    timestamp: new Date().toISOString(),
                    data: group as Record<string, unknown>,
                });
            }
        });

        this.socket.ev.on('creds.update', saveCreds);

        return qrCode;
    }

    // ─── Inbound Message Normalization ────────────────────────────────────────

    private async handleInboundMessage(msg: WAMessage): Promise<void> {
        const contentType = getContentType(msg.message ?? {});
        const from = msg.key.remoteJid!;
        const isGroup = from.endsWith('@g.us');
        const sender = isGroup ? msg.key.participant ?? from : from;

        // Build normalized payload
        const normalized: Record<string, unknown> = {
            messageId: msg.key.id,
            from: sender,
            chat: from,
            isGroup,
            timestamp: msg.messageTimestamp
                ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
                : new Date().toISOString(),
        };

        if (contentType === 'conversation' || contentType === 'extendedTextMessage') {
            normalized.type = 'text';
            normalized.text = msg.message?.conversation
                ?? msg.message?.extendedTextMessage?.text
                ?? '';
        } else if (contentType === 'imageMessage') {
            normalized.type = 'image';
            normalized.caption = msg.message?.imageMessage?.caption ?? null;
            normalized.mimetype = msg.message?.imageMessage?.mimetype;
        } else if (contentType === 'videoMessage') {
            normalized.type = 'video';
            normalized.caption = msg.message?.videoMessage?.caption ?? null;
            normalized.mimetype = msg.message?.videoMessage?.mimetype;
        } else if (contentType === 'audioMessage') {
            normalized.type = 'audio';
            normalized.isPTT = msg.message?.audioMessage?.ptt ?? false;
            normalized.mimetype = msg.message?.audioMessage?.mimetype;
        } else if (contentType === 'documentMessage') {
            normalized.type = 'document';
            normalized.filename = msg.message?.documentMessage?.fileName;
            normalized.mimetype = msg.message?.documentMessage?.mimetype;
            normalized.caption = msg.message?.documentMessage?.caption ?? null;
        } else if (contentType === 'stickerMessage') {
            normalized.type = 'sticker';
        } else if (contentType === 'locationMessage') {
            normalized.type = 'location';
            normalized.latitude = msg.message?.locationMessage?.degreesLatitude;
            normalized.longitude = msg.message?.locationMessage?.degreesLongitude;
            normalized.name = msg.message?.locationMessage?.name;
        } else if (contentType === 'contactMessage') {
            normalized.type = 'contact';
            normalized.displayName = msg.message?.contactMessage?.displayName;
            normalized.vcard = msg.message?.contactMessage?.vcard;
        } else {
            normalized.type = contentType ?? 'unknown';
        }

        // ── Download inbound media and upload to Supabase Storage ──────────
        const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'];
        if (mediaTypes.includes(normalized.type as string)) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const ext = ((normalized.mimetype as string) ?? 'application/octet-stream').split('/')[1] || 'bin';
                const storagePath = `inbound/${this.sessionId}/${msg.key.id}.${ext}`;

                const { data: uploadData } = await supabase.storage
                    .from(env.MEDIA_BUCKET)
                    .upload(storagePath, buffer as Buffer, {
                        contentType: (normalized.mimetype as string) ?? 'application/octet-stream',
                        upsert: true,
                    });

                if (uploadData) {
                    const { data: urlData } = supabase.storage
                        .from(env.MEDIA_BUCKET)
                        .getPublicUrl(storagePath);
                    normalized.mediaUrl = urlData.publicUrl;
                }
            } catch (err) {
                logger.error({ sessionId: this.sessionId, msgId: msg.key.id, err }, 'Failed to download/upload inbound media');
                // Non-fatal — webhook still fires with metadata even if media download fails
            }
        }

        await dispatchWebhookEvent({
            event: 'message.received',
            sessionId: this.sessionId,
            timestamp: new Date().toISOString(),
            data: normalized,
        });
    }

    // ─── Send Message (All Types) ─────────────────────────────────────────────

    async sendMessage(
        recipient: string,
        outbound: OutboundMessage,
        options?: SendOptions
    ): Promise<string> {
        if (!this.socket || this.connectionState !== 'open') {
            throw new Error('WhatsApp client not connected');
        }

        const { verifyContact, getConversationScore } = await import('../utils/contactVerification.js');
        const {
            canSendMessage, getAccountRiskProfile,
            incrementHourlyCounter, resetFailures, recordFailure,
        } = await import('../utils/adaptiveRateLimiting.js');
        const { shouldDelayForHumanBehavior, getContextualDelay, shouldTakeRandomBreak } = await import('../utils/humanBehavior.js');

        const timezone = options?.timezone || env.DEFAULT_TIMEZONE;
        const bypassChecks = options?.bypassChecks || false;

        // ── Anti-Ban Checks ─────────────────────────────────────────────────────

        if (!bypassChecks) {
            // 1. Adaptive rate limiting
            const rateCheck = await canSendMessage(this.sessionId);
            if (!rateCheck.allowed) {
                throw new Error(rateCheck.reason || 'Rate limit exceeded');
            }

            // 2. Human behavior / time-of-day gating — sleep internally instead of rejecting
            const behaviorCheck = shouldDelayForHumanBehavior(timezone, options?.respectWeekends);
            if (behaviorCheck.shouldWait && behaviorCheck.suggestedWaitMs) {
                const cappedWaitMs = Math.min(behaviorCheck.suggestedWaitMs, 5 * 60 * 1000); // Cap at 5 minutes
                logger.info({ sessionId: this.sessionId, waitMs: cappedWaitMs, reason: behaviorCheck.reason }, 'Delaying send for human behavior simulation');
                await new Promise((resolve) => setTimeout(resolve, cappedWaitMs));
            }

            // 3. Random break simulation (5% chance)
            const breakCheck = shouldTakeRandomBreak();
            if (breakCheck.takeBreak) {
                await new Promise((resolve) => setTimeout(resolve, breakCheck.breakDurationMs));
            }
        }

        // 4. Contact verification
        const phoneNumber = recipient.replace('@s.whatsapp.net', '');
        const contactCheck = await verifyContact(this.socket, phoneNumber, this.sessionId);
        if (!contactCheck.exists) {
            await recordFailure(this.sessionId);
            throw new Error(`Number ${phoneNumber} does not exist on WhatsApp`);
        }

        // 5. Conversation score gating
        // NOTE: contactCheck.isSaved is always false (Baileys can't reliably determine this).
        // The conversation score is the sole trust signal for ban-risk assessment.
        const conversationScore = await getConversationScore(this.sessionId, recipient);
        const minScore = options?.minConversationScore !== undefined ? options.minConversationScore : 10;
        if (!bypassChecks && conversationScore < minScore) {
            const msg = `Low conversation score (${conversationScore}) — HIGH BAN RISK`;
            logger.warn({ sessionId: this.sessionId, recipient, conversationScore }, msg);
            if (env.BLOCK_UNSAVED_CONTACTS) {
                throw new Error(`${msg}. Score must be >=${minScore}. Set BLOCK_UNSAVED_CONTACTS=false to allow.`);
            }
        }

        const riskProfile = await getAccountRiskProfile(this.sessionId);
        const jid = recipient.includes('@') ? recipient : `${recipient}@s.whatsapp.net`;

        try {
            // Contextual + adaptive delay
            await new Promise((resolve) => setTimeout(resolve, getContextualDelay(timezone)));
            await randomDelay(riskProfile.minDelayMs, riskProfile.maxDelayMs);

            // Build the Baileys message content
            const messageContent = await this.buildMessageContent(outbound);

            // Typing simulation (only for text messages, not media)
            if (outbound.type === 'text' && outbound.text) {
                const typingMs = typingDuration(outbound.text);
                await this.socket.presenceSubscribe(jid);
                await this.socket.sendPresenceUpdate('composing', jid);
                await new Promise((resolve) => setTimeout(resolve, typingMs));
                await this.socket.sendPresenceUpdate('paused', jid);
            }

            const result = await this.socket.sendMessage(jid, messageContent);

            // Success bookkeeping
            await resetFailures(this.sessionId);
            await incrementHourlyCounter(this.sessionId);
            await this.incrementCounters();

            const messageId = result?.key?.id || crypto.randomUUID();

            // Use upsert to avoid duplicate rows when the MessageQueue worker
            // pre-inserts a 'pending' record before calling client.sendMessage().
            await supabase.from('messages').upsert({
                id: messageId,
                session_id: this.sessionId,
                recipient,
                content: outbound.text ?? outbound.caption ?? `[${outbound.type}]`,
                message_type: outbound.type,
                media_url: outbound.mediaUrl ?? null,
                media_mimetype: outbound.mediaMimetype ?? null,
                media_filename: outbound.filename ?? null,
                status: 'sent',
                sent_at: new Date().toISOString(),
            }, { onConflict: 'id' });

            logger.info({ messageId, sessionId: this.sessionId, recipient, type: outbound.type }, 'Message sent');

            dispatchWebhookEvent({
                event: 'message.sent',
                sessionId: this.sessionId,
                timestamp: new Date().toISOString(),
                data: { messageId, recipient, type: outbound.type },
            });

            return messageId;
        } catch (error) {
            await recordFailure(this.sessionId);
            logger.error({ sessionId: this.sessionId, recipient, error }, 'Failed to send message');
            throw error;
        }
    }

    /**
     * Backwards-compatible text-only helper — used by existing queue worker.
     */
    async sendMessageWithTyping(
        recipient: string,
        message: string,
        options?: SendOptions
    ): Promise<string> {
        return this.sendMessage(recipient, { type: 'text', text: message }, options);
    }

    // ─── Media Content Builder ────────────────────────────────────────────────

    /** @internal - Public for unit testing */
    public async buildMessageContent(outbound: OutboundMessage): Promise<AnyMessageContent> {
        const { type } = outbound;

        if (type === 'text') {
            if (!outbound.text) throw new Error('text field is required for text messages');
            return { text: outbound.text };
        }

        // ── Rich Interactive Types ───────────────────────────────────────────

        // Buttons — uses the new interactive message format (deprecated format no longer works)
        if (type === 'button') {
            if (!outbound.buttons || outbound.buttons.length === 0) throw new Error('buttons array is required for button messages');
            return {
                viewOnceMessage: {
                    message: {
                        interactiveMessage: {
                            header: outbound.text ? { title: outbound.text, hasMediaAttachment: false } : undefined,
                            body: { text: outbound.text || '' },
                            footer: outbound.footer ? { text: outbound.footer } : undefined,
                            nativeFlowMessage: {
                                buttons: outbound.buttons.map((b) => ({
                                    name: 'quick_reply',
                                    buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id }),
                                })),
                            },
                        },
                    },
                },
            } as unknown as AnyMessageContent;
        }

        // Lists — uses the new interactive message format
        if (type === 'list') {
            if (!outbound.sections || outbound.sections.length === 0) throw new Error('sections array is required for list messages');
            return {
                viewOnceMessage: {
                    message: {
                        interactiveMessage: {
                            header: outbound.listTitle ? { title: outbound.listTitle, hasMediaAttachment: false } : undefined,
                            body: { text: outbound.text || '' },
                            footer: outbound.footer ? { text: outbound.footer } : undefined,
                            nativeFlowMessage: {
                                buttons: [{
                                    name: 'single_select',
                                    buttonParamsJson: JSON.stringify({
                                        title: outbound.buttonText || 'Menu',
                                        sections: outbound.sections.map((s) => ({
                                            title: s.title,
                                            rows: s.rows.map((r) => ({
                                                title: r.title,
                                                id: r.id,
                                                description: r.description || '',
                                            })),
                                        })),
                                    }),
                                }],
                            },
                        },
                    },
                },
            } as unknown as AnyMessageContent;
        }

        if (type === 'poll') {
            if (!outbound.pollQuestion) throw new Error('pollQuestion is required for poll messages');
            if (!outbound.pollOptions || outbound.pollOptions.length < 2) throw new Error('pollOptions requires at least 2 options');
            return {
                poll: {
                    name: outbound.pollQuestion,
                    values: outbound.pollOptions,
                    selectableCount: outbound.pollSelectCount ?? 0,
                },
            } as unknown as AnyMessageContent;
        }

        if (type === 'location') {
            if (outbound.latitude === undefined || outbound.longitude === undefined) {
                throw new Error('latitude and longitude are required for location messages');
            }
            return {
                location: {
                    degreesLatitude: outbound.latitude,
                    degreesLongitude: outbound.longitude,
                    name: outbound.locationName || '',
                    address: outbound.locationAddress || '',
                },
            } as unknown as AnyMessageContent;
        }

        // Live location sharing
        if (type === 'live_location') {
            if (outbound.latitude === undefined || outbound.longitude === undefined) {
                throw new Error('latitude and longitude are required for live_location messages');
            }
            return {
                location: {
                    degreesLatitude: outbound.latitude,
                    degreesLongitude: outbound.longitude,
                    name: outbound.locationName || '',
                    address: outbound.locationAddress || '',
                    accuracyInMeters: 10,
                    isLive: true,
                    caption: outbound.caption || '',
                },
            } as unknown as AnyMessageContent;
        }

        // Single contact card
        if (type === 'contact') {
            if (!outbound.contactName || !outbound.vcard) throw new Error('contactName and vcard are required for contact messages');
            return {
                contacts: {
                    displayName: outbound.contactName,
                    contacts: [{ vcard: outbound.vcard }],
                },
            } as unknown as AnyMessageContent;
        }

        // Contact list (multiple contacts)
        if (type === 'contact_list') {
            if (!outbound.vcards || outbound.vcards.length === 0) throw new Error('vcards array is required for contact_list messages');
            const names = outbound.contactNames || [];
            return {
                contacts: {
                    displayName: names[0] || 'Contacts',
                    contacts: outbound.vcards.map((v, i) => ({ vcard: v, displayName: names[i] || '' })),
                },
            } as unknown as AnyMessageContent;
        }

        // Link preview message
        if (type === 'link_preview') {
            const url = outbound.previewUrl || outbound.text || '';
            if (!url) throw new Error('previewUrl or text with a URL is required for link_preview messages');
            return {
                text: outbound.text || url,
                linkPreview: {
                    'canonical-url': url,
                    title: outbound.previewTitle || '',
                    description: outbound.previewDescription || '',
                    matchedText: url,
                },
            } as unknown as AnyMessageContent;
        }

        // ── Standard Media Types ─────────────────────────────────────────────

        // Resolve media — use URL passthrough for streaming when possible
        const media = this.resolveMedia(outbound);

        if (type === 'image') {
            return {
                image: media,
                mimetype: outbound.mediaMimetype || 'image/jpeg',
                caption: outbound.caption ?? outbound.text ?? '',
            };
        }

        if (type === 'video') {
            return {
                video: media,
                mimetype: outbound.mediaMimetype || 'video/mp4',
                caption: outbound.caption ?? outbound.text ?? '',
            };
        }

        // Short video / PTV (Picture-in-Picture video note)
        if (type === 'short_video') {
            return {
                video: media,
                mimetype: outbound.mediaMimetype || 'video/mp4',
                ptv: true,
            } as unknown as AnyMessageContent;
        }

        // GIF — sent as a video with gifPlayback flag
        if (type === 'gif') {
            return {
                video: media,
                mimetype: outbound.mediaMimetype || 'video/mp4',
                caption: outbound.caption ?? outbound.text ?? '',
                gifPlayback: true,
            };
        }

        // Audio file attachment (not voice note)
        if (type === 'audio') {
            return {
                audio: media,
                mimetype: outbound.mediaMimetype || 'audio/mpeg',
                ptt: outbound.ptt ?? false,
            };
        }

        // Voice note (push-to-talk) — appears as voice bubble
        if (type === 'voice') {
            return {
                audio: media,
                mimetype: outbound.mediaMimetype || 'audio/ogg; codecs=opus',
                ptt: true,
            };
        }

        if (type === 'document') {
            if (!outbound.filename) throw new Error('filename is required for document messages');
            return {
                document: media,
                mimetype: outbound.mediaMimetype || 'application/octet-stream',
                fileName: outbound.filename,
                caption: outbound.caption ?? outbound.text ?? '',
            };
        }

        if (type === 'sticker') {
            return {
                sticker: media,
                mimetype: outbound.mediaMimetype || 'image/webp',
            };
        }

        throw new Error(`Unsupported message type: ${type}`);
    }

    /**
     * Resolve media from either a URL or base64 string.
     * For URLs, returns { url: string } which Baileys streams natively (no heap buffering).
     * For base64, decodes to Buffer.
     */
    private resolveMedia(outbound: OutboundMessage): { url: string } | Buffer {
        if (outbound.mediaUrl) {
            // Pass URL directly to Baileys — it will stream-download internally
            return { url: outbound.mediaUrl };
        }

        if (outbound.mediaBase64) {
            // Strip data-url prefix if present (e.g., "data:image/jpeg;base64,...")
            const base64 = outbound.mediaBase64.includes(',')
                ? outbound.mediaBase64.split(',')[1]
                : outbound.mediaBase64;
            return Buffer.from(base64, 'base64');
        }

        throw new Error('Either mediaUrl or mediaBase64 must be provided for media messages');
    }

    // ─── Reconnection ─────────────────────────────────────────────────────────

    private async scheduleReconnect(statusCode: number | undefined): Promise<void> {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            logger.error({ sessionId: this.sessionId, attempts: this.reconnectAttempts }, 'Max reconnect attempts reached. Giving up.');
            await this.updateSessionStatus('error');

            dispatchWebhookEvent({
                event: 'session.disconnected',
                sessionId: this.sessionId,
                timestamp: new Date().toISOString(),
                data: { reason: 'max_reconnect_attempts_exceeded', statusCode },
            });
            return;
        }

        // Capped exponential backoff with Gaussian jitter to avoid reconnection storms
        const baseDelay = 5000 * Math.pow(2, this.reconnectAttempts);
        const backoffMs = Math.min(baseDelay, 80000);
        const jitter = (Math.random() - 0.5) * backoffMs * 0.3;
        const totalDelay = Math.floor(backoffMs + jitter);

        this.reconnectAttempts++;
        logger.warn({ sessionId: this.sessionId, statusCode, nextAttemptIn: `${totalDelay}ms`, attempt: this.reconnectAttempts }, 'Connection closed, scheduling reconnect');

        setTimeout(() => {
            this.connect().catch((err) => logger.error({ sessionId: this.sessionId, err }, 'Reconnection error'));
        }, totalDelay);
    }

    // ─── State Management ─────────────────────────────────────────────────────

    private async backupAuthState(): Promise<void> {
        try {
            const creds = await redis.get(`auth:${this.sessionId}:creds`);
            if (creds) {
                const encrypted = encrypt(creds);
                await supabase
                    .from('sessions')
                    .update({ auth_state_backup: encrypted, updated_at: new Date().toISOString() })
                    .eq('id', this.sessionId);
            }
        } catch (error) {
            logger.error({ sessionId: this.sessionId, error }, 'Failed to backup auth state');
        }
    }

    private async incrementCounters(): Promise<void> {
        const dateKey = new Date().toISOString().slice(0, 10);
        const key = `count:${this.sessionId}:${dateKey}`;

        await redis.incr(key);
        await redis.expire(key, 86400 * 2);

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

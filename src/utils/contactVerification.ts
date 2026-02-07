import { WASocket } from '@whiskeysockets/baileys';
import { logger } from './logger.js';
import { redis } from '../config/redis.js';

interface ContactCheck {
    exists: boolean;
    isSaved: boolean;
    isBlocked: boolean;
}

/**
 * Check if a contact exists on WhatsApp and if they have you in their contacts
 * This is CRITICAL for anti-ban - WhatsApp penalizes messaging unsaved contacts
 */
export async function verifyContact(
    socket: WASocket,
    phoneNumber: string,
    sessionId: string
): Promise<ContactCheck> {
    const jid = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;
    const cacheKey = `contact:verified:${sessionId}:${phoneNumber}`;

    // Check cache first (valid for 7 days)
    const cached = await redis.get(cacheKey);
    if (cached) {
        return JSON.parse(cached);
    }

    try {
        // Check if number exists on WhatsApp
        const results = await socket.onWhatsApp(phoneNumber);
        if (!results || results.length === 0 || !results[0]?.exists) {
            logger.warn({ phoneNumber }, 'Number does not exist on WhatsApp');
            return { exists: false, isSaved: false, isBlocked: false };
        }

        // Check if contact is in your phone's contact list
        // This is a heuristic - if you've chatted before, they're likely saved
        const contactStatus = await socket.fetchStatus(jid).catch(() => null);
        const isSaved = contactStatus !== null; // If you can fetch status, usually means mutual contact

        // Cache the result for 7 days
        const result: ContactCheck = {
            exists: true,
            isSaved,
            isBlocked: false, // Note: Baileys can't reliably detect if you're blocked
        };

        await redis.set(cacheKey, JSON.stringify(result), 'EX', 604800); // 7 days

        return result;
    } catch (error) {
        logger.error({ phoneNumber, error }, 'Failed to verify contact');
        // Conservative approach: assume unsaved if verification fails
        return { exists: true, isSaved: false, isBlocked: false };
    }
}

/**
 * Check conversation history to determine relationship strength
 * Returns a score 0-100 (higher = safer to message)
 */
export async function getConversationScore(sessionId: string, recipient: string): Promise<number> {
    try {
        // Query message history from database
        const { supabase } = await import('../config/supabase.js');
        const { data } = await supabase
            .from('messages')
            .select('id, sent_at, status')
            .eq('session_id', sessionId)
            .eq('recipient', recipient)
            .order('sent_at', { ascending: false })
            .limit(100);

        if (!data || data.length === 0) return 0; // Never messaged = risky

        // Scoring factors
        let score = 0;

        // 1. Message history length (max 40 points)
        score += Math.min(data.length * 2, 40);

        // 2. Recent activity (max 30 points)
        const lastMessage = new Date(data[0].sent_at);
        const daysSinceLastMessage = (Date.now() - lastMessage.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLastMessage < 7) score += 30;
        else if (daysSinceLastMessage < 30) score += 20;
        else if (daysSinceLastMessage < 90) score += 10;

        // 3. Delivery success rate (max 30 points)
        const successfulMessages = data.filter(m => m.status === 'delivered' || m.status === 'read').length;
        const successRate = successfulMessages / data.length;
        score += Math.floor(successRate * 30);

        return Math.min(score, 100);
    } catch (error) {
        logger.error({ sessionId, recipient, error }, 'Failed to calculate conversation score');
        return 0;
    }
}

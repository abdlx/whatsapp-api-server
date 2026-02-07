import { redis } from '../config/redis.js';
import { supabase } from '../config/supabase.js';
import { logger } from './logger.js';

interface AccountRiskProfile {
    ageInDays: number;
    messagesSentToday: number;
    messagesSentThisHour: number;
    consecutiveFailures: number;
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    allowedMessagesPerHour: number;
    allowedMessagesPerDay: number;
    minDelayMs: number;
    maxDelayMs: number;
}

/**
 * Calculate dynamic rate limits based on account age and behavior
 * New accounts = stricter limits, mature accounts = more flexibility
 */
export async function getAccountRiskProfile(sessionId: string): Promise<AccountRiskProfile> {
    const { data: session } = await supabase
        .from('sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (!session) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const connectedAt = new Date(session.connected_at || session.created_at);
    const ageInDays = (Date.now() - connectedAt.getTime()) / (1000 * 60 * 60 * 24);

    // Get hourly message count from Redis
    const hourKey = `messages:hour:${sessionId}:${new Date().getHours()}`;
    const messagesSentThisHour = parseInt((await redis.get(hourKey)) || '0');
    const messagesSentToday = session.daily_message_count || 0;

    // Check for consecutive failures (blocked/failed messages)
    const failureKey = `failures:${sessionId}`;
    const consecutiveFailures = parseInt((await redis.get(failureKey)) || '0');

    // Risk calculation
    let riskLevel: AccountRiskProfile['riskLevel'] = 'low';
    let allowedMessagesPerHour = 30;
    let allowedMessagesPerDay = 500;
    let minDelayMs = 5000;
    let maxDelayMs = 15000;

    // NEW ACCOUNT (0-7 days) - EXTREMELY CONSERVATIVE
    if (ageInDays < 7) {
        riskLevel = 'critical';
        allowedMessagesPerHour = 5;
        allowedMessagesPerDay = 50;
        minDelayMs = 20000; // 20 seconds minimum
        maxDelayMs = 60000; // 1 minute maximum
    }
    // YOUNG ACCOUNT (7-30 days) - VERY CONSERVATIVE
    else if (ageInDays < 30) {
        riskLevel = 'high';
        allowedMessagesPerHour = 10;
        allowedMessagesPerDay = 100;
        minDelayMs = 15000;
        maxDelayMs = 45000;
    }
    // MATURING ACCOUNT (30-90 days) - MODERATE
    else if (ageInDays < 90) {
        riskLevel = 'medium';
        allowedMessagesPerHour = 20;
        allowedMessagesPerDay = 200;
        minDelayMs = 10000;
        maxDelayMs = 30000;
    }
    // MATURE ACCOUNT (90+ days) - RELAXED
    else {
        riskLevel = 'low';
        allowedMessagesPerHour = 30;
        allowedMessagesPerDay = 300;
        minDelayMs = 5000;
        maxDelayMs = 15000;
    }

    // INCREASE RISK if consecutive failures detected
    if (consecutiveFailures > 5) {
        logger.warn({ sessionId, consecutiveFailures }, 'High failure rate detected - increasing restrictions');
        allowedMessagesPerHour = Math.floor(allowedMessagesPerHour / 2);
        allowedMessagesPerDay = Math.floor(allowedMessagesPerDay / 2);
        minDelayMs *= 2;
        maxDelayMs *= 2;
    }

    return {
        ageInDays,
        messagesSentToday,
        messagesSentThisHour,
        consecutiveFailures,
        riskLevel,
        allowedMessagesPerHour,
        allowedMessagesPerDay,
        minDelayMs,
        maxDelayMs,
    };
}

/**
 * Check if sending a message is allowed based on adaptive limits
 */
export async function canSendMessage(sessionId: string): Promise<{ allowed: boolean; reason?: string; waitTimeMs?: number }> {
    const profile = await getAccountRiskProfile(sessionId);

    // Check daily limit
    if (profile.messagesSentToday >= profile.allowedMessagesPerDay) {
        return {
            allowed: false,
            reason: `Daily limit reached (${profile.allowedMessagesPerDay} for ${profile.riskLevel} risk profile)`,
            waitTimeMs: 86400000, // 24 hours
        };
    }

    // Check hourly limit
    if (profile.messagesSentThisHour >= profile.allowedMessagesPerHour) {
        const nextHour = new Date();
        nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
        return {
            allowed: false,
            reason: `Hourly limit reached (${profile.allowedMessagesPerHour} for ${profile.riskLevel} risk profile)`,
            waitTimeMs: nextHour.getTime() - Date.now(),
        };
    }

    return { allowed: true };
}

/**
 * Increment hourly message counter
 */
export async function incrementHourlyCounter(sessionId: string): Promise<void> {
    const hour = new Date().getHours();
    const hourKey = `messages:hour:${sessionId}:${hour}`;

    await redis.incr(hourKey);
    await redis.expire(hourKey, 3600); // Expire after 1 hour
}

/**
 * Record a failed message attempt
 */
export async function recordFailure(sessionId: string): Promise<void> {
    const failureKey = `failures:${sessionId}`;
    const count = await redis.incr(failureKey);
    await redis.expire(failureKey, 3600); // Reset after 1 hour

    if (count > 3) {
        logger.warn({ sessionId, failureCount: count }, 'Multiple failures detected - potential ban risk');
    }
}

/**
 * Reset failure counter (call this on successful delivery)
 */
export async function resetFailures(sessionId: string): Promise<void> {
    const failureKey = `failures:${sessionId}`;
    await redis.del(failureKey);
}

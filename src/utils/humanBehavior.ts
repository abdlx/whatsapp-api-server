import { logger } from './logger.js';

/**
 * Simulate human sleep/work patterns to avoid 24/7 bot detection
 * Returns true if current time is "safe" for sending messages
 */
export function isHumanActiveTime(timezone: string = 'UTC'): { allowed: boolean; reason?: string } {
    const now = new Date();

    // Get hour in specified timezone (default UTC, should be user's local timezone)
    const localHour = new Date(now.toLocaleString('en-US', { timeZone: timezone })).getHours();

    // NIGHT HOURS (11 PM - 7 AM) - DO NOT SEND
    // Humans don't typically send business messages during sleep hours
    if (localHour >= 23 || localHour < 7) {
        return {
            allowed: false,
            reason: `Night hours (${localHour}:00 in ${timezone}) - humans are typically asleep`,
        };
    }

    // EARLY MORNING (7 AM - 9 AM) - REDUCED ACTIVITY
    // Light usage acceptable but reduced
    if (localHour >= 7 && localHour < 9) {
        // 50% chance to delay for more human-like pattern
        if (Math.random() < 0.5) {
            return {
                allowed: false,
                reason: 'Early morning - simulating reduced activity',
            };
        }
    }

    // LUNCH BREAK (12 PM - 2 PM) - REDUCED ACTIVITY
    if (localHour >= 12 && localHour < 14) {
        // 30% chance to delay
        if (Math.random() < 0.3) {
            return {
                allowed: false,
                reason: 'Lunch hours - simulating break time',
            };
        }
    }

    // WORK HOURS (9 AM - 6 PM) - OPTIMAL TIME
    // Best time for business messaging

    // EVENING (6 PM - 11 PM) - MODERATE ACTIVITY
    // Acceptable but slightly reduced

    return { allowed: true };
}

/**
 * Check if it's a weekend (many businesses don't operate on weekends)
 */
export function isWeekend(timezone: string = 'UTC'): boolean {
    const now = new Date();
    const localDay = new Date(now.toLocaleString('en-US', { timeZone: timezone })).getDay();
    return localDay === 0 || localDay === 6; // Sunday = 0, Saturday = 6
}

/**
 * Get random delay that varies by time of day
 * Morning: longer delays (less activity)
 * Midday: medium delays
 * Evening: longer delays
 */
export function getContextualDelay(timezone: string = 'UTC'): number {
    const now = new Date();
    const localHour = new Date(now.toLocaleString('en-US', { timeZone: timezone })).getHours();

    let minDelay: number;
    let maxDelay: number;

    // Peak hours (10 AM - 4 PM) - faster responses
    if (localHour >= 10 && localHour < 16) {
        minDelay = 3000;
        maxDelay = 10000;
    }
    // Early morning / Late evening - slower, more deliberate
    else if ((localHour >= 7 && localHour < 10) || (localHour >= 20 && localHour < 23)) {
        minDelay = 15000;
        maxDelay = 45000;
    }
    // Normal business hours
    else {
        minDelay = 8000;
        maxDelay = 25000;
    }

    return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

/**
 * Comprehensive check combining all human behavior heuristics
 */
export function shouldDelayForHumanBehavior(
    timezone: string = 'UTC',
    respectWeekends: boolean = false
): { shouldWait: boolean; reason?: string; suggestedWaitMs?: number } {
    // Check if it's weekend and business wants to respect weekends
    if (respectWeekends && isWeekend(timezone)) {
        const now = new Date();
        const monday = new Date(now);
        monday.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
        monday.setHours(9, 0, 0, 0);

        return {
            shouldWait: true,
            reason: 'Weekend - waiting for business hours',
            suggestedWaitMs: monday.getTime() - now.getTime(),
        };
    }

    // Check active hours
    const activeCheck = isHumanActiveTime(timezone);
    if (!activeCheck.allowed) {
        // Wait until 9 AM next day
        const now = new Date();
        const nextActive = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
        nextActive.setHours(9, 0, 0, 0);

        // If it's already past 9 AM today, schedule for tomorrow
        if (nextActive <= now) {
            nextActive.setDate(nextActive.getDate() + 1);
        }

        return {
            shouldWait: true,
            reason: activeCheck.reason,
            suggestedWaitMs: nextActive.getTime() - now.getTime(),
        };
    }

    return { shouldWait: false };
}

/**
 * Random "break time" simulation
 * Returns true if bot should take a random break (simulates human getting distracted)
 */
export function shouldTakeRandomBreak(breakProbability: number = 0.05): { takeBreak: boolean; breakDurationMs?: number } {
    if (Math.random() < breakProbability) {
        // Random break between 2-10 minutes
        const breakDurationMs = (2 + Math.random() * 8) * 60 * 1000;
        return { takeBreak: true, breakDurationMs };
    }
    return { takeBreak: false };
}

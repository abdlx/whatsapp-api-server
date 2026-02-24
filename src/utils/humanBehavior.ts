import { logger } from './logger.js';

// ─── Timezone-Safe Hour Extraction ────────────────────────────────────────────

/**
 * Extract the current hour in a specific timezone using Intl.DateTimeFormat.
 * This is the ONLY correct way to get timezone-local hours in Node.js without
 * a third-party library. The old `new Date(toLocaleString(...))` approach
 * re-parses the locale string as local server time, giving wrong results
 * when the server's TZ differs from the target TZ.
 */
function getHourInTimezone(timezone: string): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: 'numeric',
        hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
}

function getDayInTimezone(timezone: string): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short', // Sun, Mon, ...
    });
    const day = formatter.format(new Date());
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return dayMap[day] ?? 0;
}

// ─── Active Time Check ───────────────────────────────────────────────────────

/**
 * Simulate human sleep/work patterns to avoid 24/7 bot detection.
 * Returns true if current time is "safe" for sending messages.
 *
 * Only NIGHT HOURS (11 PM – 7 AM) are hard-blocked. Early morning and lunch
 * periods are handled by longer contextual delays (getContextualDelay), not by
 * random coin-flip rejections that cause noisy retries.
 */
export function isHumanActiveTime(timezone: string = 'UTC'): { allowed: boolean; reason?: string } {
    const localHour = getHourInTimezone(timezone);

    // NIGHT HOURS (11 PM - 7 AM) — hard block
    if (localHour >= 23 || localHour < 7) {
        return {
            allowed: false,
            reason: `Night hours (${localHour}:00 in ${timezone}) - humans are typically asleep`,
        };
    }

    // All other hours are allowed.
    // Early morning (7-9) and lunch (12-14) get longer delays via getContextualDelay()
    // instead of random allow/reject coin flips.
    return { allowed: true };
}

// ─── Weekend Check ───────────────────────────────────────────────────────────

/**
 * Check if it's a weekend (many businesses don't operate on weekends)
 */
export function isWeekend(timezone: string = 'UTC'): boolean {
    const localDay = getDayInTimezone(timezone);
    return localDay === 0 || localDay === 6; // Sunday = 0, Saturday = 6
}

// ─── Contextual Delay ────────────────────────────────────────────────────────

/**
 * Get random delay that varies by time of day.
 * Morning/evening: longer delays (less activity)
 * Midday: shorter delays (peak activity)
 */
export function getContextualDelay(timezone: string = 'UTC'): number {
    const localHour = getHourInTimezone(timezone);

    let minDelay: number;
    let maxDelay: number;

    // Peak hours (10 AM - 4 PM) — faster responses
    if (localHour >= 10 && localHour < 16) {
        minDelay = 3000;
        maxDelay = 10000;
    }
    // Early morning (7-10) / Late evening (20-23) — slower, more deliberate
    else if ((localHour >= 7 && localHour < 10) || (localHour >= 20 && localHour < 23)) {
        minDelay = 15000;
        maxDelay = 45000;
    }
    // Normal business hours (4 PM - 8 PM)
    else {
        minDelay = 8000;
        maxDelay = 25000;
    }

    return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// ─── Combined Check ──────────────────────────────────────────────────────────

/**
 * Comprehensive check combining all human behavior heuristics.
 * Calculates the wait time using timezone-safe arithmetic.
 */
export function shouldDelayForHumanBehavior(
    timezone: string = 'UTC',
    respectWeekends: boolean = false
): { shouldWait: boolean; reason?: string; suggestedWaitMs?: number } {
    // Check if it's weekend and business wants to respect weekends
    if (respectWeekends && isWeekend(timezone)) {
        // Calculate hours until Monday 9 AM in the target timezone
        const localDay = getDayInTimezone(timezone);
        const localHour = getHourInTimezone(timezone);

        // Days until Monday: Sunday(0) → 1 day, Saturday(6) → 2 days
        const daysUntilMonday = localDay === 0 ? 1 : (8 - localDay) % 7;
        const hoursUntilMonday9AM = (daysUntilMonday * 24) + (9 - localHour);
        const waitMs = Math.max(0, hoursUntilMonday9AM * 60 * 60 * 1000);

        return {
            shouldWait: true,
            reason: 'Weekend - waiting for business hours',
            suggestedWaitMs: waitMs,
        };
    }

    // Check active hours
    const activeCheck = isHumanActiveTime(timezone);
    if (!activeCheck.allowed) {
        // Calculate hours until 9 AM in the target timezone
        const localHour = getHourInTimezone(timezone);

        // If hour >= 23, wait (24 - localHour + 9) hours
        // If hour < 7, wait (9 - localHour) hours
        const hoursUntil9AM = localHour >= 23
            ? (24 - localHour) + 9
            : 9 - localHour;

        const waitMs = Math.max(0, hoursUntil9AM * 60 * 60 * 1000);

        return {
            shouldWait: true,
            reason: activeCheck.reason,
            suggestedWaitMs: waitMs,
        };
    }

    return { shouldWait: false };
}

// ─── Random Break Simulation ─────────────────────────────────────────────────

/**
 * Random "break time" simulation.
 * Returns true if bot should take a random break (simulates human getting distracted).
 */
export function shouldTakeRandomBreak(breakProbability: number = 0.05): { takeBreak: boolean; breakDurationMs?: number } {
    if (Math.random() < breakProbability) {
        // Random break between 2-10 minutes
        const breakDurationMs = (2 + Math.random() * 8) * 60 * 1000;
        return { takeBreak: true, breakDurationMs };
    }
    return { takeBreak: false };
}

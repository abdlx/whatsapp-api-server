import { env } from '../config/env.js';

/**
 * Wait for a random duration between min and max milliseconds.
 */
export async function randomDelay(min: number = env.MIN_DELAY_MS, max: number = env.MAX_DELAY_MS): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Calculate typing duration based on message length.
 */
export function typingDuration(message: string): number {
    return message.length * env.TYPING_SPEED_MS;
}

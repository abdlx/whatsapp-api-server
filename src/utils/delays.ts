import { env } from '../config/env.js';

/**
 * Box-Muller transform to generate a Gaussian (normal) distribution.
 */
export function gaussianRandom(mean: number, stdDev: number): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random(); // Converting [0,1) to (0,1)
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return Math.max(500, Math.floor(mean + z * stdDev)); // Clamp at 500ms minimum
}

/**
 * Wait for a natural-feeling human duration using a bell curve.
 */
export async function humanDelay(
    mean: number = (env.MIN_DELAY_MS + env.MAX_DELAY_MS) / 2,
    stdDev: number = (env.MAX_DELAY_MS - env.MIN_DELAY_MS) / 4
): Promise<void> {
    const delay = gaussianRandom(mean, stdDev);
    await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Wait for a random duration between min and max milliseconds (unform).
 * Keeping this for backward compatibility or non-behavioral uses.
 */
export async function randomDelay(min: number = env.MIN_DELAY_MS, max: number = env.MAX_DELAY_MS): Promise<void> {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Calculate typing duration based on message length with a bit of randomness.
 */
export function typingDuration(message: string): number {
    const base = message.length * env.TYPING_SPEED_MS;
    const variation = (Math.random() - 0.5) * 2 * (base * 0.2); // ±20% variation
    return Math.max(1000, Math.floor(base + variation));
}


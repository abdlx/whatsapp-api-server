/**
 * Rotate browser fingerprints to avoid detection from using same user agent forever
 * WhatsApp tracks the browser/device you're connecting from
 */

interface BrowserFingerprint {
    browser: [string, string, string]; // [name, type, version]
    userAgent?: string;
}

const CHROME_VERSIONS = ['120.0.0', '121.0.0', '122.0.0', '123.0.0', '124.0.0'];
const FIREFOX_VERSIONS = ['120.0', '121.0', '122.0', '123.0'];
const EDGE_VERSIONS = ['120.0.0.0', '121.0.0.0', '122.0.0.0'];

/**
 * Get a browser fingerprint that rotates periodically
 * Changes every 30 days to avoid suspicion
 */
export function getBrowserFingerprint(sessionId: string): BrowserFingerprint {
    // Use session ID and current month as seed for consistent rotation
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();
    const seed = `${sessionId}-${currentYear}-${currentMonth}`;

    // Simple hash function for deterministic randomness
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) - hash) + seed.charCodeAt(i);
        hash = hash & hash;
    }

    const random = Math.abs(hash);

    // Randomly select browser type (weighted towards Chrome - most common)
    const browserType = random % 10;

    if (browserType < 7) {
        // 70% Chrome
        const versionIndex = random % CHROME_VERSIONS.length;
        return {
            browser: ['Chrome', 'Desktop', CHROME_VERSIONS[versionIndex]],
        };
    } else if (browserType < 9) {
        // 20% Firefox
        const versionIndex = random % FIREFOX_VERSIONS.length;
        return {
            browser: ['Firefox', 'Desktop', FIREFOX_VERSIONS[versionIndex]],
        };
    } else {
        // 10% Edge
        const versionIndex = random % EDGE_VERSIONS.length;
        return {
            browser: ['Edge', 'Desktop', EDGE_VERSIONS[versionIndex]],
        };
    }
}

/**
 * Check if browser fingerprint should be rotated
 * Recommend rotating if session has been active for >30 days
 */
export function shouldRotateFingerprint(connectedAt: Date): boolean {
    const daysSinceConnection = (Date.now() - connectedAt.getTime()) / (1000 * 60 * 60 * 24);
    const currentMonth = new Date().getMonth();
    const connectionMonth = connectedAt.getMonth();

    // Rotate if month has changed and session is >30 days old
    return daysSinceConnection > 30 && currentMonth !== connectionMonth;
}

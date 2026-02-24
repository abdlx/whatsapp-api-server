import { parsePhoneNumber, CountryCode } from 'libphonenumber-js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

export interface Proxy {
    id: string;
    host: string;
    port: number;
    username?: string;
    password?: string;
    country_code: string;
}

export class ProxyManager {
    /**
     * Extracts country code from phone number.
     * Expected format: E.164 (e.g. +923001234567)
     */
    async getCountryCodeFromPhone(phoneNumber: string): Promise<string> {
        try {
            const parsed = parsePhoneNumber(phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`);
            return parsed?.country || 'US';
        } catch (error) {
            logger.warn({ phoneNumber, error }, 'Failed to parse phone number for country code');
            return 'US'; // Default fallback
        }
    }

    /**
     * Assigns a sticky proxy to a session based on country matching.
     */
    async assignProxy(sessionId: string, phoneNumber: string): Promise<Proxy | null> {
        const countryCode = await this.getCountryCodeFromPhone(phoneNumber);

        logger.info({ sessionId, phoneNumber, countryCode }, 'Attempting to assign geo-matched proxy');

        // Hierarchy logic
        const targetCountries = this.getCountryFallbacks(countryCode);

        for (const target of targetCountries) {
            const { data: proxy, error } = await supabase
                .from('proxies')
                .select('*')
                .eq('country_code', target)
                .eq('is_active', true)
                .is('assigned_session_id', null)
                .limit(1)
                .maybeSingle();

            if (proxy && !error) {
                // Mark as assigned
                await supabase
                    .from('proxies')
                    .update({
                        assigned_session_id: sessionId,
                        last_assigned_at: new Date().toISOString()
                    })
                    .eq('id', proxy.id);

                await supabase
                    .from('sessions')
                    .update({
                        proxy_id: proxy.id,
                        phone_country_code: countryCode,
                        phone_number: phoneNumber
                    })
                    .eq('id', sessionId);

                logger.info({ sessionId, proxyId: proxy.id, country: proxy.country_code }, 'Proxy assigned successfully');
                return proxy as Proxy;
            }
        }

        logger.warn({ sessionId, countryCode }, 'No matching proxy found in pool');
        return null;
    }

    /**
     * Release proxy back to pool.
     */
    async releaseProxy(sessionId: string): Promise<void> {
        await supabase
            .from('proxies')
            .update({ assigned_session_id: null })
            .eq('assigned_session_id', sessionId);
    }

    /**
     * Fetch the assigned proxy for a session.
     */
    async getProxyForSession(sessionId: string): Promise<Proxy | null> {
        const { data: session } = await supabase
            .from('sessions')
            .select('proxy_id')
            .eq('id', sessionId)
            .maybeSingle();

        if (session?.proxy_id) {
            const { data: proxy } = await supabase
                .from('proxies')
                .select('*')
                .eq('id', session.proxy_id)
                .maybeSingle();

            return proxy as Proxy;
        }

        return null;
    }

    private getCountryFallbacks(country: string): string[] {
        const fallbacks: Record<string, string[]> = {
            'PK': ['PK', 'IN', 'AE', 'US'],
            'IN': ['IN', 'PK', 'AE', 'US'],
            'US': ['US', 'CA', 'GB'],
            'GB': ['GB', 'IE', 'US'],
            'AE': ['AE', 'SA', 'EG', 'US'],
        };

        return fallbacks[country] || [country, 'US'];
    }
}

export const proxyManager = new ProxyManager();

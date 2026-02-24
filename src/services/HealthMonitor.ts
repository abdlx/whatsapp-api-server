import { sessionManager } from '../core/SessionManager.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import axios from 'axios';

export class HealthMonitor {
    private checkInterval: NodeJS.Timeout | null = null;
    private intervalMs: number;

    constructor(intervalMs: number = 30000) {
        this.intervalMs = intervalMs;
    }

    start(): void {
        if (this.checkInterval) return;

        logger.info({ intervalMs: this.intervalMs }, 'Health monitor started');

        this.checkInterval = setInterval(async () => {
            await this.runHealthChecks();
        }, this.intervalMs);
    }

    stop(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            logger.info('Health monitor stopped');
        }
    }

    private async runHealthChecks(): Promise<void> {
        const { data: sessions } = await supabase
            .from('sessions')
            .select('id, agent_name, status')
            .eq('status', 'active');

        if (!sessions || sessions.length === 0) return;

        await Promise.allSettled(sessions.map(async (session) => {
            const client = await sessionManager.getSession(session.id);

            if (!client || client.connectionState !== 'open') {
                logger.warn({ sessionId: session.id }, 'Session disconnected, attempting reconnect');

                await this.sendAlert({
                    severity: 'warning',
                    sessionId: session.id,
                    agentName: session.agent_name,
                    message: 'Session disconnected, attempting reconnect',
                    timestamp: new Date().toISOString(),
                });

                if (client) {
                    try {
                        await client.reconnect();
                        logger.info({ sessionId: session.id }, 'Reconnect successful');
                    } catch (error) {
                        logger.error({ sessionId: session.id, error }, 'Reconnect failed');

                        await supabase
                            .from('sessions')
                            .update({ status: 'disconnected' })
                            .eq('id', session.id);

                        await this.sendAlert({
                            severity: 'critical',
                            sessionId: session.id,
                            agentName: session.agent_name,
                            message: 'Reconnect failed - manual intervention required',
                            timestamp: new Date().toISOString(),
                        });
                    }
                }
            } else {
                // Background update
                Promise.resolve(
                    supabase
                        .from('sessions')
                        .update({ last_active: new Date().toISOString() })
                        .eq('id', session.id)
                ).catch(() => { });

            }
        }));
    }


    private async sendAlert(alert: {
        severity: string;
        sessionId: string;
        agentName: string;
        message: string;
        timestamp: string;
    }): Promise<void> {
        if (!env.ALERT_WEBHOOK_URL) return;

        try {
            await axios.post(env.ALERT_WEBHOOK_URL, {
                text: `[${alert.severity.toUpperCase()}] WhatsApp Session: ${alert.agentName}\n${alert.message}`,
                ...alert,
            });
        } catch (error) {
            logger.error({ error }, 'Failed to send alert');
        }
    }
}

export const healthMonitor = new HealthMonitor();

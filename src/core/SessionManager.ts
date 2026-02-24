import { WhatsAppClient } from './WhatsAppClient.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { proxyManager } from './ProxyManager.js';
import { redis } from '../config/redis.js';

export class SessionManager {
    private sessions: Map<string, WhatsAppClient> = new Map();
    private heartbeatInterval: NodeJS.Timeout | null = null;

    /**
     * Start session heartbeats in Redis to track ownership in a cluster.
     */
    startHeartbeats() {
        if (this.heartbeatInterval) return;
        this.heartbeatInterval = setInterval(async () => {
            const pipeline = redis.pipeline();
            for (const sessionId of this.sessions.keys()) {
                pipeline.set(`session:owner:${sessionId}`, process.pid.toString(), 'EX', 60);
            }
            await pipeline.exec();
        }, 30000);
    }

    async createSession(agentId: string, agentName: string, phoneNumber: string): Promise<{ sessionId: string; qr: string | null }> {
        // Check if session already exists
        if (this.sessions.has(agentId)) {
            const existing = this.sessions.get(agentId)!;
            if (existing.connectionState === 'open') {
                throw new Error(`Session ${agentId} already exists and is connected`);
            }
        }

        // 1. Assign geo-matched residential proxy
        await proxyManager.assignProxy(agentId, phoneNumber);

        // 2. Create/Update database entry
        const { error } = await supabase.from('sessions').upsert({
            id: agentId,
            agent_name: agentName,
            phone_number: phoneNumber,
            status: 'pairing',
            updated_at: new Date().toISOString(),
        });

        if (error) {
            logger.error({ error, agentId }, 'Failed to create session in database');
            throw error;
        }

        // 3. Create client and connect
        const client = new WhatsAppClient(agentId);
        const qr = await client.connect();

        this.sessions.set(agentId, client);
        logger.info({ agentId, agentName }, 'Session created');

        return { sessionId: agentId, qr };
    }

    async getSession(agentId: string): Promise<WhatsAppClient | null> {
        return this.sessions.get(agentId) || null;
    }

    async getSessionStatus(agentId: string): Promise<{
        status: string;
        phoneNumber: string | null;
        lastActive: string | null;
        dailyMessageCount: number;
    } | null> {
        const { data, error } = await supabase
            .from('sessions')
            .select('status, phone_number, last_active, daily_message_count')
            .eq('id', agentId)
            .single();

        if (error || !data) return null;

        return {
            status: data.status,
            phoneNumber: data.phone_number,
            lastActive: data.last_active,
            dailyMessageCount: data.daily_message_count,
        };
    }

    async deleteSession(agentId: string): Promise<void> {
        const client = this.sessions.get(agentId);
        if (client) {
            await client.disconnect();
            this.sessions.delete(agentId);
        }

        // Release proxy and owner
        await proxyManager.releaseProxy(agentId);
        await redis.del(`session:owner:${agentId}`);

        // Delete from database
        await supabase.from('sessions').delete().eq('id', agentId);

        logger.info({ agentId }, 'Session deleted');
    }

    /**
     * Concurrent restoration of all active sessions.
     */
    async restoreAllSessions(): Promise<void> {
        logger.info('Restoring active sessions from database...');

        const { data: sessions } = await supabase
            .from('sessions')
            .select('id, auth_state_backup')
            .in('status', ['active', 'error']);

        if (!sessions || sessions.length === 0) {
            logger.info('No active sessions to restore');
            return;
        }

        const { decrypt } = await import('../utils/encryption.js');

        const restorePromises = sessions.map(async (session) => {
            try {
                // Check if already owned by another process in the cluster
                const owner = await redis.get(`session:owner:${session.id}`);
                if (owner && owner !== process.pid.toString()) {
                    logger.debug({ sessionId: session.id, owner }, 'Session owned by another process, skipping restoration');
                    return;
                }

                // Verify if auth state exists in Redis
                const redisCreds = await redis.get(`auth:${session.id}:creds`);
                if (!redisCreds && session.auth_state_backup) {
                    try {
                        const decrypted = decrypt(session.auth_state_backup);
                        await redis.set(`auth:${session.id}:creds`, decrypted);
                        logger.info({ sessionId: session.id }, 'Restored auth state from Supabase backup to Redis');
                    } catch (decryptError) {
                        logger.error({ sessionId: session.id, error: decryptError }, 'Failed to decrypt session backup');
                    }
                }

                const client = new WhatsAppClient(session.id);
                await client.connect();
                this.sessions.set(session.id, client);

                // Mark ownership
                await redis.set(`session:owner:${session.id}`, process.pid.toString(), 'EX', 60);

                logger.info({ sessionId: session.id }, 'Session restored');
            } catch (error) {
                logger.error({ sessionId: session.id, error }, 'Failed to restore session');
            }
        });

        await Promise.allSettled(restorePromises);
        this.startHeartbeats();

        logger.info({ count: this.sessions.size }, 'Session restoration complete');
    }


    async disconnectAll(): Promise<void> {
        logger.info('Disconnecting all sessions...');

        for (const [id, client] of this.sessions) {
            try {
                await client.disconnect();
                await redis.del(`session:owner:${id}`);
                logger.info({ sessionId: id }, 'Session disconnected');
            } catch (error) {
                logger.error({ sessionId: id, error }, 'Error disconnecting session');
            }
        }

        this.sessions.clear();
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    getActiveSessionCount(): number {
        return this.sessions.size;
    }
}

export const sessionManager = new SessionManager();


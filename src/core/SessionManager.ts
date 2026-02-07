import { WhatsAppClient } from './WhatsAppClient.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import { decrypt } from '../utils/encryption.js';
import fs from 'fs/promises';
import path from 'path';

export class SessionManager {
    private sessions: Map<string, WhatsAppClient> = new Map();

    async createSession(agentId: string, agentName: string): Promise<{ sessionId: string; qr: string | null }> {
        // Check if session already exists
        if (this.sessions.has(agentId)) {
            const existing = this.sessions.get(agentId)!;
            if (existing.connectionState === 'open') {
                throw new Error(`Session ${agentId} already exists and is connected`);
            }
        }

        // Create database entry
        const { error } = await supabase.from('sessions').upsert({
            id: agentId,
            agent_name: agentName,
            status: 'pairing',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        });

        if (error) {
            logger.error({ error, agentId }, 'Failed to create session in database');
            throw error;
        }

        // Create client and connect
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

        // Delete from database
        await supabase.from('sessions').delete().eq('id', agentId);

        // Delete local session files
        const sessionPath = path.join(process.cwd(), 'sessions', agentId);
        try {
            await fs.rm(sessionPath, { recursive: true, force: true });
        } catch {
            // Ignore errors if directory doesn't exist
        }

        logger.info({ agentId }, 'Session deleted');
    }

    async restoreAllSessions(): Promise<void> {
        logger.info('Restoring active sessions from database...');

        const { data: sessions } = await supabase
            .from('sessions')
            .select('id, auth_state_backup')
            .eq('status', 'active');

        if (!sessions || sessions.length === 0) {
            logger.info('No active sessions to restore');
            return;
        }

        for (const session of sessions) {
            try {
                // Restore auth state from backup if local files don't exist
                const sessionPath = path.join(process.cwd(), 'sessions', session.id);
                const credsPath = path.join(sessionPath, 'creds.json');

                try {
                    await fs.access(credsPath);
                } catch {
                    // Local creds don't exist, restore from backup
                    if (session.auth_state_backup) {
                        await fs.mkdir(sessionPath, { recursive: true });
                        const decrypted = decrypt(session.auth_state_backup);
                        await fs.writeFile(credsPath, decrypted);
                        logger.info({ sessionId: session.id }, 'Restored auth state from backup');
                    }
                }

                // Connect
                const client = new WhatsAppClient(session.id);
                await client.connect();
                this.sessions.set(session.id, client);

                logger.info({ sessionId: session.id }, 'Session restored');
            } catch (error) {
                logger.error({ sessionId: session.id, error }, 'Failed to restore session');
            }
        }

        logger.info({ count: sessions.length }, 'Session restoration complete');
    }

    async disconnectAll(): Promise<void> {
        logger.info('Disconnecting all sessions...');

        for (const [id, client] of this.sessions) {
            try {
                await client.disconnect();
                logger.info({ sessionId: id }, 'Session disconnected');
            } catch (error) {
                logger.error({ sessionId: id, error }, 'Error disconnecting session');
            }
        }

        this.sessions.clear();
    }

    getActiveSessionCount(): number {
        return this.sessions.size;
    }
}

// Export singleton instance
export const sessionManager = new SessionManager();

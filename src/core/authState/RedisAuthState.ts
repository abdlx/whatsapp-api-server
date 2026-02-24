import {
    AuthenticationState,
    AuthenticationCreds,
    SignalDataTypeMap,
    initAuthCreds,
    BufferJSON,
    proto,
} from '@whiskeysockets/baileys';
import { Redis } from 'ioredis';
import { logger } from '../../utils/logger.js';

/**
 * Custom Baileys Auth State using Redis for atomic, distributed session storage.
 * Fixes filesystem corruption and allows multi-instance scaling.
 */
export async function useRedisAuthState(redis: Redis, sessionId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
    const keyPrefix = `auth:${sessionId}:`;

    const writeData = async (data: any, key: string) => {
        const value = JSON.stringify(data, BufferJSON.replacer);
        await redis.set(`${keyPrefix}${key}`, value);
    };

    const readData = async (key: string) => {
        try {
            const data = await redis.get(`${keyPrefix}${key}`);
            if (!data) return null;
            return JSON.parse(data, BufferJSON.reviver);
        } catch (error) {
            logger.error({ sessionId, key, error }, 'Failed to read auth data from Redis');
            return null;
        }
    };

    const removeData = async (key: string) => {
        await redis.del(`${keyPrefix}${key}`);
    };

    // Load or initialize credentials
    const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [id: string]: any } = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const pipeline = redis.pipeline();
                    for (const category in data) {
                        const categoryData = data[category as keyof SignalDataTypeMap];
                        if (!categoryData) continue;

                        for (const id in categoryData) {
                            const value = categoryData[id];
                            const key = `${category}-${id}`;
                            if (value) {
                                pipeline.set(`${keyPrefix}${key}`, JSON.stringify(value, BufferJSON.replacer));
                            } else {
                                pipeline.del(`${keyPrefix}${key}`);
                            }
                        }
                    }
                    await pipeline.exec();
                },
            },
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        },
    };
}

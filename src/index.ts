import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { createApp, type ClickEventPublisher } from './app.ts';
import { MongoClickEventWriter, MongoClickOutbox, RabbitClickQueue } from './click-events.ts';

const port = Number(process.env.PORT ?? 3000);
const mongoUri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const databaseName = process.env.MONGODB_DB ?? 'url-shortener';
const cacheRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const counterRedisUrl = process.env.COUNTER_REDIS_URL ?? 'redis://localhost:6381';
const rabbitMqUrl = process.env.RABBITMQ_URL ?? 'amqp://localhost:5672';
const cacheEnabled = process.env.CACHE_ENABLED !== 'false';
const shortCodeSecret = process.env.SHORT_CODE_SECRET ?? '';
const clickEventsMode = process.env.CLICK_EVENTS_MODE ?? 'outbox';
const counterId = 'short-url-sequence';
const counterKey = 'url-shortener:short-code-sequence:v1';

const ensureCounterScript = `
    local current = tonumber(redis.call('GET', KEYS[1]) or '0')
    local minimum = tonumber(ARGV[1])
    if current < minimum then
        redis.call('SET', KEYS[1], ARGV[1])
        return ARGV[1]
    end
    return tostring(current)
`;

async function startServer(): Promise<void> {
    if (Buffer.byteLength(shortCodeSecret, 'utf8') < 32) {
        throw new Error('Set SHORT_CODE_SECRET to a stable secret of at least 32 bytes');
    }
    if (clickEventsMode !== 'outbox' && clickEventsMode !== 'direct') {
        throw new Error('CLICK_EVENTS_MODE must be either "outbox" or "direct"');
    }

    const mongoClient = new MongoClient(mongoUri);
    let counterRedisClient: ReturnType<typeof createClient> | undefined;
    let cacheRedisClient: ReturnType<typeof createClient> | undefined;
    let clickQueue: RabbitClickQueue | undefined;

    try {
        await mongoClient.connect();
        const db = mongoClient.db(databaseName);
        const urls = db.collection('urls');
        const counters = db.collection<{ _id: string; value?: number }>('counters');

        await urls.createIndex(
            { shortenedUrl: 1 },
            { unique: true, name: 'shortenedUrl_unique' },
        );
        await urls.createIndex(
            { numericId: 1 },
            {
                unique: true,
                name: 'numericId_unique',
                partialFilterExpression: { numericId: { $type: 'number' } },
            },
        );
        await urls.createIndex(
            { expiresAt: 1 },
            { expireAfterSeconds: 0, name: 'expiresAt_ttl' },
        );
        if (clickEventsMode === 'outbox') {
            const clickOutbox = db.collection('click_outbox');
            await clickOutbox.createIndex({ status: 1, retryAt: 1, createdAt: 1 }, { name: 'outbox_pending' });
            await clickOutbox.createIndex({ status: 1, leaseUntil: 1 }, { name: 'outbox_lease' });
            await clickOutbox.createIndex(
                { publishedAt: 1 },
                { expireAfterSeconds: 604_800, name: 'outbox_published_ttl' },
            );
        }

        counterRedisClient = createClient({ url: counterRedisUrl });
        counterRedisClient.on('error', (error) => console.error('Counter Redis client error:', error));
        await counterRedisClient.connect();

        async function durableHighWaterMark(): Promise<number> {
            const checkpoint = await counters.findOne({ _id: counterId });
            const newestUrl = await urls.findOne(
                { numericId: { $type: 'number' } },
                { sort: { numericId: -1 }, projection: { numericId: 1 } },
            );
            const value = Math.max(Number(checkpoint?.value ?? 0), Number(newestUrl?.numericId ?? 0));
            if (!Number.isSafeInteger(value) || value < 0) {
                throw new Error('The durable short-code counter is outside the safe integer range');
            }
            return value;
        }

        async function ensureCounterAtLeast(minimum: number): Promise<void> {
            await counterRedisClient!.eval(ensureCounterScript, {
                keys: [counterKey],
                arguments: [String(minimum)],
            });
        }

        async function restoreCounter(): Promise<void> {
            await ensureCounterAtLeast(await durableHighWaterMark());
        }

        // Recover Redis from MongoDB if its data volume was restored or recreated.
        await restoreCounter();

        const idSequence = {
            next: async (): Promise<number> => {
                const checkpoint = await counters.findOne({ _id: counterId });
                const minimum = Number(checkpoint?.value ?? 0);
                if (!Number.isSafeInteger(minimum) || minimum < 0) {
                    throw new Error('The durable short-code counter is invalid');
                }
                await ensureCounterAtLeast(minimum);
                const numericId = await counterRedisClient!.incr(counterKey);
                if (!Number.isSafeInteger(numericId) || numericId < 1) {
                    throw new Error('The Redis counter exceeded the safe integer range');
                }
                return numericId;
            },
            record: async (numericId: number): Promise<void> => {
                // Keep a durable high-water mark in MongoDB as recovery protection.
                await counters.updateOne(
                    { _id: counterId },
                    { $max: { value: numericId } },
                    { upsert: true },
                );
            },
            recover: restoreCounter,
        };

        if (cacheEnabled) {
            cacheRedisClient = createClient({ url: cacheRedisUrl });
            cacheRedisClient.on('error', (error) => console.error('Redis cache client error:', error));
            // Cache is optional; redirects fall back to MongoDB until Redis reconnects.
            void cacheRedisClient.connect().catch((error: unknown) => {
                console.error('Could not connect to Redis cache; continuing without cache:', error);
            });
        }

        const cache = cacheRedisClient ? {
            get: async (shortCode: string) => {
                if (!cacheRedisClient!.isReady) throw new Error('Redis cache is not ready');
                return cacheRedisClient!.get(`url:${shortCode}`);
            },
            set: async (shortCode: string, originalUrl: string, ttlMs: number) => {
                if (!cacheRedisClient!.isReady) throw new Error('Redis cache is not ready');
                await cacheRedisClient!.set(`url:${shortCode}`, originalUrl, {
                    expiration: { type: 'PX', value: Math.max(1, Math.floor(ttlMs)) },
                });
            },
        } : undefined;

        let clickEvents: ClickEventPublisher;
        if (clickEventsMode === 'outbox') {
            clickQueue = new RabbitClickQueue(rabbitMqUrl, db);
            await clickQueue.start();
            clickEvents = new MongoClickOutbox(db);
        } else {
            clickEvents = new MongoClickEventWriter(db);
        }
        const healthChecks = {
            clickEventsMode,
            mongo: async () => { await db.command({ ping: 1 }); },
            counter: async () => { await counterRedisClient!.sendCommand(['PING']); },
            queue: async () => {
                if (!clickQueue) throw new Error('RabbitMQ is disabled in direct click-event mode');
                await clickQueue.check();
            },
        };

        console.log(`Connected to MongoDB database "${databaseName}" and durable Redis counter; click events use ${clickEventsMode} mode`);
        const server = createApp(db, idSequence, shortCodeSecret, clickEvents, healthChecks, cache).listen(port, () => {
            console.log(`Server is running on http://localhost:${port}`);
        });

        const shutdown = (signal: NodeJS.Signals) => {
            console.log(`${signal} received; closing server and database connections...`);
            server.close((error) => {
                if (error) {
                    console.error('Error closing HTTP server:', error);
                    process.exitCode = 1;
                }
                void (async () => {
                    await clickQueue?.close();
                    await mongoClient.close();
                    if (cacheRedisClient?.isOpen) await cacheRedisClient.close();
                    else cacheRedisClient?.destroy();
                    if (counterRedisClient?.isOpen) await counterRedisClient.close();
                    else counterRedisClient?.destroy();
                })();
            });
        };

        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    } catch (error) {
        await clickQueue?.close();
        if (cacheRedisClient?.isOpen) await cacheRedisClient.close();
        else cacheRedisClient?.destroy();
        if (counterRedisClient?.isOpen) await counterRedisClient.close();
        else counterRedisClient?.destroy();
        await mongoClient.close();
        throw error;
    }
}

startServer().catch((error: unknown) => {
    console.error('Error starting server:', error);
    process.exitCode = 1;
});

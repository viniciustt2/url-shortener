import express, { type ErrorRequestHandler, type Express, type Request } from 'express';
import { MongoServerError, type Db } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { encodeShortCode } from './short-codes.ts';

const linkLifetimeYears = 5;
const maxCodeAttempts = 5;
const createLinkLimit = 10;
const createLinkWindowMs = 60_000;

type RateLimitEntry = {
    count: number;
    resetAt: number;
};

export type UrlCache = {
    get(shortCode: string): Promise<string | null>;
    set(shortCode: string, originalUrl: string, ttlMs: number): Promise<void>;
};

export type UrlIdSequence = {
    next(): Promise<number>;
    record(id: number): Promise<void>;
    recover(): Promise<void>;
};

export type ClickEventPublisher = {
    publish(event: { eventId: string; shortCode: string; clickedAt: string }): Promise<void>;
};

export type HealthChecks = {
    mongo(): Promise<void>;
    counter(): Promise<void>;
    queue(): Promise<void>;
};

function createLinkRateLimiter() {
    const clients = new Map<string, RateLimitEntry>();
    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [ip, entry] of clients) {
            if (entry.resetAt <= now) clients.delete(ip);
        }
    }, createLinkWindowMs);
    cleanup.unref();

    return (req: Request, res: express.Response, next: express.NextFunction) => {
        const now = Date.now();
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        let entry = clients.get(ip);

        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + createLinkWindowMs };
            clients.set(ip, entry);
        }

        const secondsUntilReset = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        res.setHeader('RateLimit-Limit', createLinkLimit);
        res.setHeader('RateLimit-Reset', secondsUntilReset);

        if (entry.count >= createLinkLimit) {
            res.setHeader('RateLimit-Remaining', 0);
            res.setHeader('Retry-After', secondsUntilReset);
            return res.status(429).json({
                error: 'Too many link creation requests. Try again later.',
            });
        }

        entry.count += 1;
        res.setHeader('RateLimit-Remaining', createLinkLimit - entry.count);
        return next();
    };
}

function parseHttpUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
        return null;
    }

    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }
        return parsed.toString();
    } catch {
        return null;
    }
}

function isDuplicateKeyError(error: unknown): boolean {
    return error instanceof MongoServerError && error.code === 11000;
}

export function createApp(
    db: Db,
    idSequence: UrlIdSequence,
    shortCodeSecret: string,
    clickEvents: ClickEventPublisher,
    healthChecks: HealthChecks,
    cache?: UrlCache,
): Express {
    const app = express();
    const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
    if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);
    app.use(express.json({ limit: '10kb' }));

    app.get('/health/live', (_req, res) => res.status(200).json({ status: 'ok' }));
    app.get('/health/ready', async (_req, res) => {
        try {
            await Promise.all([healthChecks.mongo(), healthChecks.counter()]);
        } catch {
            return res.status(503).json({ status: 'not_ready' });
        }
        let rabbitmq = 'ready';
        try {
            await healthChecks.queue();
        } catch {
            rabbitmq = 'degraded';
        }
        return res.status(200).json({ status: 'ready', rabbitmq });
    });

    app.get('/api/v1/:shortCode/stats', async (req, res) => {
        const link = await db.collection('urls').findOne(
            { shortenedUrl: req.params.shortCode, expiresAt: { $gt: new Date() } },
            { projection: { _id: 1 } },
        );
        if (!link) return res.status(404).json({ error: 'URL not found or expired' });
        const clicks = await db.collection('click_events').countDocuments({ shortCode: req.params.shortCode });
        return res.status(200).json({ shortCode: req.params.shortCode, clicks });
    });

    app.post('/api/v1/shorten', createLinkRateLimiter(), async (req: Request, res) => {
        const originalUrl = parseHttpUrl(req.body?.url);
        if (!originalUrl) {
            return res.status(400).json({
                error: 'A valid HTTP or HTTPS URL is required (maximum 2048 characters)',
            });
        }

        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setFullYear(expiresAt.getFullYear() + linkLifetimeYears);

        for (let attempt = 0; attempt < maxCodeAttempts; attempt += 1) {
            let numericId: number;
            let shortenedUrl: string;
            try {
                numericId = await idSequence.next();
                await idSequence.record(numericId);
                shortenedUrl = encodeShortCode(numericId, shortCodeSecret);
            } catch (error) {
                console.error('Could not allocate a durable short-code ID:', error);
                return res.status(503).json({ error: 'Short code generation is temporarily unavailable' });
            }

            try {
                await db.collection('urls').insertOne({
                    numericId,
                    shortenedUrl,
                    originalUrl,
                    createdAt: now,
                    expiresAt,
                });

                return res.status(201).json({ shortenedUrl, expiresAt });
            } catch (error) {
                if (isDuplicateKeyError(error)) {
                    await idSequence.recover();
                    continue;
                }
                throw error;
            }
        }

        throw new Error('Could not allocate a unique short code after several attempts');
    });

    app.get('/api/v1/:shortCode', async (req, res) => {
        const { shortCode } = req.params;
        const now = new Date();
        const collection = db.collection('urls');
        let originalUrl: string | null = null;

        if (cache) {
            try {
                originalUrl = await cache.get(shortCode);
            } catch (error) {
                console.warn('Redis cache read failed; falling back to MongoDB:', error);
            }
        }

        if (!originalUrl) {
            const link = await collection.findOne({
                shortenedUrl: shortCode,
                expiresAt: { $gt: now },
            });

            if (!link) {
                return res.status(404).json({ error: 'URL not found or expired' });
            }

            originalUrl = link.originalUrl;
            if (cache) {
                const ttlMs = link.expiresAt.getTime() - now.getTime();
                if (ttlMs > 0) {
                    try {
                        await cache.set(shortCode, link.originalUrl, ttlMs);
                    } catch (error) {
                        console.warn('Redis cache write failed; continuing with MongoDB:', error);
                    }
                }
            }
        }

        const redirectUrl = originalUrl;
        if (!redirectUrl) return res.status(404).json({ error: 'URL not found or expired' });

        try {
            await clickEvents.publish({
                eventId: randomUUID(),
                shortCode,
                clickedAt: new Date().toISOString(),
            });
        } catch (error) {
            console.error('Could not persist click event in MongoDB outbox; continuing redirect:', error);
        }

        return res.redirect(302, redirectUrl);
    });

    const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
        if (error instanceof SyntaxError && 'body' in error) {
            return res.status(400).json({ error: 'Request body must contain valid JSON' });
        }

        console.error('Request failed:', error);
        return res.status(500).json({ error: 'Internal server error' });
    };

    app.use(errorHandler);
    return app;
}

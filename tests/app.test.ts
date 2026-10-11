import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Db } from 'mongodb';
import { createApp, type UrlCache, type UrlIdSequence } from '../src/app.ts';
import { encodeShortCode } from '../src/short-codes.ts';

const testSecret = 'portfolio-secret-value-with-at-least-32-bytes';

type StoredUrl = {
    _id: string;
    numericId?: number;
    shortenedUrl: string;
    originalUrl: string;
    createdAt: Date;
    expiresAt: Date;
    clicks: number;
};

let storedUrls: StoredUrl[];
let servers: Server[];
let baseUrl: string;
let findCalls: number;
let publishedClicks: Array<{ eventId: string; shortCode: string; clickedAt: string }>;

function createMemoryDb(): Db {
    storedUrls = [];
    findCalls = 0;
    const clickEvents: Array<{ _id: string; shortCode: string }> = [];
    const urls = {
        insertOne: async (document: Omit<StoredUrl, '_id'>) => {
            const stored = { ...document, _id: `url-${storedUrls.length}` };
            storedUrls.push(stored);
            return { insertedId: stored._id };
        },
        findOne: async (filter: {
            shortenedUrl: string;
            expiresAt: { $gt: Date };
        }) => {
            findCalls += 1;
            return storedUrls.find((document) =>
                document.shortenedUrl === filter.shortenedUrl &&
                document.expiresAt > filter.expiresAt.$gt,
            ) ?? null;
        },
        countDocuments: async (filter: { shortCode: string }) => clickEvents.filter((event) => event.shortCode === filter.shortCode).length,
    };
    const clickCollection = {
        updateOne: async (filter: { _id: string }, update: { $setOnInsert: { shortCode: string } }) => {
            if (!clickEvents.some((event) => event._id === filter._id)) {
                clickEvents.push({ _id: filter._id, shortCode: update.$setOnInsert.shortCode });
            }
            return { upsertedCount: 1 };
        },
    };

    return { collection: (name: string) => name === 'click_events' ? clickCollection : urls } as unknown as Db;
}

function createTestSequence(): UrlIdSequence {
    let currentId = 0;
    return {
        next: async () => ++currentId,
        record: async () => {},
        recover: async () => {},
    };
}

async function listenApp(app: ReturnType<typeof createApp>): Promise<string> {
    const server = app.listen(0);
    servers.push(server);
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
    servers = [];
    publishedClicks = [];
    baseUrl = await listenApp(createApp(
        createMemoryDb(), createTestSequence(), testSecret,
        { publish: async (event) => { publishedClicks.push(event); } },
        { mongo: async () => {}, counter: async () => {}, queue: async () => {} },
    ));
});

afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    })));
});

test('creates a short URL, redirects to it, and queues a click event', async () => {
    const createResponse = await fetch(`${baseUrl}/api/v1/shorten`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/articles/design' }),
    });

    assert.equal(createResponse.status, 201);
    const created = await createResponse.json() as { shortenedUrl: string; expiresAt: string };
    assert.equal(created.shortenedUrl, encodeShortCode(1, testSecret));
    assert.ok(Date.parse(created.expiresAt) > Date.now());

    const redirectResponse = await fetch(`${baseUrl}/api/v1/${created.shortenedUrl}`, {
        redirect: 'manual',
    });
    assert.equal(redirectResponse.status, 302);
    assert.equal(redirectResponse.headers.get('location'), 'https://example.com/articles/design');
    assert.equal(publishedClicks.length, 1);
    assert.equal(publishedClicks[0].shortCode, created.shortenedUrl);
    assert.ok(publishedClicks[0].eventId);
});

test('stores a Redis sequence ID and encodes it with the shared secret', async () => {
    const db = createMemoryDb();
    const allocatedIds: number[] = [];
    const sequence: UrlIdSequence = {
        next: async () => 42,
        record: async (id) => { allocatedIds.push(id); },
        recover: async () => {},
    };
    const secret = testSecret;
    const sequenceBaseUrl = await listenApp(createApp(
        db, sequence, secret,
        { publish: async (event) => { publishedClicks.push(event); } },
        { mongo: async () => {}, counter: async () => {}, queue: async () => {} },
    ));

    const response = await fetch(`${sequenceBaseUrl}/api/v1/shorten`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/sequence' }),
    });
    const created = await response.json() as { shortenedUrl: string };

    assert.equal(response.status, 201);
    assert.equal(storedUrls[0].numericId, 42);
    assert.deepEqual(allocatedIds, [42]);
    assert.equal(created.shortenedUrl, encodeShortCode(42, secret));
});

test('rejects URLs that are invalid or use a non-HTTP protocol', async () => {
    for (const url of ['not a URL', 'javascript:alert(1)', '']) {
        const response = await fetch(`${baseUrl}/api/v1/shorten`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url }),
        });
        assert.equal(response.status, 400, `expected ${JSON.stringify(url)} to be rejected`);
    }
    assert.equal(storedUrls.length, 0);
});

test('limits link creation to 10 requests per minute per IP', async () => {
    const responses = await Promise.all(Array.from({ length: 11 }, () => fetch(
        `${baseUrl}/api/v1/shorten`,
        {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/rate-limited' }),
        },
    )));

    assert.equal(responses.filter((response) => response.status === 201).length, 10);
    const limitedResponse = responses.find((response) => response.status === 429);
    assert.ok(limitedResponse);
    assert.equal(limitedResponse.headers.get('ratelimit-limit'), '10');
    assert.equal(limitedResponse.headers.get('ratelimit-remaining'), '0');
    assert.ok(Number(limitedResponse.headers.get('retry-after')) > 0);
});

test('returns 404 for an unknown short code', async () => {
    const response = await fetch(`${baseUrl}/api/v1/missing1`);
    assert.equal(response.status, 404);
});

test('exposes liveness and readiness health checks', async () => {
    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'ok' });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready', rabbitmq: 'ready' });
});

test('fails readiness when a required dependency is unavailable', async () => {
    const unhealthyBaseUrl = await listenApp(createApp(
        createMemoryDb(), createTestSequence(), testSecret,
        { publish: async () => {} },
        { mongo: async () => { throw new Error('Mongo unavailable'); }, counter: async () => {}, queue: async () => {} },
    ));
    const response = await fetch(`${unhealthyBaseUrl}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'not_ready' });
});

test('keeps redirecting when RabbitMQ is unavailable because the click is in the outbox', async () => {
    const unavailableBaseUrl = await listenApp(createApp(
        createMemoryDb(), createTestSequence(), testSecret,
        { publish: async (event) => { publishedClicks.push(event); } },
        { mongo: async () => {}, counter: async () => {}, queue: async () => {} },
    ));
    const createResponse = await fetch(`${unavailableBaseUrl}/api/v1/shorten`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/queue-down' }),
    });
    const { shortenedUrl } = await createResponse.json() as { shortenedUrl: string };
    const originalError = console.error;
    console.error = () => {};
    try {
        const response = await fetch(`${unavailableBaseUrl}/api/v1/${shortenedUrl}`, { redirect: 'manual' });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), 'https://example.com/queue-down');
        assert.equal(publishedClicks.length, 1, 'event is accepted by the MongoDB outbox before redirect');
    } finally {
        console.error = originalError;
    }
});

test('does not interrupt redirect when an outbox write fails', async () => {
    const degradedBaseUrl = await listenApp(createApp(
        createMemoryDb(), createTestSequence(), testSecret,
        { publish: async () => { throw new Error('Mongo outbox unavailable'); } },
        { mongo: async () => {}, counter: async () => {}, queue: async () => {} },
    ));
    const createResponse = await fetch(`${degradedBaseUrl}/api/v1/shorten`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/outbox-down' }),
    });
    const { shortenedUrl } = await createResponse.json() as { shortenedUrl: string };
    const originalError = console.error;
    console.error = () => {};
    try {
        const response = await fetch(`${degradedBaseUrl}/api/v1/${shortenedUrl}`, { redirect: 'manual' });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), 'https://example.com/outbox-down');
    } finally {
        console.error = originalError;
    }
});

test('reports RabbitMQ degradation without marking the API unready', async () => {
    const degradedBaseUrl = await listenApp(createApp(
        createMemoryDb(), createTestSequence(), testSecret,
        { publish: async () => {} },
        { mongo: async () => {}, counter: async () => {}, queue: async () => { throw new Error('RabbitMQ down'); } },
    ));
    const response = await fetch(`${degradedBaseUrl}/health/ready`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ready', rabbitmq: 'degraded' });
});

test('returns 404 for an expired short URL', async () => {
    storedUrls.push({
        _id: 'expired-url',
        shortenedUrl: 'expired1',
        originalUrl: 'https://example.com/old',
        createdAt: new Date(Date.now() - 10_000),
        expiresAt: new Date(Date.now() - 1_000),
        clicks: 0,
    });

    const response = await fetch(`${baseUrl}/api/v1/expired1`);
    assert.equal(response.status, 404);
    assert.equal(storedUrls[0].clicks, 0);
});

test('caches MongoDB misses and serves later redirects from the cache', async () => {
    const db = createMemoryDb();
    const entries = new Map<string, string>();
    const cache: UrlCache = {
        get: async (shortCode) => entries.get(shortCode) ?? null,
        set: async (shortCode, originalUrl) => {
            entries.set(shortCode, originalUrl);
        },
    };
    const cachedBaseUrl = await listenApp(createApp(
        db, createTestSequence(), testSecret,
        { publish: async (event) => { publishedClicks.push(event); } },
        { mongo: async () => {}, counter: async () => {}, queue: async () => {} }, cache,
    ));

    const createResponse = await fetch(`${cachedBaseUrl}/api/v1/shorten`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/cached' }),
    });
    const { shortenedUrl } = await createResponse.json() as { shortenedUrl: string };

    for (let visit = 0; visit < 2; visit += 1) {
        const response = await fetch(`${cachedBaseUrl}/api/v1/${shortenedUrl}`, {
            redirect: 'manual',
        });
        assert.equal(response.status, 302);
    }

    assert.equal(findCalls, 1, 'MongoDB should be read only for the initial cache miss');
    assert.equal(entries.get(shortenedUrl), 'https://example.com/cached');
    assert.equal(publishedClicks.length, 2);
});

test('falls back to MongoDB when Redis is unavailable', async () => {
    const db = createMemoryDb();
    const unavailableCache: UrlCache = {
        get: async () => { throw new Error('Redis unavailable'); },
        set: async () => { throw new Error('Redis unavailable'); },
    };
    const fallbackBaseUrl = await listenApp(createApp(
        db, createTestSequence(), testSecret,
        { publish: async (event) => { publishedClicks.push(event); } },
        { mongo: async () => {}, counter: async () => {}, queue: async () => {} }, unavailableCache,
    ));
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const createResponse = await fetch(`${fallbackBaseUrl}/api/v1/shorten`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ url: 'https://example.com/fallback' }),
        });
        const { shortenedUrl } = await createResponse.json() as { shortenedUrl: string };

        const response = await fetch(`${fallbackBaseUrl}/api/v1/${shortenedUrl}`, {
            redirect: 'manual',
        });
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), 'https://example.com/fallback');
        assert.equal(publishedClicks.length, 1);
    } finally {
        console.warn = originalWarn;
    }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeShortCode as encodeLocal } from '../../src/short-codes.ts';
import { encodeShortCode, handleRequest, parseHttpUrl } from '../src/index.js';

const secret = 'portfolio-secret-value-with-at-least-32-bytes';

test('Cloudflare short codes match the local API Feistel/Base62 encoding', async () => {
    for (const numericId of [1, 2, 12345, 2 ** 32 + 17]) {
        assert.equal(await encodeShortCode(numericId, secret), encodeLocal(numericId, secret));
    }
});

test('rejects invalid URLs and non-HTTP protocols', () => {
    assert.equal(parseHttpUrl('javascript:alert(1)'), null);
    assert.equal(parseHttpUrl('not a URL'), null);
    assert.equal(parseHttpUrl('https://example.com'), 'https://example.com/');
});

test('creates a link, redirects, and reports clicks using the D1 interface', async () => {
    let nextId = 0;
    const urls = new Map();
    const clicks = [];
    const db = {
        prepare(sql) {
            let values = [];
            const statement = {
                bind(...boundValues) {
                    values = boundValues;
                    return statement;
                },
                async first() {
                    if (sql === 'SELECT 1 AS ok') return { ok: 1 };
                    if (sql.startsWith('UPDATE counters')) return { value: ++nextId };
                    if (sql.startsWith('SELECT original_url')) {
                        const url = urls.get(values[0]);
                        return url && url.expires_at > values[1] ? { original_url: url.original_url } : null;
                    }
                    if (sql.startsWith('SELECT short_code')) {
                        const url = urls.get(values[0]);
                        return url && url.expires_at > values[1] ? { short_code: url.short_code } : null;
                    }
                    if (sql.startsWith('SELECT COUNT(*)')) {
                        return { clicks: clicks.filter((click) => click.short_code === values[0]).length };
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                },
                async run() {
                    if (sql.startsWith('INSERT INTO urls')) {
                        const [numericId, shortCode, originalUrl, createdAt, expiresAt] = values;
                        urls.set(shortCode, { numeric_id: numericId, short_code: shortCode, original_url: originalUrl, created_at: createdAt, expires_at: expiresAt });
                        return { success: true };
                    }
                    if (sql.startsWith('INSERT INTO click_events')) {
                        const [eventId, shortCode, clickedAt] = values;
                        clicks.push({ event_id: eventId, short_code: shortCode, clicked_at: clickedAt });
                        return { success: true };
                    }
                    throw new Error(`Unexpected query: ${sql}`);
                },
            };
            return statement;
        },
        async batch() { return []; },
    };
    const env = {
        DB: db,
        SHORT_CODE_SECRET: secret,
        CREATE_LINK_LIMITER: { limit: async () => ({ success: true }) },
    };

    const created = await handleRequest(new Request('https://api.example/api/v1/shorten', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/target' }),
    }), env);
    assert.equal(created.status, 201);
    const { shortenedUrl } = await created.json();

    const redirected = await handleRequest(new Request(`https://api.example/api/v1/${shortenedUrl}`), env);
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get('location'), 'https://example.com/target');
    assert.equal(clicks.length, 1);

    const stats = await handleRequest(new Request(`https://api.example/api/v1/${shortenedUrl}/stats`), env);
    assert.equal(stats.status, 200);
    assert.deepEqual(await stats.json(), { shortCode: shortenedUrl, clicks: 1 });
});

test('reports D1-backed readiness', async () => {
    const response = await handleRequest(new Request('https://api.example/health/ready'), {
        DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) },
    });
    assert.deepEqual(await response.json(), { status: 'ready', clickEvents: 'direct' });
});

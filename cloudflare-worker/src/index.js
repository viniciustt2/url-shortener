const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const halfMask = 0xffff_ffffn;
const rounds = 10;
const linkLifetimeYears = 5;
const maxUrlLength = 2048;
const maxSafeId = BigInt(Number.MAX_SAFE_INTEGER);

function json(data, status = 200) {
    return Response.json(data, {
        status,
        headers: { 'cache-control': 'no-store' },
    });
}

function encodeBase62(value) {
    if (value === 0n) return '0';
    let remaining = value;
    let encoded = '';
    while (remaining > 0n) {
        const digit = Number(remaining % 62n);
        encoded = alphabet[digit] + encoded;
        remaining /= 62n;
    }
    return encoded;
}

/** Matches src/short-codes.ts while using Web Crypto APIs available in Workers. */
export async function encodeShortCode(numericId, secret) {
    if (!Number.isSafeInteger(numericId) || numericId < 1) {
        throw new RangeError('numericId must be a positive safe integer');
    }
    const secretBytes = new TextEncoder().encode(secret);
    if (secretBytes.byteLength < 32) {
        throw new Error('SHORT_CODE_SECRET must contain at least 32 bytes');
    }

    const key = await crypto.subtle.importKey(
        'raw',
        secretBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const id = BigInt(numericId);
    let left = (id >> 32n) & halfMask;
    let right = id & halfMask;

    for (let round = 0; round < rounds; round += 1) {
        const roundInput = new Uint8Array(5);
        roundInput[0] = round;
        new DataView(roundInput.buffer).setUint32(1, Number(right), false);
        const digest = await crypto.subtle.sign('HMAC', key, roundInput);
        const functionValue = BigInt(new DataView(digest).getUint32(0, false));
        [left, right] = [right, (left ^ functionValue) & halfMask];
    }

    return encodeBase62((left << 32n) | right);
}

export function parseHttpUrl(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > maxUrlLength) return null;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

async function ready(env) {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return json({ status: 'ready', clickEvents: 'direct' });
}

async function createShortUrl(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: 'Request body must contain valid JSON' }, 400);
    }

    const originalUrl = parseHttpUrl(body?.url);
    if (!originalUrl) {
        return json({ error: 'A valid HTTP or HTTPS URL is required (maximum 2048 characters)' }, 400);
    }

    const clientKey = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
        || request.headers.get('cf-connecting-ip')
        || 'unknown';
    const rateLimit = await env.CREATE_LINK_LIMITER.limit({ key: clientKey });
    if (!rateLimit.success) {
        return json({ error: 'Too many link creation requests. Try again later.' }, 429);
    }

    const sequence = await env.DB.prepare(
        "UPDATE counters SET value = value + 1 WHERE id = 'short-url-sequence' RETURNING value",
    ).first();
    const numericId = Number(sequence?.value);
    if (!Number.isSafeInteger(numericId) || numericId < 1 || BigInt(numericId) > maxSafeId) {
        console.error('The D1 short-code counter is missing or outside the safe integer range');
        return json({ error: 'Short code generation is temporarily unavailable' }, 503);
    }

    if (new TextEncoder().encode(env.SHORT_CODE_SECRET ?? '').byteLength < 32) {
        return json({ error: 'Short code generation is temporarily unavailable' }, 503);
    }
    const shortCode = await encodeShortCode(numericId, env.SHORT_CODE_SECRET);
    const now = Date.now();
    const expiresAt = new Date(now);
    expiresAt.setFullYear(expiresAt.getFullYear() + linkLifetimeYears);

    await env.DB.prepare(
        'INSERT INTO urls (numeric_id, short_code, original_url, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(numericId, shortCode, originalUrl, now, expiresAt.getTime()).run();

    return json({ shortenedUrl: shortCode, expiresAt: expiresAt.toISOString() }, 201);
}

async function getStats(shortCode, env) {
    const link = await env.DB.prepare(
        'SELECT short_code FROM urls WHERE short_code = ? AND expires_at > ?',
    ).bind(shortCode, Date.now()).first();
    if (!link) return json({ error: 'URL not found or expired' }, 404);

    const result = await env.DB.prepare(
        'SELECT COUNT(*) AS clicks FROM click_events WHERE short_code = ?',
    ).bind(shortCode).first();
    return json({ shortCode, clicks: Number(result?.clicks ?? 0) });
}

async function redirect(shortCode, env) {
    const link = await env.DB.prepare(
        'SELECT original_url FROM urls WHERE short_code = ? AND expires_at > ?',
    ).bind(shortCode, Date.now()).first();
    if (!link) return json({ error: 'URL not found or expired' }, 404);

    try {
        await env.DB.prepare(
            'INSERT INTO click_events (event_id, short_code, clicked_at) VALUES (?, ?, ?)',
        ).bind(crypto.randomUUID(), shortCode, Date.now()).run();
    } catch (error) {
        // A metrics failure must not prevent a reader from reaching the destination.
        console.error('Could not persist click event; continuing redirect:', error);
    }

    return new Response(null, {
        status: 302,
        headers: {
            location: link.original_url,
            'cache-control': 'no-store',
        },
    });
}

async function cleanupExpired(env) {
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare('DELETE FROM click_events WHERE short_code IN (SELECT short_code FROM urls WHERE expires_at <= ?)').bind(now),
        env.DB.prepare('DELETE FROM urls WHERE expires_at <= ?').bind(now),
    ]);
}

export async function handleRequest(request, env) {
    const { pathname } = new URL(request.url);
    try {
        if (request.method === 'GET' && pathname === '/health/live') {
            return json({ status: 'ok' });
        }
        if (request.method === 'GET' && pathname === '/health/ready') {
            return await ready(env);
        }
        if (request.method === 'POST' && pathname === '/api/v1/shorten') {
            return await createShortUrl(request, env);
        }

        const statsMatch = pathname.match(/^\/api\/v1\/([a-zA-Z0-9]+)\/stats$/);
        if (request.method === 'GET' && statsMatch) {
            return await getStats(statsMatch[1], env);
        }

        const redirectMatch = pathname.match(/^\/api\/v1\/([a-zA-Z0-9]+)$/);
        if (request.method === 'GET' && redirectMatch) {
            return await redirect(redirectMatch[1], env);
        }

        return json({ error: 'Not found' }, 404);
    } catch (error) {
        console.error('Request failed:', error);
        return json({ error: 'Internal server error' }, 500);
    }
}

export default {
    fetch: handleRequest,
    scheduled(_event, env, context) {
        context.waitUntil(cleanupExpired(env));
    },
};

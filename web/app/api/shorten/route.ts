export const runtime = 'nodejs';

const backendApiUrl = process.env.BACKEND_API_URL ?? 'http://localhost:3000';

export async function POST(request: Request) {
    try {
        const forwardedFor = request.headers.get('x-forwarded-for');
        const realIp = request.headers.get('x-real-ip');
        const headers = new Headers({
            'content-type': request.headers.get('content-type') ?? 'application/json',
        });
        if (forwardedFor) headers.set('x-forwarded-for', forwardedFor);
        else if (realIp) headers.set('x-forwarded-for', realIp);

        const upstream = await fetch(new URL('/api/v1/shorten', backendApiUrl), {
            method: 'POST',
            headers,
            body: await request.text(),
            cache: 'no-store',
        });

        return new Response(await upstream.text(), {
            status: upstream.status,
            headers: {
                'content-type': upstream.headers.get('content-type') ?? 'application/json',
            },
        });
    } catch {
        return Response.json({ error: 'The URL service is temporarily unavailable.' }, { status: 503 });
    }
}

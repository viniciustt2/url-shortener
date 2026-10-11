export const runtime = 'nodejs';

const backendApiUrl = process.env.BACKEND_API_URL ?? 'http://localhost:3000';

export async function GET(
    _request: Request,
    context: { params: Promise<{ shortCode: string }> },
) {
    try {
        const { shortCode } = await context.params;
        const upstream = await fetch(
            new URL(`/api/v1/${encodeURIComponent(shortCode)}`, backendApiUrl),
            { redirect: 'manual', cache: 'no-store' },
        );

        if (upstream.status >= 300 && upstream.status < 400) {
            const destination = upstream.headers.get('location');
            if (!destination) {
                return Response.json({ error: 'The destination URL is missing.' }, { status: 502 });
            }
            return Response.redirect(destination, 302);
        }

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

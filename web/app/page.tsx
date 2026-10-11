'use client';

import { FormEvent, useEffect, useState } from 'react';

type RecentLink = {
    code: string;
    originalUrl: string;
    shortUrl: string;
    createdAt: string;
};

const storageKey = 'shortly.recent-links.v1';

function ArrowIcon({ diagonal = false }: { diagonal?: boolean }) {
    return diagonal ? (
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15 15 5M6 5h9v9" /></svg>
    ) : (
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M10 5l5 5-5 5" /></svg>
    );
}

function CopyIcon() {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" /></svg>;
}

function hostname(value: string) {
    try {
        return new URL(value).hostname.replace(/^www\./, '');
    } catch {
        return value;
    }
}

export default function Home() {
    const [url, setUrl] = useState('');
    const [recentLinks, setRecentLinks] = useState<RecentLink[]>([]);
    const [createdLink, setCreatedLink] = useState<RecentLink | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        try {
            const saved = window.localStorage.getItem(storageKey);
            if (saved) setRecentLinks(JSON.parse(saved) as RecentLink[]);
        } catch {
            try { window.localStorage.removeItem(storageKey); } catch { /* Storage may be disabled. */ }
        }
    }, []);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setError('');
        setCreatedLink(null);
        setCopied(false);

        let parsedUrl: URL;
        try {
            parsedUrl = new URL(url.trim());
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
        } catch {
            setError('Enter a complete HTTP or HTTPS URL.');
            return;
        }

        setIsLoading(true);
        try {
            const response = await fetch('/api/shorten', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ url: parsedUrl.toString() }),
            });
            const result = await response.json() as { shortenedUrl?: string; error?: string };
            if (!response.ok || !result.shortenedUrl) {
                throw new Error(result.error ?? 'Could not create this short link.');
            }

            const link: RecentLink = {
                code: result.shortenedUrl,
                originalUrl: parsedUrl.toString(),
                shortUrl: `${window.location.origin}/${result.shortenedUrl}`,
                createdAt: new Date().toISOString(),
            };
            const updated = [link, ...recentLinks.filter((item) => item.code !== link.code)].slice(0, 5);
            setRecentLinks(updated);
            setCreatedLink(link);
            setUrl('');
            try { window.localStorage.setItem(storageKey, JSON.stringify(updated)); } catch { /* The link still works without local history. */ }
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : 'Something went wrong. Try again.');
        } finally {
            setIsLoading(false);
        }
    }

    async function copyLink(value: string) {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1800);
        } catch {
            setError('Clipboard access is unavailable in this browser.');
        }
    }

    function removeRecent(code: string) {
        const updated = recentLinks.filter((item) => item.code !== code);
        setRecentLinks(updated);
        try { window.localStorage.setItem(storageKey, JSON.stringify(updated)); } catch { /* Storage may be disabled. */ }
    }

    return (
        <main className="page-shell">
            <header className="topbar">
                <a className="brand" href="/" aria-label="Shortly home">
                    <span className="brand-mark"><span /></span>
                    <span>shortly<span className="brand-period">.</span></span>
                </a>
                <div className="topbar-note"><span className="live-dot" /> LINK INFRASTRUCTURE, SIMPLIFIED</div>
                <a className="github-link" href="#workspace">
                    MY LINKS <ArrowIcon />
                </a>
            </header>

            <section className="hero-grid">
                <div className="hero-copy">
                    <div className="eyebrow"><span>01</span> YOUR LINKS, REIMAGINED</div>
                    <h1>Long links.<br /><span>Short story.</span></h1>
                    <p className="hero-description">Make every link easier to share. Create a short URL in seconds and keep the destination one click away.</p>

                    <form className="shorten-form" onSubmit={handleSubmit}>
                        <label htmlFor="url-input">PASTE YOUR LONG URL</label>
                        <div className="input-row">
                            <svg className="input-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M8.1 11.9a3.2 3.2 0 0 0 4.5 0l3-3a3.2 3.2 0 0 0-4.5-4.5l-1.7 1.7M11.9 8.1a3.2 3.2 0 0 0-4.5 0l-3 3a3.2 3.2 0 1 0 4.5 4.5l1.7-1.7" /></svg>
                            <input
                                id="url-input"
                                type="url"
                                value={url}
                                onChange={(event) => setUrl(event.target.value)}
                                placeholder="https://your-very-long-link.com/..."
                                maxLength={2048}
                                required
                                aria-describedby={error ? 'form-error' : undefined}
                            />
                            <button className="shorten-button" type="submit" disabled={isLoading}>
                                {isLoading ? 'CREATING…' : 'SHORTEN LINK'} <ArrowIcon />
                            </button>
                        </div>
                        {error && <p className="form-error" id="form-error" role="alert">{error}</p>}
                        <div className="form-hint"><span className="sparkle">✳</span> No account needed. Your links last for 5 years.</div>
                    </form>

                    {createdLink && (
                        <div className="result-card" aria-live="polite">
                            <div className="result-copy">
                                <span className="result-label">YOUR SHORT LINK IS READY</span>
                                <a href={createdLink.shortUrl} target="_blank" rel="noreferrer">{createdLink.shortUrl.replace(/^https?:\/\//, '')} <ArrowIcon diagonal /></a>
                            </div>
                            <button className={`copy-button ${copied ? 'is-copied' : ''}`} onClick={() => copyLink(createdLink.shortUrl)} type="button">
                                <CopyIcon /> {copied ? 'COPIED' : 'COPY'}
                            </button>
                        </div>
                    )}
                </div>

                <aside className="signal-card" aria-label="Shortly service details">
                    <div className="signal-card-top">
                        <span className="signal-label">SYSTEM SNAPSHOT</span>
                        <span className="signal-status"><span className="live-dot" /> OPERATIONAL</span>
                    </div>
                    <div className="orbital-art" aria-hidden="true">
                        <div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" />
                        <div className="orbit-core"><span>↗</span></div>
                        <span className="orbit-node node-one" /><span className="orbit-node node-two" /><span className="orbit-node node-three" />
                    </div>
                    <div className="signal-caption"><span>01 / REDIRECT NETWORK</span><span>LOW LATENCY BY DESIGN</span></div>
                    <div className="spec-list">
                        <div><span>CODE SPACE</span><strong>48 <small>BIT</small></strong></div>
                        <div><span>REDIRECT</span><strong>302 <small>FOUND</small></strong></div>
                        <div><span>LINK LIFETIME</span><strong>05 <small>YEARS</small></strong></div>
                    </div>
                </aside>
            </section>

            <section className="recent-section" id="workspace">
                <div className="section-heading">
                    <div><span className="eyebrow"><span>02</span> YOUR WORKSPACE</span><h2>Recent links<span className="brand-period">.</span></h2></div>
                    <span className="recent-count">{String(recentLinks.length).padStart(2, '0')} / 05 SAVED LOCALLY</span>
                </div>
                {recentLinks.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-icon"><span>↗</span></div>
                        <div><strong>Your next great link starts here.</strong><p>Shortened links you create will show up here on this device.</p></div>
                        <span className="empty-index">NO LINKS YET</span>
                    </div>
                ) : (
                    <div className="recent-list">
                        {recentLinks.map((link, index) => (
                            <article className="recent-row" key={link.code}>
                                <span className="row-index">0{index + 1}</span>
                                <div className="row-destination"><strong>{hostname(link.originalUrl)}</strong><span>{link.originalUrl}</span></div>
                                <a className="row-short" href={link.shortUrl} target="_blank" rel="noreferrer">{link.shortUrl.replace(/^https?:\/\//, '')} <ArrowIcon diagonal /></a>
                                <button className="row-copy" type="button" onClick={() => copyLink(link.shortUrl)} aria-label={`Copy ${link.shortUrl}`}><CopyIcon /></button>
                                <button className="row-remove" type="button" onClick={() => removeRecent(link.code)} aria-label={`Remove ${link.shortUrl} from recent links`}>×</button>
                            </article>
                        ))}
                    </div>
                )}
            </section>

            <footer className="footer"><span>BUILT FOR THE LONG WAY AROUND.</span><span>SHORTLY © 2026</span></footer>
        </main>
    );
}

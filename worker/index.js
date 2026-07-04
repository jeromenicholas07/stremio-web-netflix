// Stremio-web iOS CORS proxy — Cloudflare Worker (free plan)
//
// Two light routes, so the iOS PWA (served from GitHub Pages over HTTPS) can do
// two things Safari's CORS policy otherwise blocks:
//
//   GET|POST|… /trakt/*   → proxied to https://api.trakt.tv/*  (Trakt sync)
//   GET        /size?u=…  → redirect-following size probe of a debrid URL,
//                           returns { size, contentType } (auto-pick preflight)
//
// Video never flows through here — only headers/JSON — so the Workers free tier
// (100k req/day) is far more than enough. A host allowlist keeps it from being
// an open proxy. The deployed URL is injected into the web build as
// CORS_PROXY_URL and consumed only on iOS (see src/common/isIOS.js consumers).

// Hosts the /size probe is allowed to fetch. Debrid direct hosts plus the addon
// "resolve" endpoints that 302-redirect to them. Extend via the SIZE_ALLOW_HOSTS
// env var (comma-separated) without editing code.
const DEFAULT_SIZE_ALLOW_HOSTS = [
    'real-debrid.com',
    'debrid.link',
    'alldebrid.com',
    'premiumize.me',
    'strem.fun',      // torrentio.strem.fun and friends (resolve → debrid)
    'torrentio.strem.fun',
];

const TRAKT_ORIGIN = 'https://api.trakt.tv';

// Headers we forward upstream to Trakt (allowlisted — never blindly forward).
const TRAKT_FORWARD_HEADERS = [
    'authorization',
    'content-type',
    'trakt-api-key',
    'trakt-api-version',
];

// Size probe reads at most this many bytes when a length header is absent.
const SIZE_BODY_CAP = 4 * 1024 * 1024 + 1; // just over the ~2–4 MB copyright stub
const PROBE_TIMEOUT_MS = 12000;

function corsHeaders(request, extra = {}) {
    const origin = request.headers.get('Origin') || '*';
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers':
            request.headers.get('Access-Control-Request-Headers') ||
            'Authorization,Content-Type,trakt-api-key,trakt-api-version',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
        ...extra,
    };
}

function json(request, status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: corsHeaders(request, { 'Content-Type': 'application/json' }),
    });
}

function allowHosts(env) {
    const extra = (env && env.SIZE_ALLOW_HOSTS ? String(env.SIZE_ALLOW_HOSTS) : '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
    return [...DEFAULT_SIZE_ALLOW_HOSTS, ...extra];
}

function hostAllowed(hostname, allow) {
    const host = hostname.toLowerCase();
    return allow.some((base) => host === base || host.endsWith('.' + base));
}

// ── /trakt/* → api.trakt.tv ──────────────────────────────────────────────
async function handleTrakt(request, url) {
    const upstreamPath = url.pathname.replace(/^\/trakt/, '') || '/';
    const upstream = new URL(TRAKT_ORIGIN + upstreamPath + url.search);

    const headers = new Headers();
    for (const name of TRAKT_FORWARD_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }

    const init = { method: request.method, headers, redirect: 'follow' };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.arrayBuffer();
    }

    const upstreamRes = await fetch(upstream.toString(), init);

    // Copy the upstream response, layering CORS headers on top.
    const respHeaders = new Headers(upstreamRes.headers);
    const cors = corsHeaders(request);
    for (const [k, v] of Object.entries(cors)) respHeaders.set(k, v);
    respHeaders.delete('content-encoding'); // body is already decoded by fetch

    return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: respHeaders,
    });
}

// ── /size?u=<debrid url>&h=<Header:Value> → { size, contentType } ─────────
// Mirrors the desktop launcher's /_launcher/probe-size: follow the resolve→RD
// redirect chain the browser can't see, and report the final size.
async function handleSize(request, url, env) {
    const target = url.searchParams.get('u');
    if (!target) return json(request, 400, { error: 'missing u param' });

    let parsed;
    try {
        parsed = new URL(target);
    } catch {
        return json(request, 400, { error: 'invalid url' });
    }
    if (!/^https?:$/.test(parsed.protocol)) {
        return json(request, 400, { error: 'unsupported protocol' });
    }
    if (!hostAllowed(parsed.hostname, allowHosts(env))) {
        return json(request, 403, { error: 'host not allowed' });
    }

    // Optional upstream request headers (debrid auth), passed as repeated h=K:V.
    const upstreamHeaders = new Headers();
    for (const h of url.searchParams.getAll('h')) {
        const idx = h.indexOf(':');
        if (idx > 0) upstreamHeaders.set(h.slice(0, idx).trim(), h.slice(idx + 1).trim());
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        // Ranged GET first: cheap, and Content-Range exposes the true total.
        upstreamHeaders.set('Range', 'bytes=0-1');
        let res = await fetch(parsed.toString(), {
            method: 'GET',
            headers: upstreamHeaders,
            redirect: 'follow',
            signal: controller.signal,
        });

        // Some resolve endpoints 500 on a ranged GET; retry plain.
        if (res.status !== 200 && res.status !== 206) {
            upstreamHeaders.delete('Range');
            res = await fetch(parsed.toString(), {
                method: 'GET',
                headers: upstreamHeaders,
                redirect: 'follow',
                signal: controller.signal,
            });
            if (!res.ok) return json(request, 200, { size: -1, contentType: '' });
        }

        const contentType = res.headers.get('content-type') || '';

        const contentRange = res.headers.get('content-range');
        const rangeMatch = contentRange && contentRange.match(/\/(\d+)\s*$/);
        if (rangeMatch) {
            return json(request, 200, { size: parseInt(rangeMatch[1], 10), contentType });
        }

        const contentLength = res.headers.get('content-length');
        // A 206 content-length is just the requested slice, not the total — ignore.
        if (contentLength && res.status === 200) {
            return json(request, 200, { size: parseInt(contentLength, 10), contentType });
        }

        // No usable length header (chunked stub): measure the body up to the cap.
        let total = 0;
        if (res.body && res.body.getReader) {
            const reader = res.body.getReader();
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value ? value.length : 0;
                if (total > SIZE_BODY_CAP) {
                    try { await reader.cancel(); } catch { /* closing */ }
                    break;
                }
            }
        }
        return json(request, 200, { size: total, contentType });
    } catch {
        return json(request, 200, { size: -1, contentType: '' });
    } finally {
        clearTimeout(timer);
    }
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders(request) });
        }

        try {
            if (url.pathname === '/size') {
                return await handleSize(request, url, env);
            }
            if (url.pathname === '/trakt' || url.pathname.startsWith('/trakt/')) {
                return await handleTrakt(request, url);
            }
            if (url.pathname === '/' || url.pathname === '/health') {
                return json(request, 200, { ok: true, routes: ['/trakt/*', '/size?u='] });
            }
            return json(request, 404, { error: 'not found' });
        } catch (err) {
            return json(request, 502, { error: 'proxy error', detail: String(err && err.message || err) });
        }
    },
};

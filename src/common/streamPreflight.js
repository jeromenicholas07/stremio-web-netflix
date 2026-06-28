// Copyright (C) 2017-2026 Smart code 203358507

// Auto-pick stream preflight.
//
// Real-Debrid (surfaced through Torrentio and similar addons) now answers
// copyright-filtered files by redirecting to a tiny ~2 MB error clip
// ("File was removed from debrid service due to copyright infringement")
// instead of the real media. The streaming-server CORS proxy follows that
// redirect server-side, so the redirect target name is not visible to the
// browser — but the resulting Content-Length is. A real episode/movie is
// hundreds of MB to several GB, while the stub is a couple of MB, so an
// implausibly small proxied size (absolute floor, or a tiny fraction of the
// advertised release size) is a reliable "blocked" signal.
//
// This lets auto-pick skip a dead stream BEFORE ever opening the player,
// rather than loading it, failing, and bouncing back through the streams page.
//
// The check fails OPEN: any uncertainty (no resolvable URL, no streaming
// server, network/CORS error, missing size) returns `skipped` so playback is
// never blocked by the preflight itself.

// The Torrentio/RD copyright clip is a fixed ~2 MB file. We treat any probed
// total at or below this ceiling as the stub. A real episode/movie is always
// far larger, so this single, narrow rule cannot false-positive on a genuine
// file — and everything else fails open (plays).
const STUB_KNOWN_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const PREFLIGHT_TIMEOUT_MS = 8000;

function debugEnabled() {
    try {
        return window.localStorage.getItem('netflix_ui_debug') === 'true';
    } catch {
        return false;
    }
}

function log(...args) {
    if (debugEnabled()) {
        // eslint-disable-next-line no-console
        console.log('[autopick-preflight]', ...args);
    }
}

// Resolve the base we issue the proxied `fetch` against. `fetch` (unlike a
// <video> element) enforces CORS, so we MUST route through a path that returns
// CORS headers / is same-origin — hitting the streaming server (:11470)
// directly cross-origin would throw and silently disable the preflight.
//
// This mirrors the proven routing used by the subtitle extractor:
//   - same origin as the streaming server → '' (direct)
//   - localhost dev                       → '/streaming-server' (webpack proxy, same-origin)
//   - remote origin (e.g. GitHub Pages)   → 'http://127.0.0.1:12470' (launcher CORS proxy)
function getFetchBase(ssBaseUrl) {
    try {
        if (typeof window === 'undefined') return 'http://127.0.0.1:12470';
        if (ssBaseUrl) {
            const ssOrigin = new URL(ssBaseUrl).origin;
            if (ssOrigin === window.location.origin) return '';
        }
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            return '/streaming-server';
        }
        return 'http://127.0.0.1:12470';
    } catch {
        return '/streaming-server';
    }
}

// Build the streaming-server `/proxy/` URL for an HTTP(S) stream, replicating
// the convention used by the player / subtitle extractor so debrid auth
// headers (when present) are forwarded.
function buildProxyUrl(fetchBase, streamUrl, proxyHeaders) {
    const parsed = new URL(streamUrl);
    const params = new URLSearchParams();
    params.set('d', parsed.origin);

    if (proxyHeaders && proxyHeaders.request) {
        Object.entries(proxyHeaders.request).forEach(([key, value]) => {
            params.append('h', `${key}:${value}`);
        });
    }
    if (proxyHeaders && proxyHeaders.response) {
        Object.entries(proxyHeaders.response).forEach(([key, value]) => {
            params.append('r', `${key}:${value}`);
        });
    }

    return `${fetchBase}/proxy/${params.toString()}${parsed.pathname}${parsed.search}`;
}

// Parse a human-readable size (e.g. "💾 2.33 GB") into bytes.
function parseAdvertisedSizeBytes(text) {
    if (typeof text !== 'string') return null;
    const match = text.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB|KB)/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (!Number.isFinite(value)) return null;
    const unit = match[2].toUpperCase();
    const mult =
        unit === 'TB' ? 1024 ** 4 :
            unit === 'GB' ? 1024 ** 3 :
                unit === 'MB' ? 1024 ** 2 :
                    1024;
    return Math.round(value * mult);
}

// Pull the encoded stream segment out of a `#/player/<encoded>/...` deep link.
function extractEncodedStream(playerDeepLink) {
    if (typeof playerDeepLink !== 'string') return null;
    const match = playerDeepLink.match(/#\/player\/([^/]+)/);
    if (!match) return null;
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return match[1];
    }
}

// A stub is identified ONLY by the fixed ~2 MB Real-Debrid copyright clip.
// We deliberately keep this narrow: a real episode/movie is always far larger
// than a few MB, so blocking solely on the known-stub band cannot
// false-positive on a legitimate file (the previous ratio/relative heuristics
// could wrongly flag e.g. a not-yet-cached RD download whose first probe
// returns a small body). Anything we are not highly confident about plays.
function isStubSize(contentLength) {
    if (!Number.isFinite(contentLength) || contentLength <= 0) return false;
    return contentLength <= STUB_KNOWN_MAX_BYTES;
}

// Issue a tiny ranged GET through the proxy and read the total byte size from
// Content-Range (preferred) or Content-Length, then abort the body download.
async function probeContentLength(proxyUrl, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort);
    }
    const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);

    try {
        const res = await fetch(proxyUrl, {
            method: 'GET',
            headers: { Range: 'bytes=0-1' },
            signal: controller.signal,
        });

        // Proxy / upstream errors come back as HTML with a tiny Content-Length
        // (e.g. 148 bytes). Without this guard those get misread as copyright
        // stubs and good streams are skipped.
        if (res.status !== 200 && res.status !== 206) {
            log('probe non-success', { status: res.status, contentLength: res.headers.get('content-length') });
            controller.abort();
            return null;
        }

        let total = null;
        const contentType = res.headers.get('content-type') || '';
        const contentRange = res.headers.get('content-range');
        if (contentRange) {
            const m = contentRange.match(/\/(\d+)\s*$/);
            if (m) total = parseInt(m[1], 10);
        }
        // Fall back to Content-Length when there is no Content-Range. Some CORS
        // proxies (notably the launcher's bundled proxy in the shell .exe) do
        // not forward the Range request header, so the upstream answers 200
        // with the FULL size instead of 206 + Content-Range. We trust that size
        // when it is either plainly real media (large) OR a video payload — the
        // latter covers the ~2 MB copyright stub, which is below the large-size
        // floor but is always served as video/mp4. A tiny HTML error page
        // (text/html) is still ignored, so we never misread it as a stub.
        if (total === null) {
            const contentLength = res.headers.get('content-length');
            if (contentLength) {
                const parsed = parseInt(contentLength, 10);
                if (Number.isFinite(parsed) && (parsed >= STUB_KNOWN_MAX_BYTES || /^video\//i.test(contentType))) {
                    total = parsed;
                }
            }
        }

        log('probe response', { status: res.status, contentType, contentRange, contentLength: res.headers.get('content-length'), total });

        // We only needed the headers; don't pull the body.
        controller.abort();

        return Number.isFinite(total) ? total : null;
    } catch (err) {
        log('probe error', err && err.message);
        return null;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

// Preflight a single auto-pick candidate.
//
// Returns one of:
//   { blocked: true, contentLength }   — confirmed copyright stub
//   { blocked: false, contentLength }  — looks like real media
//   { skipped: true, reason }          — could not check (fail open)
async function preflightAutoPickStream({ core, stream, ssBaseUrl, signal } = {}) {
    try {
        if (!core || !core.transport || typeof core.transport.decodeStream !== 'function') {
            return { skipped: true, reason: 'no-core' };
        }

        const encoded = extractEncodedStream(stream && stream.deepLinks && stream.deepLinks.player);
        if (!encoded) return { skipped: true, reason: 'no-encoded-stream' };

        const decoded = await core.transport.decodeStream(encoded);
        const url = decoded && typeof decoded.url === 'string' ? decoded.url : null;
        // Only HTTP(S) debrid/direct streams are preflightable. Torrents
        // (infoHash, no url) and magnets are handled by the player itself.
        if (!url || !/^https?:/i.test(url)) {
            log('skip: not an http stream', { hasDecoded: !!decoded, url });
            return { skipped: true, reason: 'not-http-stream' };
        }

        const proxyHeaders = decoded.behaviorHints && decoded.behaviorHints.proxyHeaders;

        const fetchBase = getFetchBase(ssBaseUrl);
        const proxyUrl = buildProxyUrl(fetchBase, url, proxyHeaders);
        log('preflighting', { name: stream && stream.name, url, fetchBase });

        const contentLength = await probeContentLength(proxyUrl, signal);
        if (contentLength === null) return { skipped: true, reason: 'no-size' };

        const blocked = isStubSize(contentLength);
        log('verdict', { name: stream && stream.name, blocked, contentLength });

        return {
            blocked,
            contentLength,
        };
    } catch (err) {
        log('preflight error', err && err.message);
        return { skipped: true, reason: 'error' };
    }
}

module.exports = {
    preflightAutoPickStream,
    parseAdvertisedSizeBytes,
    isStubSize,
    probeContentLength,
    buildProxyUrl,
    extractEncodedStream,
    STUB_KNOWN_MAX_BYTES,
};

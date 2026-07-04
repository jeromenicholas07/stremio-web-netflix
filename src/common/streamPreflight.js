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

const isIOS = require('./isIOS');

// Optional free Cloudflare Worker CORS proxy (see worker/). On iOS there is no
// local streaming server or launcher to size-probe through, so — when the Worker
// is configured — the probe routes through its /size endpoint instead. Every
// other platform is untouched.
const CORS_PROXY_URL = process.env.CORS_PROXY_URL || null;

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

// Minimum size we'll treat as a copyright stub. Comfortably above proxy/HTML
// error pages (≈100–200 bytes) so those fail open (play) instead of being
// mistaken for the ~2 MB stub.
const STUB_MIN_BYTES = 512 * 1024; // 512 KB
// Sentinel returned once a body-measure exceeds the stub ceiling: any value
// above STUB_KNOWN_MAX_BYTES so isStubSize() reports "not a stub".
const STUB_LARGE_SENTINEL = STUB_KNOWN_MAX_BYTES + 1;

// Decide what a probed byte count means:
//   > ceiling                         → real media (return as-is)
//   in [STUB_MIN, ceiling], or video  → stub-band size (return as-is → blocked)
//   tiny + not video (error page)     → null (fail open / play)
function classifyProbedSize(size, contentType) {
    if (!Number.isFinite(size) || size <= 0) return null;
    if (size > STUB_KNOWN_MAX_BYTES) return size;
    if (size >= STUB_MIN_BYTES || /^video\//i.test(contentType || '')) return size;
    return null;
}

// Stream the response body counting bytes, aborting the moment we pass the stub
// ceiling. This sizes a response even when there is NO Content-Length and NO
// Content-Range — exactly the shell .exe case, where the streaming-server proxy
// returns the RD copyright stub as a chunked 200 with no length after following
// the redirect. Bounded: a real multi-GB file is detected as "large" after
// ~STUB_KNOWN_MAX_BYTES and the download is aborted.
async function measureBodyCapped(res, controller) {
    try {
        if (!res.body || typeof res.body.getReader !== 'function') {
            // No streaming reader available — read fully (rare path; the stub is
            // small and a real file would be caught by a length header earlier).
            const buf = await res.arrayBuffer();
            return buf.byteLength > STUB_KNOWN_MAX_BYTES ? STUB_LARGE_SENTINEL : buf.byteLength;
        }
        const reader = res.body.getReader();
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value ? value.length : 0;
            if (total > STUB_KNOWN_MAX_BYTES) {
                try { await reader.cancel(); } catch { /* already closing */ }
                try { controller.abort(); } catch { /* already aborted */ }
                return STUB_LARGE_SENTINEL;
            }
        }
        return total;
    } catch {
        // Aborted (timeout/external) or read error → unknown size → fail open.
        return null;
    }
}

// Probe a stream's total size to tell a real file from the RD copyright stub.
//
// Strategy, fastest/most-reliable first:
//   1. Ranged GET (`Range: bytes=0-1`) → read Content-Range total (2-byte body).
//   2. Same response's Content-Length (some proxies strip Range, answer 200).
//   3. Retry once as a plain GET (some proxies only emit a size without Range).
//   4. Body-measure the plain GET with a hard cap — works with NO size headers
//      at all (the shell's chunked-stub case). Reads at most ~4 MB.
async function probeContentLength(proxyUrl, signal, options = {}) {
    const useRange = options.useRange !== false;
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
            headers: useRange ? { Range: 'bytes=0-1' } : {},
            signal: controller.signal,
        });

        if (res.status !== 200 && res.status !== 206) {
            log('probe non-success', { status: res.status, contentLength: res.headers.get('content-length'), useRange });
            controller.abort();
            // A `Range` request makes some upstreams error — notably Torrentio's
            // /resolve/realdebrid/... endpoint, which 302-redirects to the real
            // RD file and 500s on a ranged GET even though a plain GET (what the
            // player uses) succeeds. Retry once without Range, then body-measure.
            if (useRange) {
                return probeContentLength(proxyUrl, signal, { useRange: false });
            }
            return null;
        }

        let total = null;
        const contentType = res.headers.get('content-type') || '';
        const contentRange = res.headers.get('content-range');
        if (contentRange) {
            const m = contentRange.match(/\/(\d+)\s*$/);
            if (m) total = parseInt(m[1], 10);
        }
        if (total === null) {
            const contentLength = res.headers.get('content-length');
            if (contentLength) {
                total = classifyProbedSize(parseInt(contentLength, 10), contentType);
            }
        }

        log('probe response', { status: res.status, contentType, contentRange, contentLength: res.headers.get('content-length'), total, useRange });

        if (Number.isFinite(total)) {
            controller.abort();
            return total;
        }

        // No size from headers on the ranged probe — retry as a plain GET so we
        // can read a length header or, failing that, measure the body.
        if (useRange) {
            controller.abort();
            return probeContentLength(proxyUrl, signal, { useRange: false });
        }

        // Plain GET, still no length header (shell chunked-stub case): measure
        // the body. This is a NON-ranged request, so the body length equals the
        // real resource size (capped). Do NOT abort before reading.
        const measured = await measureBodyCapped(res, controller);
        const verdict = classifyProbedSize(measured, contentType);
        log('probe body-measured', { measured, verdict, contentType });
        return verdict;
    } catch (err) {
        log('probe error', err && err.message);
        return null;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

// True when the fetch base is the launcher's loopback CORS proxy (the shell
// .exe). Only there does the launcher size-probe endpoint exist.
function isLauncherBase(fetchBase) {
    return typeof fetchBase === 'string' && /^https?:\/\/(?:127\.0\.0\.1|localhost):12470\b/i.test(fetchBase);
}

// Ask the launcher to size the stream server-side. This is the reliable path in
// the shell: the streaming-server /proxy is origin-locked and 500s when a
// Torrentio /resolve/... URL redirects cross-origin to real-debrid.com, whereas
// the launcher fetches the URL directly (AllowAutoRedirect) and reads the final
// size. Returns { size, contentType }, { unavailable: true } (old launcher with
// no endpoint → caller falls back), or null on error.
async function probeSizeViaLauncher(fetchBase, url, proxyHeaders, signal) {
    const params = new URLSearchParams();
    params.set('u', url);
    if (proxyHeaders && proxyHeaders.request) {
        Object.entries(proxyHeaders.request).forEach(([key, value]) => params.append('h', `${key}:${value}`));
    }
    const probeUrl = `${fetchBase}/_launcher/probe-size?${params.toString()}`;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort);
    }
    // The launcher may read up to ~4 MB for chunked responses, so allow extra.
    const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS + 8000);

    try {
        const res = await fetch(probeUrl, { method: 'GET', signal: controller.signal });
        if (res.status === 404) return { unavailable: true };
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        if (!data || typeof data.size !== 'number') return null;
        return { size: data.size, contentType: data.contentType || '' };
    } catch (err) {
        log('launcher probe error', err && err.message);
        return null;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

// iOS path: ask the Cloudflare Worker to size the stream server-side. Like the
// launcher, the Worker follows the resolve→RD redirect chain the browser can't
// see and returns { size, contentType }. Returns null on any error (fail open).
async function probeSizeViaWorker(workerBase, url, proxyHeaders, signal) {
    const params = new URLSearchParams();
    params.set('u', url);
    if (proxyHeaders && proxyHeaders.request) {
        Object.entries(proxyHeaders.request).forEach(([key, value]) => params.append('h', `${key}:${value}`));
    }
    const probeUrl = `${workerBase.replace(/\/+$/, '')}/size?${params.toString()}`;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onAbort);
    }
    const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS + 8000);

    try {
        const res = await fetch(probeUrl, { method: 'GET', signal: controller.signal });
        if (!res.ok) return null;
        const data = await res.json().catch(() => null);
        if (!data || typeof data.size !== 'number') return null;
        return { size: data.size, contentType: data.contentType || '' };
    } catch (err) {
        log('worker probe error', err && err.message);
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

        // iOS: no local streaming server / launcher exists. When a CORS proxy
        // Worker is configured, size-probe through it; otherwise fail open. This
        // branch never runs on desktop/web/shell (isIOS() is false there).
        if (isIOS() && CORS_PROXY_URL) {
            const worker = await probeSizeViaWorker(CORS_PROXY_URL, url, proxyHeaders, signal);
            if (!worker) return { skipped: true, reason: 'worker-unavailable' };
            const total = classifyProbedSize(worker.size, worker.contentType);
            if (total === null) return { skipped: true, reason: 'worker-ambiguous' };
            const blocked = isStubSize(total);
            log('verdict (worker)', { name: stream && stream.name, blocked, size: worker.size, contentType: worker.contentType });
            return { blocked, contentLength: total };
        }

        const fetchBase = getFetchBase(ssBaseUrl);
        log('preflighting', { name: stream && stream.name, url, fetchBase });

        // Shell .exe: size the stream server-side via the launcher (follows the
        // resolve→RD redirect chain that the streaming-server /proxy can't).
        if (isLauncherBase(fetchBase)) {
            const launcher = await probeSizeViaLauncher(fetchBase, url, proxyHeaders, signal);
            if (launcher && !launcher.unavailable) {
                if (!Number.isFinite(launcher.size) || launcher.size < 0) {
                    return { skipped: true, reason: 'launcher-no-size' };
                }
                const total = classifyProbedSize(launcher.size, launcher.contentType);
                if (total === null) return { skipped: true, reason: 'launcher-ambiguous' };
                const blocked = isStubSize(total);
                log('verdict (launcher)', { name: stream && stream.name, blocked, size: launcher.size, contentType: launcher.contentType });
                return { blocked, contentLength: total };
            }
            // Old launcher (no endpoint) or transient error → fall back to the
            // streaming-server /proxy probe below (best effort).
            log('launcher probe unavailable, falling back to proxy', { result: launcher });
        }

        const proxyUrl = buildProxyUrl(fetchBase, url, proxyHeaders);
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

const TARGET_SAMPLE_RATE = 16000;
const FETCH_TIMEOUT_MS = 30000;
const EXTRACT_SERVER_URL = 'http://127.0.0.1:12471';

function fetchWithTimeout(url, opts, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
    const merged = { ...opts, signal: controller.signal };
    return fetch(url, merged).finally(() => clearTimeout(timer));
}

// ══════════════════════════════════════════════════════════════
//  Direct FFmpeg extraction (Option A — fast, seekable)
// ══════════════════════════════════════════════════════════════

/**
 * Check whether the audio-extract sidecar server is running.
 */
async function checkExtractServer() {
    try {
        const r = await fetchWithTimeout(`${EXTRACT_SERVER_URL}/health`, {}, 3000);
        return r.ok;
    } catch (_) {
        return false;
    }
}

/**
 * Extract a single audio chunk via the sidecar FFmpeg server.
 * Returns raw 16 kHz mono Float32 PCM — no browser-side decoding needed.
 *
 * @param {string} mediaUrl  — URL that FFmpeg can fetch directly
 * @param {number} startSec  — start offset in seconds
 * @param {number} durationSec — chunk duration in seconds
 * @param {string|null} headers — optional HTTP headers for FFmpeg (debrid auth etc.)
 */
async function extractChunkDirect(mediaUrl, startSec, durationSec, headers) {
    const params = new URLSearchParams({
        mediaURL: mediaUrl,
        start: String(startSec),
        duration: String(durationSec),
    });
    if (headers) {
        params.set('headers', headers);
    }
    const url = `${EXTRACT_SERVER_URL}/audio-extract?${params}`;

    // One retry with backoff for transient FFmpeg failures (network blip,
    // streaming server cache miss, etc.). Two attempts is enough — a third
    // would just delay the overall sync without much added success rate.
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const resp = await fetchWithTimeout(url, {}, 60000);
            if (!resp.ok) {
                const body = await resp.text().catch(function () { return ''; });
                throw new Error('Extract failed (' + resp.status + '): ' + body.substring(0, 200));
            }
            const arrayBuf = await resp.arrayBuffer();
            if (arrayBuf.byteLength < TARGET_SAMPLE_RATE * 4 * 0.5) {
                // <0.5s of audio — almost certainly an empty or corrupt extraction
                throw new Error('Extract returned ' + arrayBuf.byteLength + ' bytes (too short)');
            }
            return {
                audio: new Float32Array(arrayBuf),
                sampleRate: TARGET_SAMPLE_RATE,
                startTime: startSec,
                duration: durationSec,
            };
        } catch (err) {
            lastErr = err;
            if (attempt === 0) {
                await new Promise(function (r) { setTimeout(r, 500); });
            }
        }
    }
    throw lastErr || new Error('Extract failed');
}

/**
 * Extract multiple chunks in parallel. Per-chunk failures are tolerated:
 * the returned array contains successful results only (in original order),
 * and the batch as a whole succeeds as long as at least one chunk did.
 *
 * Each entry: { start: seconds, duration: seconds }
 */
async function extractBatch(mediaUrl, chunks, headers) {
    const settled = await Promise.allSettled(
        chunks.map(function (c) {
            return extractChunkDirect(mediaUrl, c.start, c.duration, headers);
        }),
    );
    const successes = [];
    const failures = [];
    for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === 'fulfilled') {
            successes.push(r.value);
        } else {
            failures.push({ chunk: chunks[i], reason: r.reason });
        }
    }
    if (successes.length === 0) {
        const firstReason = failures.length > 0 ? failures[0].reason : new Error('No chunks extracted');
        const msg = firstReason && firstReason.message ? firstReason.message : String(firstReason);
        throw new Error('All chunk extractions failed: ' + msg);
    }
    if (failures.length > 0) {
        // eslint-disable-next-line no-console
        console.warn('[WhisperSync] extractBatch: ' + failures.length + '/' + chunks.length + ' chunks failed —',
            failures.map(function (f) { return '@' + f.chunk.start + 's: ' + (f.reason && f.reason.message || f.reason); }).join('; '));
    }
    return successes;
}

/**
 * Resolve the mediaURL that FFmpeg can fetch from directly.
 *
 * FFmpeg runs locally and can only do plain HTTP reliably (the bundled
 * ffmpeg-static build often lacks working TLS on Windows). So we always
 * route through the streaming server on localhost:
 *   - Torrents → http://127.0.0.1:11470/<hash>/<idx>
 *   - HTTP/Debrid → http://127.0.0.1:11470/proxy/...  (streaming server proxies the HTTPS request)
 *
 * All URLs are plain HTTP to localhost — no TLS, no CORS issues for FFmpeg.
 */
async function resolveMediaUrl(streamingServerUrl, streamContent) {
    // Two separate URL contexts:
    //   ssUrl       — what FFmpeg fetches from. Always the real streaming
    //                 server on :11470 (loopback). FFmpeg ignores CORS, so we
    //                 never want to send it through the CORS proxy on :12470.
    //   browserBase — where the browser sends auxiliary requests (e.g. the
    //                 /create POST to resolve fileIdx for torrents). On a
    //                 remote origin (GitHub Pages) the streaming server has no
    //                 CORS headers, so the browser MUST go through the CORS
    //                 proxy on :12470. Same-origin / dev-server origins can
    //                 talk to :11470 directly.
    var ssUrl = forceLoopback(streamingServerUrl.replace(/\/$/, ''));
    var ssUrlObj;
    try { ssUrlObj = new URL(ssUrl); } catch (_) { /* */ }
    if (ssUrlObj && ssUrlObj.port === '12470') {
        ssUrlObj.port = '11470';
        ssUrl = ssUrlObj.origin;
    }
    var browserBase = getFetchBase(ssUrl);

    var isTorrent = streamContent && typeof streamContent.infoHash === 'string';
    var url = await buildMediaUrl(ssUrl, streamContent, browserBase);

    // For ALL streams (torrent + debrid/HTTP): FFmpeg reads directly from
    // the streaming server via /proxy/ or /<hash>/<idx>. Both support HTTP
    // range requests so FFmpeg can seek to any offset without transcoding.
    //
    // Why NOT HLS: the HLS transcoder has concurrency=1 per session. Parallel
    // extract requests (multiple chunks at once) kill each other's sessions,
    // causing SegmentCanceledError and 0-byte outputs.
    return { url: url, headers: null, isTorrent: isTorrent, hlsUrl: null };
}

// ══════════════════════════════════════════════════════════════
//  HLS-based extraction (fallback when sidecar is unavailable)
// ══════════════════════════════════════════════════════════════

/**
 * Fetch a single segment with retry. The HLS transcoder processes segments
 * sequentially, so early requests for a segment may fail with 500 if ffmpeg
 * hasn't reached that point yet. Retrying after a short delay lets the
 * transcoder catch up.
 */
async function fetchSegmentWithRetry(url, maxRetries) {
    const retries = maxRetries || 3;
    for (let attempt = 0; attempt < retries; attempt++) {
        const r = await fetchWithTimeout(url, {}, 90000);
        if (r.ok) return r.arrayBuffer();

        const body = await r.text().catch(() => '');
        const isTranscoderBehind = body.includes('Segment is canceled') || body.includes('stream ended');

        // If the transcoder just hasn't caught up, wait and retry
        if (isTranscoderBehind && attempt < retries - 1) {
            await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
            continue;
        }

        throw new Error(`Segment failed (${r.status}): ${body.substring(0, 100)}`);
    }
}

/**
 * Creates a reusable audio session backed by the streaming server's HLS
 * transcoder. Fetches the playlist and init segment once, then individual
 * segments can be requested at any offset.
 */
async function createAudioSession(streamingServerUrl, streamContent) {
    const ssUrl = forceLoopback(streamingServerUrl.replace(/\/$/, ''));
    const fetchBase = getFetchBase(ssUrl);
    // mediaURL must point at the streaming server's own address (it fetches from itself)
    const mediaUrl = await buildMediaUrl(ssUrl, streamContent, fetchBase);

    const id = 'whisper_' + Math.random().toString(36).slice(2);
    const qp = new URLSearchParams();
    qp.set('mediaURL', mediaUrl);
    // Video codec is required — the HLS transcoder needs it even for audio-only extraction
    qp.append('videoCodecs', 'h264');
    qp.append('audioCodecs', 'aac');
    qp.set('maxAudioChannels', '1');

    const masterUrl = `${fetchBase}/hlsv2/${id}/master.m3u8?${qp}`;

    // ── Master playlist ──
    // eslint-disable-next-line no-console
    console.log('[WhisperSync] HLS master:', masterUrl, '| mediaURL:', mediaUrl);
    const masterResp = await fetchWithTimeout(masterUrl, {}, 60000);
    if (!masterResp.ok) {
        const body = await masterResp.text().catch(function () { return ''; });
        // eslint-disable-next-line no-console
        console.error('[WhisperSync] Transcode failed:', masterResp.status, body.substring(0, 200));
        throw new Error(`Transcode failed (${masterResp.status}): ${body.substring(0, 100)}`);
    }
    const masterText = await masterResp.text();

    // Extract audio playlist URI
    const masterLines = masterText.split('\n').map((l) => l.trim());
    let playlistRel = null;
    for (const line of masterLines) {
        const m = line.match(/#EXT-X-MEDIA:TYPE=AUDIO.*URI="([^"]+)"/);
        if (m) { playlistRel = m[1]; break; }
    }
    if (!playlistRel) {
        playlistRel = masterLines.find((l) => l && !l.startsWith('#'));
    }
    if (!playlistRel) throw new Error('No audio playlist in HLS manifest');
    const playlistUrl = resolveHlsUrl(playlistRel, masterUrl, fetchBase);

    // ── Audio media playlist ──
    const plResp = await fetchWithTimeout(playlistUrl, {}, 90000);
    if (!plResp.ok) throw new Error(`Audio playlist failed (${plResp.status})`);
    const plText = await plResp.text();

    const { initUrl, segments } = parsePlaylist(plText, playlistUrl, fetchBase);

    // ── Pre-fetch init segment ──
    let initBuf = null;
    if (initUrl) {
        const r = await fetchWithTimeout(initUrl, {}, 60000);
        if (r.ok) initBuf = await r.arrayBuffer();
    }

    return {
        duration: segments.length > 0
            ? segments[segments.length - 1].time + segments[segments.length - 1].duration
            : 0,

        async getChunk(startSec, durationSec) {
            const endSec = startSec + durationSec;
            const selected = segments.filter(
                (s) => (s.time + s.duration) > startSec && s.time < endSec,
            );
            if (selected.length === 0) {
                throw new Error('No audio segments in requested time range');
            }

            // Fetch segments one at a time with retry — gives the transcoder
            // time to catch up if it hasn't processed this far yet.
            const segBufs = [];
            for (const seg of selected) {
                segBufs.push(await fetchSegmentWithRetry(seg.url, 4));
            }

            // Concatenate: init + segments
            const parts = initBuf ? [initBuf, ...segBufs] : segBufs;
            const totalLen = parts.reduce((s, b) => s + b.byteLength, 0);
            const combined = new Uint8Array(totalLen);
            let off = 0;
            for (const buf of parts) {
                combined.set(new Uint8Array(buf), off);
                off += buf.byteLength;
            }

            // Decode audio
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            let audioBuffer;
            try {
                audioBuffer = await ctx.decodeAudioData(combined.buffer.slice(0));
            } catch (_) {
                await ctx.close();
                throw new Error('Could not decode audio segment');
            }

            // Resample to 16 kHz mono
            const outLen = Math.ceil(audioBuffer.duration * TARGET_SAMPLE_RATE);
            const offCtx = new OfflineAudioContext(1, outLen, TARGET_SAMPLE_RATE);
            const src = offCtx.createBufferSource();
            src.buffer = audioBuffer;
            src.connect(offCtx.destination);
            src.start();
            const resampled = await offCtx.startRendering();
            await ctx.close();

            const pcm = new Float32Array(resampled.getChannelData(0));

            return {
                audio: pcm,
                sampleRate: TARGET_SAMPLE_RATE,
                startTime: selected[0].time,
                duration: audioBuffer.duration,
            };
        },

        close() { },
    };
}

// ══════════════════════════════════════════════════════════════
//  URL helpers (shared by both extraction paths)
// ══════════════════════════════════════════════════════════════

/**
 * Builds the mediaURL for the HLS transcoder.
 *
 * Mirrors the official convertStream + createTorrent logic from
 * @stremio/stremio-video so the streaming server handles it the same way.
 */
async function buildMediaUrl(ssUrl, streamContent, fetchBase) {
    if (streamContent && typeof streamContent.infoHash === 'string') {
        return await resolveTorrentUrl(ssUrl, streamContent, fetchBase);
    }

    if (streamContent && typeof streamContent.url === 'string') {
        if (streamContent.url.startsWith('magnet:')) {
            const m = streamContent.url.match(/btih:([a-fA-F0-9]{40})/i)
                || streamContent.url.match(/btih:([a-zA-Z2-7]{32})/i);
            if (m) {
                return await resolveTorrentUrl(ssUrl, {
                    infoHash: m[1].toLowerCase(),
                    fileIdx: null,
                }, fetchBase);
            }
        }
        if (streamContent.url.startsWith('http')) {
            return buildProxyUrl(ssUrl, streamContent);
        }
    }

    throw new Error('Could not determine media URL for audio extraction');
}

/**
 * Resolve torrent URL — calls /create if fileIdx is unknown to get the
 * correct file index, matching how @stremio/stremio-video does it.
 */
async function resolveTorrentUrl(ssUrl, streamContent, fetchBase) {
    const infoHash = streamContent.infoHash;
    const fileIdx = streamContent.fileIdx;

    if (fileIdx != null && isFinite(fileIdx)) {
        return `${ssUrl}/${encodeURIComponent(infoHash)}/${encodeURIComponent(fileIdx)}`;
    }

    // fileIdx unknown — ask the server to resolve it
    // Use fetchBase for the HTTP request (CORS proxy), but return ssUrl-based URL
    // because mediaURL tells the streaming server where to fetch from (itself)
    try {
        const createUrl = `${fetchBase}/${encodeURIComponent(infoHash)}/create`;
        const resp = await fetchWithTimeout(createUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                torrent: { infoHash },
                guessFileIdx: {},
            }),
        }, 30000);
        if (resp.ok) {
            const data = await resp.json();
            const idx = data.guessedFileIdx != null ? data.guessedFileIdx : 0;
            return `${ssUrl}/${encodeURIComponent(infoHash)}/${encodeURIComponent(idx)}`;
        }
    } catch (_) { /* fall through to default */ }

    return `${ssUrl}/${encodeURIComponent(infoHash)}/0`;
}

/**
 * Build proxy URL for HTTP streams, including request/response headers
 * from behaviorHints (needed for debrid services with auth tokens).
 */
function buildProxyUrl(ssUrl, streamContent) {
    const parsed = new URL(streamContent.url);
    const proxyParams = new URLSearchParams();
    proxyParams.set('d', parsed.origin);

    // Include proxy headers if the stream provides them (debrid auth, etc.)
    const proxyHeaders = streamContent.behaviorHints && streamContent.behaviorHints.proxyHeaders;
    if (proxyHeaders) {
        if (proxyHeaders.request) {
            Object.entries(proxyHeaders.request).forEach(function (entry) {
                proxyParams.append('h', entry[0] + ':' + entry[1]);
            });
        }
        if (proxyHeaders.response) {
            Object.entries(proxyHeaders.response).forEach(function (entry) {
                proxyParams.append('r', entry[0] + ':' + entry[1]);
            });
        }
    }

    return `${ssUrl}/proxy/${proxyParams.toString()}${parsed.pathname}${parsed.search}`;
}

/**
 * Force a URL to use 127.0.0.1 instead of LAN IPs (192.168.x.x, 10.x.x.x, etc.).
 * Browsers allow http://127.0.0.1 from HTTPS pages (secure context exception)
 * but block http://<LAN-IP> as Mixed Content.
 */
function forceLoopback(url) {
    try {
        var u = new URL(url);
        if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') {
            u.hostname = '127.0.0.1';
            return u.href.replace(/\/$/, '');
        }
    } catch (_) { /* */ }
    return url;
}

function getFetchBase(ssUrl) {
    try {
        const ssOrigin = new URL(ssUrl).origin;
        // Same origin — no prefix needed
        if (ssOrigin === window.location.origin) return '';
        // Localhost — use webpack dev server proxy
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            return '/streaming-server';
        }
        // Remote origin (GitHub Pages / Stremio Shell with remote webui-url):
        // Route through the CORS proxy on port 12470.
        // Always use 127.0.0.1 to avoid Mixed Content blocks from HTTPS pages.
        return 'http://127.0.0.1:12470';
    } catch (_) { /* */ }
    return '/streaming-server';
}

function resolveHlsUrl(href, baseManifestUrl, fetchBase) {
    const trimmed = href.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
            const u = new URL(trimmed);
            return fetchBase + u.pathname + u.search;
        } catch (_) {
            return trimmed;
        }
    }
    if (trimmed.startsWith('/')) return fetchBase + trimmed;
    const dir = baseManifestUrl.substring(0, baseManifestUrl.lastIndexOf('/') + 1);
    return dir + trimmed;
}

function parsePlaylist(text, playlistUrl, fetchBase) {
    const lines = text.split('\n').map((l) => l.trim());
    let initUrl = null;
    const segments = [];
    let time = 0;

    for (let i = 0; i < lines.length; i++) {
        const mapMatch = lines[i].match(/#EXT-X-MAP:URI="([^"]+)"/);
        if (mapMatch) {
            initUrl = resolveHlsUrl(mapMatch[1], playlistUrl, fetchBase);
            continue;
        }

        if (!lines[i].startsWith('#EXTINF:')) continue;
        const durMatch = lines[i].match(/#EXTINF:([\d.]+)/);
        const segDur = durMatch ? parseFloat(durMatch[1]) : 0;

        for (let j = i + 1; j < lines.length; j++) {
            if (lines[j] && !lines[j].startsWith('#')) {
                segments.push({
                    url: resolveHlsUrl(lines[j], playlistUrl, fetchBase),
                    time,
                    duration: segDur,
                });
                break;
            }
        }
        time += segDur;
    }

    return { initUrl, segments };
}

module.exports = {
    // Direct extraction (primary)
    checkExtractServer,
    extractChunkDirect,
    extractBatch,
    resolveMediaUrl,
    // HLS extraction (fallback)
    createAudioSession,
    TARGET_SAMPLE_RATE,
};
